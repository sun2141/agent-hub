#!/bin/bash
# 백그라운드에서 자기 자신을 git pull 후 재시작
# /api/deploy 웹훅에서 detached 프로세스로 호출됨

set -e

HARNESS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HARNESS_DIR"

echo "[Deploy] $(date) — 배포 시작"
echo "[Deploy] 디렉토리: $HARNESS_DIR"

# 잠시 대기 (API 응답이 먼저 나가도록)
sleep 2

# git pull
echo "[Deploy] git pull..."
git pull origin main

# npm install (의존성 변경 대응)
echo "[Deploy] npm install..."
npm install --production

# PID 파일로 현재 하네스 종료
WATCHDOG_PID_FILE="$HARNESS_DIR/../watchdog.pid"
HARNESS_PID_FILE="$HARNESS_DIR/../harness.pid"

if [ -f "$HARNESS_PID_FILE" ]; then
  PID=$(cat "$HARNESS_PID_FILE")
  echo "[Deploy] 하네스 종료 (PID: $PID)..."
  kill "$PID" 2>/dev/null || true
  sleep 3
fi

# watchdog가 있으면 자동 재시작됨, 없으면 직접 실행
if [ -f "$WATCHDOG_PID_FILE" ]; then
  WPID=$(cat "$WATCHDOG_PID_FILE")
  if kill -0 "$WPID" 2>/dev/null; then
    echo "[Deploy] Watchdog 감지 — 자동 재시작 대기"
  else
    echo "[Deploy] Watchdog 없음 — 하네스 직접 시작"
    node "$HARNESS_DIR/src/index.js" &
  fi
else
  echo "[Deploy] Watchdog 없음 — 하네스 직접 시작"
  node "$HARNESS_DIR/src/index.js" &
fi

echo "[Deploy] $(date) — 배포 완료"
