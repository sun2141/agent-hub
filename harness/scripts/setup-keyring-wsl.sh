#!/usr/bin/env bash
# scripts/setup-keyring-wsl.sh
# WSL2에서 Antigravity(agy) 토큰 캐시용 키링을 무인 운영 가능하게 만든다.
#
# 배경:
#   agy는 OAuth 토큰을 libsecret(리눅스 키링)에 저장한다. 데스크톱 우분투에서는
#   GNOME 세션이 키링 데몬을 띄워주지만, WSL2에는 데스크톱 세션이 없어서
#   D-Bus도 키링 데몬도 뜨지 않는다. 그래서 agy가 매번 재인증을 요구한다.
#
#   해결: 비밀번호가 빈 login 키링을 만들어 두고, 하네스를 dbus 세션 안에서 실행하면서
#   시작 시 그 키링을 열어준다(harness.service의 ExecStart가 처리).
#
# 사용법:
#   bash scripts/setup-keyring-wsl.sh check     # 진단만
#   bash scripts/setup-keyring-wsl.sh install   # 패키지 설치 + 빈 키링 생성 + 검증
#   bash scripts/setup-keyring-wsl.sh verify    # 저장/조회 왕복 테스트
#
# ⚠️ 이 방식은 "이 리눅스 사용자로 접근 가능한 사람은 저장된 토큰을 읽을 수 있다"는
#    트레이드오프를 받아들이는 것이다. docs/SECURITY_EXPOSURE.md 참고.
#
# 이 방법이 끝내 안 되면 agy 없이 운영해도 된다:
#   .env 에서 PROVIDER_PLAN=claude 로 두면 Plan도 Claude가 맡고,
#   Review는 여전히 codex라 "구현 ≠ 리뷰" 교차 검증은 유지된다.

set -uo pipefail
CMD="${1:-check}"

if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else G=''; Y=''; R=''; D=''; N=''; fi
ok()   { echo "  ${G}✓${N} $1"; }
warn() { echo "  ${Y}!${N} $1"; }
bad()  { echo "  ${R}✗${N} $1"; }
info() { echo "  ${D}·${N} $1"; }

is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

check() {
  echo "── 키링 진단 (WSL2) ──────────────────────"
  is_wsl && ok "WSL 환경 감지됨" || warn "WSL이 아닙니다 — 데스크톱이면 setup-antigravity-keyring.sh 를 쓰세요"

  for p in gnome-keyring-daemon secret-tool dbus-run-session; do
    command -v "$p" >/dev/null 2>&1 && ok "$p 있음" || bad "$p 없음"
  done

  if [ -f "$HOME/.local/share/keyrings/login.keyring" ]; then
    ok "login 키링 존재"
  else
    warn "login 키링 없음 — install 로 생성"
  fi

  command -v agy >/dev/null 2>&1 && ok "agy 설치됨" || warn "agy 없음 (Plan을 claude로 돌리면 없어도 됨)"
  echo "──────────────────────────────────────────"
}

install_pkgs() {
  echo "── 패키지 설치 ───────────────────────────"
  local need=()
  command -v gnome-keyring-daemon >/dev/null 2>&1 || need+=(gnome-keyring)
  command -v secret-tool          >/dev/null 2>&1 || need+=(libsecret-tools)
  command -v dbus-run-session     >/dev/null 2>&1 || need+=(dbus-x11)

  if [ ${#need[@]} -eq 0 ]; then ok "필요한 패키지가 모두 설치돼 있습니다"; return 0; fi

  info "설치할 패키지: ${need[*]}"
  sudo apt-get update -qq && sudo apt-get install -y "${need[@]}" \
    && ok "설치 완료" || { bad "설치 실패"; return 1; }
}

create_keyring() {
  echo "── 빈 비밀번호 login 키링 생성 ───────────"
  local kr="$HOME/.local/share/keyrings/login.keyring"
  if [ -f "$kr" ]; then
    ok "이미 존재 — 건너뜁니다 ($kr)"
    info "비밀번호가 걸려 있어 잠긴다면 지우고 다시 실행: rm '$kr'"
    return 0
  fi

  mkdir -p "$HOME/.local/share/keyrings"
  chmod 700 "$HOME/.local/share/keyrings"

  # 빈 비밀번호로 키링을 초기화한다.
  # --unlock 은 stdin에서 비밀번호를 읽는다. 빈 문자열을 주면 빈 비밀번호로 열린다.
  if dbus-run-session -- bash -c 'printf "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1; sleep 1'; then
    ok "키링 초기화 시도 완료"
  else
    warn "키링 데몬 실행이 깔끔하지 않았습니다 — verify 로 실제 동작을 확인하세요"
  fi

  # 기본 키링 이름 지정 (없으면 secret-tool 이 저장할 곳을 못 찾을 수 있음)
  [ -f "$HOME/.local/share/keyrings/default" ] || echo -n "login" > "$HOME/.local/share/keyrings/default"
  ok "기본 키링 = login"
}

verify() {
  echo "── 저장/조회 왕복 테스트 ─────────────────"
  command -v secret-tool >/dev/null 2>&1 || { bad "secret-tool 없음 — 먼저 install"; return 1; }

  local out
  out=$(dbus-run-session -- bash -c '
    printf "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1
    sleep 1
    printf "harness-keyring-probe" | secret-tool store --label="harness probe" harness probe 2>/dev/null
    secret-tool lookup harness probe 2>/dev/null
  ')

  if [ "$out" = "harness-keyring-probe" ]; then
    ok "키링 저장/조회 정상 — agy 토큰이 캐시될 수 있습니다"
    dbus-run-session -- bash -c '
      printf "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1
      sleep 1
      secret-tool clear harness probe 2>/dev/null' || true
    info "테스트 항목 정리됨"
    return 0
  else
    bad "키링 왕복 실패 (읽어온 값: \"${out}\")"
    echo
    warn "agy 토큰이 유지되지 않을 가능성이 높습니다. 두 가지 선택지:"
    info "  1) agy 로그인을 dbus 세션 안에서 다시 시도:"
    info "       dbus-run-session -- bash -c 'printf \"\" | gnome-keyring-daemon --unlock --components=secrets; agy'"
    info "  2) agy 없이 운영 — .env 에서 PROVIDER_PLAN=claude"
    info "     Review는 codex 그대로라 '구현 ≠ 리뷰' 교차 검증은 유지됩니다."
    return 1
  fi
}

case "$CMD" in
  check)   check ;;
  install) install_pkgs && create_keyring && echo && verify ;;
  verify)  verify ;;
  *) echo "사용법: bash scripts/setup-keyring-wsl.sh [check|install|verify]"; exit 1 ;;
esac
