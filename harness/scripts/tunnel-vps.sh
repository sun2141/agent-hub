#!/usr/bin/env bash
# scripts/tunnel-vps.sh
# 씽크패드(WSL2) → Hetzner VPS 리버스 SSH 터널.
#
# 구조:  Vercel 대시보드 → VPS nginx :80 → localhost:9091 → 리버스 터널 → 씽크패드 :3000
#
# 예전에는 맥이 이 터널을 물고 있었다. 씽크패드로 이사한 뒤 끊긴 링크가 이것이다.
#
# 사용법:
#   bash scripts/tunnel-vps.sh --check     # 어느 링크가 끊겼는지만 진단 (아무것도 안 바꿈)
#   bash scripts/tunnel-vps.sh --install   # systemd 서비스로 등록하고 상시 유지
#   bash scripts/tunnel-vps.sh             # 포그라운드로 한 번 띄워보기
#
# 설계 원칙: "설정됨 ≠ 동작함". 각 링크를 실제로 두드려 보고 결과를 말한다.
# 8/18에 같은 계열의 사고를 두 번(IPv6, git identity) 겪었으므로 여기서는
# 존재 확인이 아니라 동작 확인만 한다.

set -uo pipefail

VPS_HOST="${VPS_HOST:-91.99.58.70}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_SSH_PORT:-22}"
TUNNEL_PORT="${VPS_TUNNEL_PORT:-9091}"
LOCAL_PORT="${PORT:-3000}"
SERVICE_NAME="harness-tunnel"

ok()   { echo "  ✅ $*"; }
bad()  { echo "  ❌ $*"; }
warn() { echo "  ⚠️  $*"; }
info() { echo "  ·  $*"; }

FAILED=0

check_local_api() {
  echo "[1] 하네스 API가 로컬 ${LOCAL_PORT}에서 응답하는가"
  if curl -fsS -m 5 "http://127.0.0.1:${LOCAL_PORT}/health" >/dev/null 2>&1; then
    ok "http://127.0.0.1:${LOCAL_PORT}/health 응답"
  else
    bad "로컬 API가 응답하지 않는다"
    info "하네스가 떠 있는지 확인: sudo systemctl status harness"
    FAILED=1
  fi
}

check_ssh() {
  echo "[2] 씽크패드에서 VPS로 SSH 무암호 접속이 되는가"
  if ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
        -p "${VPS_PORT}" "${VPS_USER}@${VPS_HOST}" true 2>/dev/null; then
    ok "${VPS_USER}@${VPS_HOST} 키 인증 성공"
  else
    bad "SSH 키 인증 실패 — 터널을 띄울 수 없다"
    info "해결: ssh-keygen -t ed25519  (키가 없으면)"
    info "      ssh-copy-id -p ${VPS_PORT} ${VPS_USER}@${VPS_HOST}"
    FAILED=1
  fi
}

check_vps_listener() {
  echo "[3] VPS의 ${TUNNEL_PORT} 포트가 터널로 채워져 있는가"
  local out
  out=$(ssh -o BatchMode=yes -o ConnectTimeout=8 -p "${VPS_PORT}" "${VPS_USER}@${VPS_HOST}" \
        "curl -fsS -m 5 http://127.0.0.1:${TUNNEL_PORT}/health 2>/dev/null || echo __NO__" 2>/dev/null)
  if [ "${out:-__NO__}" != "__NO__" ] && [ -n "${out}" ]; then
    ok "VPS에서 127.0.0.1:${TUNNEL_PORT}/health 응답 — 터널 살아 있음"
  else
    bad "VPS의 ${TUNNEL_PORT}가 비어 있다 — 리버스 터널이 없다"
    info "이 스크립트를 --install로 실행하면 상시 터널이 붙는다"
    FAILED=1
  fi
}

