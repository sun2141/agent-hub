#!/usr/bin/env bash
# preflight.sh — 멀티 프로바이더 하네스 기동 전 점검.
# 노트북(ThinkPad)에서 실행: bash scripts/preflight.sh   또는  npm run preflight
# 3개 CLI 설치/인증, 키링, env, DB 연결을 ✓/✗로 진단한다. (변경 없음, 읽기만)
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0; WARN=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ! $1"; WARN=$((WARN+1)); }

# .env 로드 (있으면)
if [ -f .env ]; then set -a; . ./.env; set +a; ok ".env 로드"; else warn ".env 없음 — cp .env.example .env 후 값 입력"; fi

echo "── 런타임 ─────────────────────────────────"
command -v node >/dev/null && ok "node $(node -v)" || bad "node 없음"

echo "── CLI 설치 ───────────────────────────────"
CLAUDE="${CLAUDE_CLI_PATH:-claude}"; CODEX="${CODEX_CLI_PATH:-codex}"; AGY="${AGY_CLI_PATH:-agy}"
for pair in "claude:$CLAUDE" "codex:$CODEX" "agy:$AGY"; do
  nm="${pair%%:*}"; bin="${pair#*:}"
  if command -v "$bin" >/dev/null 2>&1; then ok "$nm 설치됨 ($(command -v "$bin"))"; else bad "$nm 없음 (경로: $bin)"; fi
done

echo "── 인증 상태 ──────────────────────────────"
# Claude: CLAUDE_CONFIG_DIR
if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ -d "${CLAUDE_CONFIG_DIR}" ]; then ok "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}"; else warn "CLAUDE_CONFIG_DIR 미설정/없음 — 인증된 .claude/ 경로 지정 권장"; fi
# Codex: ~/.codex/auth.json
if [ -f "$HOME/.codex/auth.json" ]; then ok "codex auth.json 존재"; else warn "codex 미인증 — 'codex login' 필요"; fi
# Antigravity: 키링/토큰 (직접 확인 어려움 → 버전 호출로 간접)
if command -v "$AGY" >/dev/null 2>&1; then
  if "$AGY" --version >/dev/null 2>&1; then ok "agy 응답 OK"; else warn "agy 응답 실패 — 재인증/키링 확인"; fi
fi

echo "── 키링 (Antigravity 무인용) ──────────────"
if command -v secret-tool >/dev/null 2>&1; then ok "secret-tool(libsecret) 설치됨"; else warn "secret-tool 없음 — sudo apt install libsecret-tools"; fi
if [ -d "$HOME/.local/share/keyrings" ]; then ok "키링 디렉토리 존재"; else warn "키링 디렉토리 없음 (아직 미생성일 수 있음)"; fi
if grep -qs "AutomaticLogin" /etc/gdm3/custom.conf 2>/dev/null; then
  warn "GDM 자동 로그인 켜짐 → 키링 잠금 위험. bash scripts/setup-antigravity-keyring.sh empty 참고"
fi

echo "── env 변수 ───────────────────────────────"
[ "${MULTI_PROVIDER:-}" = "true" ] && ok "MULTI_PROVIDER=true (활성)" || warn "MULTI_PROVIDER≠true (현재 기존 단독 경로)"
for v in PROVIDER_PLAN PROVIDER_BUILD PROVIDER_REVIEW; do
  [ -n "${!v:-}" ] && ok "$v=${!v}" || warn "$v 미설정 (기본값 사용)"
done
[ -n "${NEON_DATABASE_URL:-}" ] && ok "NEON_DATABASE_URL 설정됨" || bad "NEON_DATABASE_URL 없음"
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] && ok "TELEGRAM_BOT_TOKEN 설정됨" || warn "TELEGRAM_BOT_TOKEN 없음"

echo "── DB 연결 + providers 테이블 ─────────────"
if [ -n "${NEON_DATABASE_URL:-}" ]; then
  node scripts/provider-status.js >/tmp/pf_providers.txt 2>&1 && { ok "providers 조회 성공"; sed 's/^/    /' /tmp/pf_providers.txt; } \
    || { warn "providers 조회 실패 (하네스 최초 기동 전이면 정상):"; sed 's/^/    /' /tmp/pf_providers.txt; }
fi

echo "── sleep 방지 (무인 운영) ─────────────────"
if command -v systemctl >/dev/null 2>&1; then
  masked=$(systemctl is-enabled sleep.target 2>/dev/null || true)
  [ "$masked" = "masked" ] && ok "sleep.target masked (suspend 차단됨)" || warn "suspend 미차단 — SETUP_THINKPAD.md의 sleep 방지 참고"
fi

echo "──────────────────────────────────────────"
echo "결과: ✓ $PASS   ! $WARN   ✗ $FAIL"
[ "$FAIL" -eq 0 ] && echo "치명적 실패 없음. (경고는 SETUP_THINKPAD.md 참고)" || echo "✗ 항목을 먼저 해결하세요."
exit 0
