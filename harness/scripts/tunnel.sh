#!/bin/bash
# scripts/tunnel.sh
# Cloudflare Tunnel을 통해 harness API를 HTTPS로 외부 노출
# Vercel 대시보드(HTTPS) ↔ harness API(localhost:3000) 연결
#
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  최초 1회 설정:
#    1. brew install cloudflare/cloudflare/cloudflared
#    2. cloudflared tunnel login          ← 브라우저에서 Cloudflare 로그인
#    3. cloudflared tunnel create harness-api
#    4. 출력된 tunnel ID를 TUNNEL_NAME 변수 옆에 적어두기
#    5. cloudflared tunnel route dns harness-api <서브도메인>  ← 도메인 있을 때만
#
#  설정 없이 빠른 시작 (URL이 매 재시작마다 바뀜):
#    bash scripts/tunnel.sh --quick
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

LOCAL_PORT="3000"
TUNNEL_NAME="harness-api"   # cloudflared tunnel create 로 만든 터널 이름

QUICK_MODE=false
if [[ "${1:-}" == "--quick" ]]; then
  QUICK_MODE=true
fi

# ── cloudflared 설치 확인 ─────────────────────────────────────
if ! command -v cloudflared &> /dev/null; then
  echo ""
  echo "[tunnel] ❌ cloudflared가 설치되어 있지 않습니다."
  echo ""
  echo "  설치: brew install cloudflare/cloudflare/cloudflared"
  echo ""
  exit 1
fi

# ── harness API 실행 여부 확인 ────────────────────────────────
if ! lsof -iTCP:${LOCAL_PORT} -nP 2>/dev/null | grep -q "LISTEN"; then
  echo "[tunnel] ⚠️  harness API가 포트 ${LOCAL_PORT}에서 실행되지 않습니다."
  echo "[tunnel]    먼저 'npm start'로 harness를 시작하세요."
  echo ""
fi

# 기존 cloudflared 프로세스 종료
EXISTING=$(pgrep -f "cloudflared tunnel" 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo "[tunnel] 기존 cloudflared 프로세스 종료: PID $EXISTING"
  kill $EXISTING 2>/dev/null || true
  sleep 1
fi

# ── 터널 시작 ─────────────────────────────────────────────────
if [ "$QUICK_MODE" = true ]; then
  echo ""
  echo "[tunnel] 빠른 터널 시작 (URL 고정 안됨)"
  echo "[tunnel] ※ URL이 출력되면 Vercel 환경변수 VITE_API_BASE_URL에 설정하세요"
  echo ""
  cloudflared tunnel --url http://localhost:${LOCAL_PORT}
else
  # 이름 있는 터널 확인
  if ! cloudflared tunnel list 2>/dev/null | grep -q "${TUNNEL_NAME}"; then
    echo ""
    echo "[tunnel] ❌ '${TUNNEL_NAME}' 터널이 없습니다."
    echo ""
    echo "  최초 설정:"
    echo "    cloudflared tunnel login"
    echo "    cloudflared tunnel create ${TUNNEL_NAME}"
    echo ""
    echo "  또는 빠른 시작 (URL 매번 바뀜):"
    echo "    bash scripts/tunnel.sh --quick"
    echo "    npm run tunnel:quick"
    echo ""
    exit 1
  fi

  # config.yml 생성 (없으면)
  CF_DIR="$HOME/.cloudflared"
  CONFIG_FILE="${CF_DIR}/config.yml"
  if [ ! -f "$CONFIG_FILE" ]; then
    TUNNEL_ID=$(cloudflared tunnel list --output json 2>/dev/null \
      | python3 -c "import sys,json; ts=[t for t in json.load(sys.stdin) if t['name']=='${TUNNEL_NAME}']; print(ts[0]['id'] if ts else '')" 2>/dev/null || echo "")
    if [ -n "$TUNNEL_ID" ]; then
      mkdir -p "$CF_DIR"
      cat > "$CONFIG_FILE" <<CFEOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CF_DIR}/${TUNNEL_ID}.json

ingress:
  - service: http://localhost:${LOCAL_PORT}
CFEOF
      echo "[tunnel] config.yml 생성 완료: ${CONFIG_FILE}"
    fi
  fi

  echo ""
  echo "[tunnel] Cloudflare Tunnel 시작: ${TUNNEL_NAME}"
  echo "[tunnel] https://<tunnel-id>.cfargotunnel.com → localhost:${LOCAL_PORT}"
  echo ""
  cloudflared tunnel run "${TUNNEL_NAME}"
fi
