#!/bin/bash
# scripts/tunnel.sh
# 하네스 대시보드 SSH 리버스 터널 시작/재시작
# 원격 서버 91.99.58.70:9090 → 127.0.0.1:3000 (harness API)
#
# 사용법:
#   bash scripts/tunnel.sh          # 터널 시작 (이미 실행 중이면 재시작)
#   npm run tunnel                   # npm 스크립트로 실행

set -euo pipefail

REMOTE_HOST="91.99.58.70"
REMOTE_USER="agent"
REMOTE_PORT="9090"
LOCAL_PORT="3000"

# 기존 터널 프로세스 종료
EXISTING_PIDS=$(pgrep -f "ssh.*${REMOTE_HOST}.*${REMOTE_PORT}" 2>/dev/null || true)
if [ -n "$EXISTING_PIDS" ]; then
  echo "[tunnel] 기존 터널 종료: PID $EXISTING_PIDS"
  kill $EXISTING_PIDS 2>/dev/null || true
  sleep 1
fi

# harness API(127.0.0.1:3000) 리스닝 여부 확인
if ! lsof -iTCP:${LOCAL_PORT} -nP 2>/dev/null | grep -q "127.0.0.1:${LOCAL_PORT}.*LISTEN"; then
  echo "[tunnel] 경고: harness API가 127.0.0.1:${LOCAL_PORT}에서 리스닝하지 않습니다."
  echo "[tunnel] 먼저 'npm start'로 harness를 실행하세요."
  echo ""
fi

echo "[tunnel] SSH 리버스 터널 시작: ${REMOTE_HOST}:${REMOTE_PORT} → 127.0.0.1:${LOCAL_PORT}"

# 백그라운드에서 SSH 터널 실행
# 127.0.0.1을 명시하여 IPv4 harness API에만 연결 (IPv6 프로세스 우회)
/usr/bin/ssh \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=no \
  -R "0.0.0.0:${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}" \
  "${REMOTE_USER}@${REMOTE_HOST}" \
  -N &

TUNNEL_PID=$!
echo "[tunnel] 터널 PID: $TUNNEL_PID"
echo "[tunnel] 접속 주소: http://${REMOTE_HOST}:${REMOTE_PORT}"
echo ""
echo "[tunnel] 터널을 중지하려면: kill $TUNNEL_PID"
