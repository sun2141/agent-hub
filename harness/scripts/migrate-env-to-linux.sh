#!/usr/bin/env bash
# scripts/migrate-env-to-linux.sh
# 맥에서 쓰던 harness/.env 를 ThinkPad(Linux)용으로 변환한다.
#
# 하는 일:
#   1. 머신 종속 경로(PROJECTS_ROOT / CLAUDE_CLI_PATH / CLAUDE_CONFIG_DIR / NODE_BIN)를
#      이 머신에서 자동 감지한 값으로 교체
#   2. 멀티 프로바이더 / 매니저 루프 키가 없으면 권장 기본값으로 추가 (있으면 건드리지 않음)
#   3. 비밀값(DB URL, 토큰, API 키)은 그대로 보존하고 화면에 출력하지 않음
#
# 사용법:
#   # 1) 맥에서 .env를 안전하게 옮긴 뒤 (USB / scp / 직접 타이핑)
#   scp mac:/Users/sun/agent-hub/harness/.env ~/env-from-mac
#
#   # 2) 씽크패드에서
#   cd ~/agent-hub/harness
#   bash scripts/migrate-env-to-linux.sh ~/env-from-mac
#
#   # 3) 검증
#   npm run preflight
#
# 안전장치: 기존 .env가 있으면 .env.bak.<timestamp>로 백업한 뒤 덮어쓴다.

set -uo pipefail
cd "$(dirname "$0")/.."

SRC="${1:-}"
DEST=".env"

if [ -z "$SRC" ]; then
  echo "사용법: bash scripts/migrate-env-to-linux.sh <맥에서-가져온-.env-경로>" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "✗ 원본 .env를 찾을 수 없습니다: $SRC" >&2
  exit 1
fi

echo "── 경로 자동 감지 ─────────────────────────"

detect() {  # detect <명령이름> → 절대경로 또는 빈 문자열
  command -v "$1" 2>/dev/null || true
}

NODE_PATH_DETECTED="$(detect node)"
CLAUDE_PATH_DETECTED="$(detect claude)"
CODEX_PATH_DETECTED="$(detect codex)"
AGY_PATH_DETECTED="$(detect agy)"

# PROJECTS_ROOT: 프로젝트 저장소들을 둔 부모 디렉토리. 홈 아래 관례를 따른다.
PROJECTS_ROOT_NEW="${PROJECTS_ROOT_OVERRIDE:-$HOME}"
CLAUDE_CONFIG_NEW="${CLAUDE_CONFIG_OVERRIDE:-$HOME/.claude-harness}"

for pair in "node:$NODE_PATH_DETECTED" "claude:$CLAUDE_PATH_DETECTED" \
            "codex:$CODEX_PATH_DETECTED" "agy:$AGY_PATH_DETECTED"; do
  nm="${pair%%:*}"; val="${pair#*:}"
  if [ -n "$val" ]; then echo "  ✓ $nm → $val"; else echo "  ✗ $nm 없음 (설치 후 다시 실행하거나 .env를 직접 수정)"; fi
done
echo "  · PROJECTS_ROOT  → $PROJECTS_ROOT_NEW   (바꾸려면 PROJECTS_ROOT_OVERRIDE=... 로 재실행)"
echo "  · CLAUDE_CONFIG_DIR → $CLAUDE_CONFIG_NEW"
echo

# 기존 .env 백업
if [ -f "$DEST" ]; then
  BAK="$DEST.bak.$(date +%Y%m%d%H%M%S)"
  cp "$DEST" "$BAK"
  echo "기존 .env 백업: $BAK"
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cp "$SRC" "$TMP"

# ── 키 값 교체 (키가 있을 때만 교체, 없으면 건드리지 않음) ────────
set_key() {  # set_key <KEY> <VALUE>
  local key="$1" val="$2"
  [ -z "$val" ] && return 0
  if grep -qE "^${key}=" "$TMP"; then
    # | 를 구분자로 써서 경로의 / 를 이스케이프하지 않아도 되게 한다
    sed -i "s|^${key}=.*|${key}=${val}|" "$TMP"
    echo "  교체: ${key}"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$TMP"
    echo "  추가: ${key}"
  fi
}

# 키가 아예 없을 때만 기본값으로 추가 (기존 선택을 덮어쓰지 않음)
add_if_missing() {  # add_if_missing <KEY> <DEFAULT> [주석]
  local key="$1" val="$2" comment="${3:-}"
  if grep -qE "^${key}=" "$TMP"; then return 0; fi
  [ -n "$comment" ] && printf '\n# %s\n' "$comment" >> "$TMP"
  printf '%s=%s\n' "$key" "$val" >> "$TMP"
  echo "  추가(기본값): ${key}=${val}"
}