check_public() {
  echo "[4] 바깥에서 VPS를 통해 하네스에 닿는가 (대시보드가 쓰는 경로)"
  local code
  code=$(curl -s -o /dev/null -m 10 -w "%{http_code}" "http://${VPS_HOST}/health" 2>/dev/null)
  if [ "${code}" = "200" ]; then
    ok "http://${VPS_HOST}/health → 200"
  else
    bad "http://${VPS_HOST}/health → ${code:-무응답}"
    info "3번이 통과했는데 여기서 막히면 nginx 설정 문제다."
    info "VPS에서 확인: sudo nginx -T | grep -A5 ${TUNNEL_PORT}"
    info "필요한 것: location / { proxy_pass http://127.0.0.1:${TUNNEL_PORT}; } + WebSocket 업그레이드 헤더"
    FAILED=1
  fi
}

check_ws_headers() {
  echo "[5] nginx가 WebSocket 업그레이드를 넘기는가 (실시간 로그용)"
  local hdr
  hdr=$(curl -s -i -m 8 -o - \
        -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        "http://${VPS_HOST}/ws" 2>/dev/null | head -1)
  case "${hdr}" in
    *101*) ok "101 Switching Protocols — WebSocket 통과" ;;
    *)     warn "WebSocket 업그레이드 실패 (${hdr:-무응답})"
           info "REST는 되지만 실시간 로그가 안 붙는다. nginx location /ws 에"
           info "proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection \"upgrade\"; 필요" ;;
  esac
}

do_check() {
  echo ""
  echo "터널 진단 — ${VPS_USER}@${VPS_HOST}:${TUNNEL_PORT} ← 씽크패드:${LOCAL_PORT}"
  echo ""
  check_local_api
  check_ssh
  check_vps_listener
  check_public
  check_ws_headers
  echo ""
  if [ "${FAILED}" -eq 0 ]; then
    echo "✅ 모든 링크 통과 — 대시보드가 붙어야 정상이다."
  else
    echo "❌ 위에서 ❌ 표시된 첫 번째 링크부터 고치면 된다."
  fi
  echo ""
  return "${FAILED}"
}

do_install() {
  local unit="/etc/systemd/system/${SERVICE_NAME}.service"
  local ssh_bin; ssh_bin=$(command -v ssh)
  local user; user=$(whoami)

  echo "[install] systemd 서비스 작성: ${unit}"
  sudo tee "${unit}" >/dev/null <<UNIT
[Unit]
Description=Harness reverse SSH tunnel to VPS (${TUNNEL_PORT} -> localhost:${LOCAL_PORT})
After=network-online.target harness.service
Wants=network-online.target

[Service]
User=${user}
# ExitOnForwardFailure: 포트가 이미 잡혀 있으면 조용히 붙은 척하지 말고 죽어라.
#   그래야 Restart가 다시 시도한다. 이게 없으면 "떠 있는데 안 되는" 상태가 된다.
# ServerAlive*: 집 공유기 NAT가 조용한 연결을 끊는다 — 30초마다 살아있다고 알린다.
ExecStart=${ssh_bin} -NT \\
  -o ExitOnForwardFailure=yes \\
  -o ServerAliveInterval=30 \\
  -o ServerAliveCountMax=3 \\
  -o StrictHostKeyChecking=accept-new \\
  -p ${VPS_PORT} \\
  -R ${TUNNEL_PORT}:127.0.0.1:${LOCAL_PORT} \\
  ${VPS_USER}@${VPS_HOST}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

  sudo systemctl daemon-reload
  sudo systemctl enable --now "${SERVICE_NAME}"
  echo "[install] 등록 완료. 10초 후 진단합니다..."
  sleep 10
  do_check
}

case "${1:-}" in
  --check)   do_check ;;
  --install) do_install ;;
  *)
    echo "[tunnel] 포그라운드 실행 (Ctrl+C로 종료). 상시 유지는 --install"
    exec ssh -NT \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -o StrictHostKeyChecking=accept-new \
      -p "${VPS_PORT}" \
      -R "${TUNNEL_PORT}:127.0.0.1:${LOCAL_PORT}" \
      "${VPS_USER}@${VPS_HOST}"
    ;;
esac
