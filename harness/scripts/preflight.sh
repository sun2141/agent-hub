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

echo "── gh CLI (매니저 승인 작업의 PR 생성) ────"
if command -v gh >/dev/null 2>&1; then
  ok "gh 설치됨 ($(command -v gh))"
  if gh auth status >/dev/null 2>&1; then ok "gh 인증됨"; else
    bad "gh 미인증 — 'gh auth login' (repo 스코프). 없으면 브랜치 push까지만 되고 PR 생성이 실패한다"; fi
else
  warn "gh 없음 — 매니저 승인 작업이 PR을 열지 못한다 (브랜치는 push됨)"
fi

echo "── 매니저 루프 ────────────────────────────"
if [ "${MANAGER_LOOP:-}" = "true" ]; then
  ok "MANAGER_LOOP=true (활성)"

  SCAN_MIN="${MANAGER_SCAN_INTERVAL_MIN:-0}"
  if [ "$SCAN_MIN" -gt 0 ] 2>/dev/null; then
    ok "자동 스캔 ${SCAN_MIN}분 주기"
  else
    warn "MANAGER_SCAN_INTERVAL_MIN=0 → 자동 스캔 없음 (텔레그램 /scan 수동만)"
  fi

  if [ "${MANAGER_REQUIRE_INTENT_SIGNAL:-true}" = "false" ]; then
    warn "MANAGER_REQUIRE_INTENT_SIGNAL=false → 백로그/이슈 없이 자기 실패 이력만으로도 제안함 (잡일 루프 위험)"
  else
    ok "의도 신호 게이트 활성 (백로그/GitHub 이슈가 있어야 제안)"
  fi

  # 의도 신호가 실제로 존재하는지 — 없으면 스캔해도 제안이 0건이다.
  # 판정은 하네스와 같은 parseDirective를 쓰는 backlog-status.js에 위임한다.
  if BL=$(node scripts/backlog-status.js 2>/dev/null); then
    TOTAL_BL=$(printf '%s\n' "$BL" | awk -F'\t' '$1=="TOTAL"{print $2}')
    printf '%s\n' "$BL" | awk -F'\t' '$1!="TOTAL"' | while IFS=$'\t' read -r pid cnt repo; do
      if [ "${cnt:-0}" -gt 0 ]; then echo "  ✓ 백로그 ${pid}: ${cnt}건 (github: ${repo})"
      else echo "  · 백로그 ${pid}: 0건 (github: ${repo})"; fi
    done
    if [ "${TOTAL_BL:-0}" -gt 0 ]; then
      ok "백로그 총 ${TOTAL_BL}건 — 의도 신호 있음"
    else
      warn "백로그 항목 0건 — GitHub 이슈가 없다면 /scan 해도 제안이 나오지 않는다"
      warn "  → directives/projects/<id>.md 의 '## Backlog' 섹션에 작업을 적으세요"
    fi
  else
    warn "백로그 조회 실패 (npm install 전이면 정상)"
  fi
else
  warn "MANAGER_LOOP≠true — /scan /backlog /approve 가 '비활성화' 응답만 함"
fi

echo "── 텔레그램 도달성 (설정됨 ≠ 동작함) ─────"
# 2026-08-18: 토큰이 설정돼 있고 curl로는 되는데 Node에서만 전송이 전부 실패한 사고가 있었다.
# 원인은 Happy Eyeballs 250ms 경합 + AAAA만 있는 IPv6 경로 부재였다.
# 그래서 "값이 있나"가 아니라 "하네스와 같은 런타임(Node)으로 실제로 나가지나"를 본다.
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  warn "TELEGRAM_BOT_TOKEN 없음 — 도달성 점검 건너뜀"
else
  TG_OUT=$(node -e "
    import('./src/util/netdefaults.js').catch(()=>{}).then(async () => {
      const t = setTimeout(() => { console.log('TIMEOUT'); process.exit(0); }, 15000);
      try {
        const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getMe');
        const j = await r.json();
        console.log(j.ok ? 'OK ' + (j.result?.username || '?') : 'BAD ' + (j.description || r.status));
      } catch (e) {
        const codes = e.cause?.errors?.map(x => x.code).join(',') || e.cause?.code || e.message;
        console.log('NET ' + codes);
      }
      clearTimeout(t); process.exit(0);
    });
  " 2>&1 | tail -1)
  case "$TG_OUT" in
    OK*)      ok "텔레그램 API 도달 (@${TG_OUT#OK })" ;;
    BAD*)     bad "텔레그램 토큰 거부: ${TG_OUT#BAD }" ;;
    TIMEOUT)  bad "텔레그램 API 15초 무응답 — 네트워크 경로 확인" ;;
    NET*)     bad "텔레그램 API 연결 실패: ${TG_OUT#NET }  (ENETUNREACH/ETIMEDOUT 조합이면 IPv6 경합 문제)" ;;
    *)        warn "텔레그램 점검 결과 불명: $TG_OUT" ;;
  esac
  NETCFG=$(node -e "import('./src/util/netdefaults.js').then(m=>console.log(m.netDefaultsSummary())).catch(()=>console.log('미적용'))" 2>/dev/null | tail -1)
  ok "네트워크 기본값 — $NETCFG"
fi

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
