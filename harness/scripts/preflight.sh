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
# 의도된 미사용을 알리는 줄. ✓/✗/! 어디에도 안 잡힌다 — 쓰지 않는 것이 "통과"도 "실패"도 아니기 때문이다.
skip() { echo "  · $1"; }

# .env 로드 (있으면)
if [ -f .env ]; then set -a; . ./.env; set +a; ok ".env 로드"; else warn ".env 없음 — cp .env.example .env 후 값 입력"; fi

echo "── 런타임 ─────────────────────────────────"
command -v node >/dev/null && ok "node $(node -v)" || bad "node 없음"

echo "── CLI 설치 ───────────────────────────────"
CLAUDE="${CLAUDE_CLI_PATH:-claude}"; CODEX="${CODEX_CLI_PATH:-codex}"; AGY="${AGY_CLI_PATH:-agy}"

# 어떤 프로바이더를 실제로 쓰는지는 DB의 enabled가 정한다 — 하네스가 그걸 보고 고른다.
# 설치 여부만 보면 의도적으로 끈 프로바이더 탓에 preflight가 늘 ✗로 끝난다.
# ✗가 상수가 되면 사람은 그걸 무시하게 되고, 진짜 ✗가 떠도 똑같이 무시한다 —
# 8/18의 "20개 항목 전부 ✓인데 커밋 불가"와 정반대로 같은 종류의 고장이다.
# DB가 늦거나 안 오면 preflight 전체가 첫 줄에서 멎는다 — 10초로 끊고 모른다고 답한다.
ENABLED_PROVIDERS=$(node -e "
  const give = v => { console.log(v); process.exit(0); };
  setTimeout(() => give('__UNKNOWN__'), 10000).unref?.();
  import('./src/db/db.js')
    .then(m => m.providerQueries.listEnabled())
    .then(rows => give(rows.map(r => r.provider).join(' ')))
    .catch(() => give('__UNKNOWN__'));
" 2>/dev/null | tail -1)
[ -n "$ENABLED_PROVIDERS" ] || ENABLED_PROVIDERS="__UNKNOWN__"

# DB를 못 읽었으면(npm install 전/DB 미도달) env 핀으로 판정한다.
# 모를 땐 "필요하다"로 본다 — 쓰는 걸 안 쓴다고 보고하는 오판이 반대보다 비싸다.
provider_in_use() {
  case " $ENABLED_PROVIDERS " in
    *" __UNKNOWN__ "*)
      case " ${PROVIDER_PLAN:-} ${PROVIDER_BUILD:-} ${PROVIDER_REVIEW:-} " in
        *" $1 "*) return 0 ;; *) return 1 ;;
      esac ;;
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

for triple in "claude:claude:$CLAUDE" "codex:codex:$CODEX" "antigravity:agy:$AGY"; do
  adapter="${triple%%:*}"; rest="${triple#*:}"; nm="${rest%%:*}"; bin="${rest#*:}"
  if command -v "$bin" >/dev/null 2>&1; then
    if provider_in_use "$adapter"; then ok "$nm 설치됨 ($(command -v "$bin"))"
    else skip "$nm 설치됨 — 다만 $adapter 는 비활성이라 쓰이지 않는다"; fi
  elif provider_in_use "$adapter"; then
    bad "$nm 없음 (경로: $bin) — $adapter 가 활성이라 실행 중 실패한다"
  else
    skip "$nm 미설치 — $adapter 비활성(의도된 미사용). 쓰려면 설치 후 npm run providers:toggle"
  fi
done

echo "── 인증 상태 ──────────────────────────────"
# Claude: CLAUDE_CONFIG_DIR
if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ -d "${CLAUDE_CONFIG_DIR}" ]; then ok "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}"; else warn "CLAUDE_CONFIG_DIR 미설정/없음 — 인증된 .claude/ 경로 지정 권장"; fi
# Codex: ~/.codex/auth.json
if [ -f "$HOME/.codex/auth.json" ]; then ok "codex auth.json 존재"; else warn "codex 미인증 — 'codex login' 필요"; fi
# Antigravity: 키링/토큰 (직접 확인 어려움 → 버전 호출로 간접)
if provider_in_use antigravity && command -v "$AGY" >/dev/null 2>&1; then
  if "$AGY" --version >/dev/null 2>&1; then ok "agy 응답 OK"; else warn "agy 응답 실패 — 재인증/키링 확인"; fi
fi

echo "── 키링 (Antigravity 무인용) ──────────────"
if ! provider_in_use antigravity; then
  skip "antigravity 미사용 — 키링 점검 생략"
elif command -v secret-tool >/dev/null 2>&1; then ok "secret-tool(libsecret) 설치됨"; else warn "secret-tool 없음 — sudo apt install libsecret-tools"; fi
if provider_in_use antigravity; then
  if [ -d "$HOME/.local/share/keyrings" ]; then ok "키링 디렉토리 존재"; else warn "키링 디렉토리 없음 (아직 미생성일 수 있음)"; fi
  if grep -qs "AutomaticLogin" /etc/gdm3/custom.conf 2>/dev/null; then
    warn "GDM 자동 로그인 켜짐 → 키링 잠금 위험. bash scripts/setup-antigravity-keyring.sh empty 참고"
  fi
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

echo "── git 커밋 실동작 (설정됨 ≠ 동작함) ──────"
# 8/18: preflight 20개 항목이 전부 ✓ 인데 커밋은 불가능한 상태였다.
# git config 값의 "존재"를 확인하는 것으로는 못 잡는다 — 임시 저장소에서 진짜로 커밋해 본다.
# 하네스가 실제로 쓰는 신원(AGENT_GIT_NAME/EMAIL 주입)으로 시도해야 의미가 있다.
GIT_PROBE=$(mktemp -d 2>/dev/null || mktemp -d -t gitprobe)
if git -C "$GIT_PROBE" init -q 2>/dev/null; then
  : > "$GIT_PROBE/probe.txt"
  git -C "$GIT_PROBE" add probe.txt >/dev/null 2>&1
  PROBE_NAME="${AGENT_GIT_NAME:-Agent Harness}"
  PROBE_EMAIL="${AGENT_GIT_EMAIL:-agent-harness@localhost}"
  if git -C "$GIT_PROBE" -c "user.name=$PROBE_NAME" -c "user.email=$PROBE_EMAIL" \
       commit -q -m "preflight probe" >/tmp/pf_gitcommit.txt 2>&1; then
    ok "임시 저장소에 실제 커밋 성공 ($PROBE_NAME <$PROBE_EMAIL>)"
  else
    bad "커밋이 실제로는 불가능하다:"
    sed 's/^/    /' /tmp/pf_gitcommit.txt
  fi
  # 전역 설정도 함께 본다 — 사람이 직접 커밋할 때 필요하다.
  GN=$(git config --global user.name 2>/dev/null || true)
  GE=$(git config --global user.email 2>/dev/null || true)
  if [ -n "$GN" ] && [ -n "$GE" ]; then
    ok "전역 git identity: $GN <$GE>"
  else
    warn "전역 git identity 없음 — 하네스는 주입해서 쓰므로 동작하지만, 수동 커밋 시 실패한다"
  fi
  rm -rf "$GIT_PROBE" 2>/dev/null || true
else
  warn "임시 저장소 생성 실패 — 커밋 실동작 검사 건너뜀"
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
