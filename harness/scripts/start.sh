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
NODE_BIN="/Users/sun/.nvm/versions/node/v22.14.0/bin/node"

# node 바이너리 확인
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(which node 2>/dev/null || echo "")"
  if [ -z "$NODE_BIN" ]; then
    echo "[start] ❌ node 바이너리를 찾을 수 없습니다" >&2
    exit 1
  fi
fi

CMD="${1:-start}"

case "$CMD" in
  status)
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

    # nohup으로 백그라운드 기동
    nohup "$NODE_BIN" "$HARNESS_ROOT/src/index.js" \
      > "$RESTART_LOG" 2>&1 &
    NEW_PID=$!

    # PID 저장 (index.js가 자체적으로도 저장하지만 여기서도 저장)
    echo "$NEW_PID" > "$PID_FILE"

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
