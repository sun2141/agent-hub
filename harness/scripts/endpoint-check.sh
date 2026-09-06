#!/usr/bin/env bash
# scripts/endpoint-check.sh
# 대시보드가 쓰는 공개 주소가 "이 하네스"에 닿는지 검증한다.
#
# 연결 방식(Tailscale Funnel / SSH 리버스 터널 / Cloudflare)과 무관하게 동작한다.
# 이 스크립트가 확인하는 건 경로가 아니라 **신원**이다.
#
# 그렇게 만든 이유: 예전 tunnel-vps.sh는 공개 주소가 200을 돌려주면 ✅로 봤는데,
# 터널이 끊긴 상태에서도 VPS에 남아 있던 다른 무언가가 200을 돌려줬다.
# "응답함"과 "내 하네스가 응답함"은 다르다. /health의 pid로 그 둘을 가른다.
#
# 사용법:
#   bash scripts/endpoint-check.sh https://thinkpad.example-tailnet.ts.net
#   PUBLIC_URL=https://... bash scripts/endpoint-check.sh

set -uo pipefail

PUBLIC_URL="${1:-${PUBLIC_URL:-}}"
LOCAL_PORT="${PORT:-3000}"

ok()   { echo "  ✅ $*"; }
bad()  { echo "  ❌ $*"; }
warn() { echo "  ⚠️  $*"; }
info() { echo "  ·  $*"; }

if [ -z "${PUBLIC_URL}" ]; then
  echo "사용법: bash scripts/endpoint-check.sh <공개주소>"
  echo "  예: bash scripts/endpoint-check.sh https://sunho-thinkpad.tailXXXX.ts.net"
  exit 2
fi
PUBLIC_URL="${PUBLIC_URL%/}"

FAILED=0
echo ""
echo "엔드포인트 검증 — ${PUBLIC_URL}  ←→  로컬 :${LOCAL_PORT}"
echo ""

# ── [1] 로컬 하네스 ─────────────────────────────────────────
echo "[1] 하네스가 로컬 ${LOCAL_PORT}에서 응답하는가"
LOCAL_JSON=$(curl -fsS -m 5 "http://127.0.0.1:${LOCAL_PORT}/health" 2>/dev/null)
LOCAL_PID=$(printf '%s' "${LOCAL_JSON}" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
if [ -n "${LOCAL_PID}" ]; then
  ok "pid ${LOCAL_PID}"
else
  bad "로컬 하네스가 응답하지 않는다"
  info "확인: sudo systemctl status harness"
  echo ""; echo "❌ 여기가 막히면 나머지는 볼 필요가 없다."; echo ""
  exit 1
fi

# ── [2] 공개 주소 도달 ──────────────────────────────────────
echo "[2] 공개 주소가 열려 있는가"
CODE=$(curl -s -o /tmp/.harness_public_health -m 15 -w "%{http_code}" "${PUBLIC_URL}/health" 2>/dev/null)
if [ "${CODE}" = "200" ]; then
  ok "${PUBLIC_URL}/health → 200"
else
  bad "${PUBLIC_URL}/health → ${CODE:-무응답}"
  info "터널/Funnel이 떠 있는지 확인하라. Tailscale이면: tailscale funnel status"
  FAILED=1
fi

# ── [3] 신원 대조 ───────────────────────────────────────────
echo "[3] 그 주소가 닿는 하네스가 \"이 하네스\"인가"
REMOTE_PID=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' /tmp/.harness_public_health 2>/dev/null)
if [ "${CODE}" != "200" ]; then
  info "2번이 막혀 확인 불가"
elif [ -z "${REMOTE_PID}" ]; then
  bad "200이지만 하네스 형식의 응답이 아니다 (pid 없음)"
  info "다른 서비스가 그 주소를 잡고 있다"
  FAILED=1
elif [ "${REMOTE_PID}" = "${LOCAL_PID}" ]; then
  ok "pid ${REMOTE_PID} 일치 — 같은 프로세스다"
else
  bad "다른 하네스가 응답한다 (공개 pid=${REMOTE_PID}, 로컬 pid=${LOCAL_PID})"
  info "두 인스턴스가 같은 Neon DB와 같은 텔레그램 토큰을 쓰면"
  info "작업이 중복 실행되고 텔레그램은 409로 충돌한다. 하나를 정리할 것."
  FAILED=1
fi

# ── [4] 인증이 살아 있는가 ──────────────────────────────────
echo "[4] 인증 경로가 통하는가"
AUTH_CODE=$(curl -s -o /dev/null -m 15 -w "%{http_code}" "${PUBLIC_URL}/auth/status" 2>/dev/null)
case "${AUTH_CODE}" in
  200|401) ok "/auth/status → ${AUTH_CODE} (라우팅 정상)" ;;
  *)       warn "/auth/status → ${AUTH_CODE:-무응답} — 대시보드 로그인이 안 될 수 있다"; FAILED=1 ;;
esac

# ── [5] 목표 API ────────────────────────────────────────────
echo "[5] 목표 계층 API가 올라와 있는가"
GOAL_CODE=$(curl -s -o /dev/null -m 15 -w "%{http_code}" "${PUBLIC_URL}/api/goals" 2>/dev/null)
case "${GOAL_CODE}" in
  200|401|403) ok "/api/goals → ${GOAL_CODE} (라우트 존재)" ;;
  404)         bad "/api/goals → 404 — 목표 계층이 없는 예전 코드가 돌고 있다"
               info "씽크패드에서: cd ~/agent-hub && git pull && sudo systemctl restart harness"
               FAILED=1 ;;
  *)           warn "/api/goals → ${GOAL_CODE:-무응답}"; FAILED=1 ;;
esac

# ── [6] WebSocket ───────────────────────────────────────────
echo "[6] WebSocket 업그레이드가 통과하는가 (실시간 로그용)"
WS_URL="${PUBLIC_URL}/ws"
HDR=$(curl -s -i -m 15 -o - \
      -H "Connection: Upgrade" -H "Upgrade: websocket" \
      -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
      "${WS_URL}" 2>/dev/null | head -1)
case "${HDR}" in
  *101*) ok "101 Switching Protocols" ;;
  *)     warn "업그레이드 실패 (${HDR:-무응답}) — REST는 되지만 실시간 로그가 안 붙는다" ;;
esac

echo ""
if [ "${FAILED}" -eq 0 ]; then
  echo "✅ 통과. 이 주소를 dashboard/vercel.json의 rewrite 대상에 넣으면 된다:"
  echo "   ${PUBLIC_URL}"
else
  echo "❌ 위에서 ❌ 표시된 첫 항목부터 고칠 것."
fi
echo ""
exit "${FAILED}"