echo "── 머신 종속 경로 교체 ────────────────────"
set_key PROJECTS_ROOT     "$PROJECTS_ROOT_NEW"
set_key CLAUDE_CLI_PATH   "$CLAUDE_PATH_DETECTED"
set_key CLAUDE_CONFIG_DIR "$CLAUDE_CONFIG_NEW"
set_key NODE_BIN          "$NODE_PATH_DETECTED"
set_key CODEX_CLI_PATH    "$CODEX_PATH_DETECTED"
set_key AGY_CLI_PATH      "$AGY_PATH_DETECTED"

echo
echo "── 멀티 프로바이더 (구현자 ≠ 리뷰어) ──────"
add_if_missing MULTI_PROVIDER  true       "3-프로바이더 로테이션. Build는 Claude, Review는 Codex가 맡아 교차 검증된다."
add_if_missing PROVIDER_PLAN   antigravity
add_if_missing PROVIDER_BUILD  claude
add_if_missing PROVIDER_REVIEW codex
add_if_missing PROVIDER_RELAX_WEEKLY true
add_if_missing PROVIDER_RECLAIM_INTERVAL_MS 60000

echo
echo "── 매니저 루프 (제안까지 자동, 승인은 사람) ─"
add_if_missing MANAGER_LOOP                 true "백로그 제안→승인→브랜치+PR. 병합은 항상 수동."
add_if_missing MANAGER_SCAN_INTERVAL_MIN    180
add_if_missing MANAGER_SCAN_QUIET_HOURS     23-8
add_if_missing MANAGER_SCAN_NOTIFY_EMPTY    false
add_if_missing MANAGER_MAX_PENDING          10
add_if_missing MANAGER_MAX_CONCURRENT       1
add_if_missing MANAGER_MAX_APPROVALS_PER_DAY 3
add_if_missing MANAGER_REQUIRE_INTENT_SIGNAL true
add_if_missing MANAGER_MAX_HISTORY_SIGNALS  3

mv "$TMP" "$DEST"
chmod 600 "$DEST"
trap - EXIT

echo
echo "✅ $DEST 생성 완료 (권한 600)"
echo

# ── 남은 수동 확인 항목 ──────────────────────────────────────
echo "── 직접 확인이 필요한 항목 ────────────────"
MANUAL=0
warn_manual() { echo "  ! $1"; MANUAL=$((MANUAL+1)); }

# 경로형 값이 실제로 존재하는지 (비밀값은 검사도 출력도 하지 않는다)
while IFS='=' read -r k v; do
  case "$k" in
    PROJECTS_ROOT|CLAUDE_CLI_PATH|CLAUDE_CONFIG_DIR|NODE_BIN|CODEX_CLI_PATH|AGY_CLI_PATH)
      [ -z "$v" ] && { warn_manual "$k 가 비어 있음"; continue; }
      case "$v" in
        /*) [ -e "$v" ] || warn_manual "$k=$v 경로가 존재하지 않음" ;;
        *)  command -v "$v" >/dev/null 2>&1 || warn_manual "$k=$v 를 PATH에서 찾을 수 없음" ;;
      esac
      ;;
    *[Mm]ac*|*/Users/*) warn_manual "맥 경로가 남아 있을 수 있음: $k" ;;
  esac
done < <(grep -E '^[A-Z_]+=' "$DEST")

# 맥 경로 잔존 여부 (값은 출력하지 않고 키 이름만)
LEFTOVER="$(grep -nE '^[A-Z_]+=.*/Users/' "$DEST" | cut -d= -f1 | cut -d: -f2 | tr '\n' ' ' || true)"
[ -n "$LEFTOVER" ] && warn_manual "아직 /Users/ 경로가 남은 키: $LEFTOVER"

# ALLOWED_ORIGIN 은 대시보드 주소라 머신과 무관하지만 터널 주소를 쓰면 바뀐다
grep -qE '^ALLOWED_ORIGIN=.+' "$DEST" && echo "  · ALLOWED_ORIGIN 은 대시보드 주소입니다. 터널 URL이 바뀌면 함께 수정하세요."

[ "$MANUAL" -eq 0 ] && echo "  (없음)"
echo
echo "다음 단계:  npm run preflight"
