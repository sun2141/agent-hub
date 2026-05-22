#!/usr/bin/env bash
# harness/scripts/deploy_detached.sh
# harness self-kill 방지용 분리 배포 스크립트
#
# 이 스크립트는 harness 프로세스와 완전히 분리된 자식 프로세스로 실행됨.
# harness가 종료된 후에도 계속 실행되어 재시작을 처리함.
#
# 실행 순서:
#   1. git add/commit (변경사항이 있을 때만)
#   2. git push origin main
#   3. 일시 대기 (harness 정상 종료 대기)
#   4. harness 재시작 (pm2 또는 node 직접 실행)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS_ROOT/.." && pwd)"
LOG_PREFIX="[deploy_detached]"

echo "$LOG_PREFIX 시작: $(date)"
echo "$LOG_PREFIX HARNESS_ROOT=$HARNESS_ROOT"
echo "$LOG_PREFIX REPO_ROOT=$REPO_ROOT"

# .env 로드 (harness root에 있는 .env)
if [ -f "$HARNESS_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$HARNESS_ROOT/.env"
  set +a
  echo "$LOG_PREFIX .env 로드 완료"
fi

# ── 1. git add & commit ─────────────────────────────────────
cd "$REPO_ROOT"

GIT_STATUS=$(git status --porcelain 2>/dev/null || echo "")
if [ -n "$GIT_STATUS" ]; then
  echo "$LOG_PREFIX git add/commit 진행..."
  git add -A || true
  git commit -m "chore: auto-deploy by telegram /deploy command ($(date '+%Y-%m-%d %H:%M:%S'))" || true
  echo "$LOG_PREFIX commit 완료"
else
  echo "$LOG_PREFIX 커밋할 변경사항 없음 — 건너뜀"
fi

# ── 2. git push ──────────────────────────────────────────────
echo "$LOG_PREFIX git push origin main..."
if git push origin main 2>&1; then
  echo "$LOG_PREFIX push 완료"
else
  echo "$LOG_PREFIX push 실패 — 재시작은 계속 진행"
fi

# ── 3. harness PID 확인 및 대기 ─────────────────────────────
HARNESS_PID_FILE="$REPO_ROOT/harness.pid"
HARNESS_PID=""
if [ -f "$HARNESS_PID_FILE" ]; then
  HARNESS_PID=$(cat "$HARNESS_PID_FILE" 2>/dev/null || echo "")
  echo "$LOG_PREFIX 현재 harness PID: $HARNESS_PID"
fi

# ── 4. harness 재시작 ────────────────────────────────────────
NODE_BIN="${NODE_BIN:-}"

# .env의 NODE_BIN이 우선, 없으면 PATH의 node로 폴백
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || echo "node")"
fi
if [ -x "$NODE_BIN" ]; then
  NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
  export PATH="$NODE_DIR:$PATH"
fi

# PM2가 있으면 pm2 reload, 없으면 node 직접 재시작
PM2_BIN="$(which pm2 2>/dev/null || echo "")"
NVM_PM2="/Users/sun/.nvm/versions/node/v22.14.0/bin/pm2"
if [ -x "$NVM_PM2" ]; then
  PM2_BIN="$NVM_PM2"
fi

if [ -n "$PM2_BIN" ]; then
  APP_NAME="${PM2_APP_NAME:-harness}"
  echo "$LOG_PREFIX PM2로 재시작: $APP_NAME"

  # 기존 harness 종료 (종료될 시간 대기)
  if [ -n "$HARNESS_PID" ] && kill -0 "$HARNESS_PID" 2>/dev/null; then
    echo "$LOG_PREFIX 기존 harness (PID $HARNESS_PID) SIGTERM 전송..."
    kill -TERM "$HARNESS_PID" 2>/dev/null || true
    sleep 3
  fi

  if "$PM2_BIN" list 2>/dev/null | grep -q "$APP_NAME"; then
    "$PM2_BIN" reload "$APP_NAME" --update-env
  else
    echo "$LOG_PREFIX pm2 앱 '$APP_NAME' 없음 — pm2 start로 기동"
    "$PM2_BIN" start "$HARNESS_ROOT/package.json" --name "$APP_NAME" --interpreter "$NODE_BIN"
  fi
else
  # PM2 없음 — node 직접 재시작
  echo "$LOG_PREFIX PM2 없음 — node 직접 재시작"

  # 기존 harness 종료
  if [ -n "$HARNESS_PID" ] && kill -0 "$HARNESS_PID" 2>/dev/null; then
    echo "$LOG_PREFIX 기존 harness (PID $HARNESS_PID) SIGTERM 전송..."
    kill -TERM "$HARNESS_PID" 2>/dev/null || true
    sleep 5
    # 아직 살아있으면 SIGKILL
    if kill -0 "$HARNESS_PID" 2>/dev/null; then
      echo "$LOG_PREFIX SIGKILL 전송..."
      kill -9 "$HARNESS_PID" 2>/dev/null || true
      sleep 2
    fi
  fi

  # pid 파일 정리 (stale lock 방지)
  rm -f "$HARNESS_PID_FILE"

  echo "$LOG_PREFIX node 재시작: $NODE_BIN $HARNESS_ROOT/src/index.js"
  # 새 로그 파일로 stdout/stderr 리디렉트하여 백그라운드 재시작
  RESTART_LOG="$HARNESS_ROOT/logs/harness-restart-$(date +%Y%m%d-%H%M%S).log"
  nohup "$NODE_BIN" "$HARNESS_ROOT/src/index.js" \
    > "$RESTART_LOG" 2>&1 &
  NEW_PID=$!
  echo "$LOG_PREFIX 새 harness PID: $NEW_PID"
  echo "$LOG_PREFIX 재시작 로그: $RESTART_LOG"
fi

echo "$LOG_PREFIX 완료: $(date)"
