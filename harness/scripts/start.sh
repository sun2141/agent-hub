#!/usr/bin/env bash
# harness/scripts/start.sh
# harness를 nohup + 백그라운드로 기동하는 스크립트
#
# 사용법:
#   bash scripts/start.sh         # 하네스 백그라운드 기동
#   bash scripts/start.sh status  # 실행 여부 확인
#   bash scripts/start.sh stop    # 하네스 종료

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS_ROOT/.." && pwd)"
PID_FILE="$REPO_ROOT/harness.pid"
LOG_DIR="$HARNESS_ROOT/logs"

# .env에서 NODE_BIN 등 환경변수 로드
if [ -f "$HARNESS_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$HARNESS_ROOT/.env"
  set +a
fi

# NODE_BIN 우선순위: 1) .env의 NODE_BIN  2) PATH의 node  3) 에러
if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || echo "")"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[start] ❌ node 바이너리를 찾을 수 없습니다 (.env의 NODE_BIN 또는 PATH 확인)" >&2
  exit 1
fi

# Claude/Codex 같은 CLI shim은 `#!/usr/bin/env node`를 사용한다.
# 하네스가 Node 22로 떠도 자식 프로세스가 PATH의 오래된 node를 잡으면 실행이 깨진다.
NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
export PATH="$NODE_DIR:$PATH"

PM2_BIN="$(command -v pm2 2>/dev/null || true)"
PM2_APP_NAME="${PM2_APP_NAME:-harness}"

pm2_has_app() {
  [ -n "$PM2_BIN" ] && "$PM2_BIN" describe "$PM2_APP_NAME" >/dev/null 2>&1
}

CMD="${1:-start}"

case "$CMD" in
  status)
    if pm2_has_app; then
      "$PM2_BIN" status "$PM2_APP_NAME"
      exit 0
    fi
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        echo "[start] 실행 중 (PID: $PID)"
        exit 0
      else
        echo "[start] pid 파일 존재하나 프로세스 없음 (스테일)"
        exit 1
      fi
    else
      echo "[start] 실행 안 됨"
      exit 1
    fi
    ;;

  stop)
    if pm2_has_app; then
      "$PM2_BIN" stop "$PM2_APP_NAME"
      rm -f "$PID_FILE"
      exit 0
    fi
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        echo "[start] harness 종료 중 (PID: $PID)..."
        kill -TERM "$PID" 2>/dev/null || true
        sleep 3
        if kill -0 "$PID" 2>/dev/null; then
          kill -9 "$PID" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
        echo "[start] 종료 완료"
      else
        echo "[start] 실행 중인 harness 없음"
        rm -f "$PID_FILE"
      fi
    else
      echo "[start] 실행 중인 harness 없음"
    fi
    ;;

  start)
    if pm2_has_app; then
      "$PM2_BIN" restart "$PM2_APP_NAME" --update-env
      exit $?
    fi

    # 이미 실행 중인지 확인
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        echo "[start] 이미 실행 중입니다 (PID: $PID)"
        echo "[start] 재시작하려면: bash scripts/start.sh stop && bash scripts/start.sh"
        exit 0
      else
        echo "[start] 스테일 pid 파일 제거 후 시작..."
        rm -f "$PID_FILE"
      fi
    fi

    # 로그 디렉토리 생성
    mkdir -p "$LOG_DIR"

    RESTART_LOG="$LOG_DIR/harness-$(date +%Y%m%d-%H%M%S).log"
    echo "[start] harness 시작: $NODE_BIN $HARNESS_ROOT/src/index.js"
    echo "[start] 로그: $RESTART_LOG"

    # 비대화형 실행 환경(Codex 등)에서는 단순 nohup 백그라운드 프로세스가
    # 부모 프로세스 종료 시 함께 정리될 수 있으므로 새 세션으로 분리한다.
    if command -v python3 >/dev/null 2>&1; then
      NEW_PID=$(
        NODE_BIN="$NODE_BIN" HARNESS_ROOT="$HARNESS_ROOT" RESTART_LOG="$RESTART_LOG" python3 - <<'PY'
import os
import subprocess

node_bin = os.environ["NODE_BIN"]
harness_root = os.environ["HARNESS_ROOT"]
restart_log = os.environ["RESTART_LOG"]
env = os.environ.copy()
node_dir = os.path.dirname(os.path.realpath(node_bin))
env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")

log = open(restart_log, "ab", buffering=0)
proc = subprocess.Popen(
    [node_bin, os.path.join(harness_root, "src/index.js")],
    cwd=harness_root,
    env=env,
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    close_fds=True,
)
print(proc.pid)
PY
      )
    else
      nohup "$NODE_BIN" "$HARNESS_ROOT/src/index.js" \
        > "$RESTART_LOG" 2>&1 &
      NEW_PID=$!
    fi

    sleep 2

    # 기동 확인
    if kill -0 "$NEW_PID" 2>/dev/null; then
      echo "[start] ✅ harness 기동 완료 (PID: $NEW_PID)"
      echo "[start] 로그 확인: tail -f $RESTART_LOG"
    else
      echo "[start] ❌ harness 기동 실패. 로그 확인: $RESTART_LOG" >&2
      tail -20 "$RESTART_LOG" >&2
      exit 1
    fi
    ;;

  *)
    echo "사용법: bash scripts/start.sh [start|stop|status]"
    exit 1
    ;;
esac
