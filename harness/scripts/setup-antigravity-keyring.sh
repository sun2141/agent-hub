#!/usr/bin/env bash
# setup-antigravity-keyring.sh
# Antigravity(agy) 무인 운영을 위한 GNOME 키링 잠금 해제 설정.
# 메인 런타임인 ThinkPad(Ubuntu Desktop 24.04)에서 1회 실행.
#
# 문제: GNOME 자동 로그인 시 로그인 키링이 잠긴 채 부팅되어,
#       agy가 토큰(libsecret 캐시)을 읽지 못하고 재인증을 요구 → 무인 운영 중단.
# 해결: 로그인 키링 비밀번호를 빈 값으로 설정하거나 PAM 자동 잠금 해제를 활성화.
#
# 사용법:
#   bash scripts/setup-antigravity-keyring.sh check     # 현재 상태 진단
#   bash scripts/setup-antigravity-keyring.sh empty      # 로그인 키링 비번을 빈 값으로 (권장, 무인용)
#   bash scripts/setup-antigravity-keyring.sh pam        # PAM 자동 잠금 해제 안내
set -euo pipefail

CMD="${1:-check}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "  ✗ 필요한 명령 없음: $1"; return 1; }; }

check() {
  echo "── 키링 진단 ──────────────────────────────"
  echo "OS: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -a)"
  if need gnome-keyring-daemon; then echo "  ✓ gnome-keyring-daemon 설치됨"; fi
  if need secret-tool; then echo "  ✓ secret-tool(libsecret) 설치됨"; else
    echo "  ! secret-tool 없음 → sudo apt install libsecret-tools"; fi
  echo
  echo "로그인 키링 파일:"
  ls -l "$HOME/.local/share/keyrings/" 2>/dev/null || echo "  (키링 디렉토리 없음 — 아직 미생성)"
  echo
  echo "자동 로그인 설정(gdm):"
  grep -E "AutomaticLogin" /etc/gdm3/custom.conf 2>/dev/null || echo "  (자동 로그인 미설정 또는 확인 불가)"
  echo
  echo "agy 인증 상태:"
  if need agy; then agy --version 2>/dev/null || true; fi
  echo "  → 재인증이 필요하면: agy 로그인(디바이스 코드) 1회 수행 후 이 스크립트로 잠금 해제"
  echo "──────────────────────────────────────────"
}

set_empty() {
  cat <<'EOF'
로그인 키링 비밀번호를 "빈 값"으로 설정하는 절차 (GUI 필요, 1회):

1) Seahorse(암호 및 키) 설치·실행:
     sudo apt install seahorse
     seahorse
2) 좌측 "로그인" 키링 우클릭 → "비밀번호 변경"
3) 현재 비밀번호 입력 → 새 비밀번호를 "빈 값"으로 두고 확인
     (경고가 뜨면 "안전하지 않은 저장 사용" 선택)
4) 재부팅 후 잠금 없이 부팅되는지 확인:
     bash scripts/setup-antigravity-keyring.sh check

효과: 자동 로그인 부팅 시 키링이 자동 해제되어 agy가 토큰을 바로 읽음.
주의: 디스크의 자격증명이 평문에 가깝게 저장됨 — 물리 접근이 통제된
      개인 노트북에서만 사용하고, 공용/노출 환경에서는 pam 방식을 쓰세요.
EOF
}

set_pam() {
  cat <<'EOF'
PAM 자동 잠금 해제 방식 (비번은 유지, 로그인 시 자동 해제):

/etc/pam.d/login 과 /etc/pam.d/gdm-password 에 아래가 있는지 확인:
    auth     optional  pam_gnome_keyring.so
    session  optional  pam_gnome_keyring.so auto_start

핵심 조건: "로그인 키링 비밀번호 == 사용자 로그인 비밀번호" 여야
자동 해제가 동작합니다. 자동 로그인(비번 없이 부팅)에서는 이 방식이
동작하지 않으므로, 완전 무인 부팅이 목표면 empty 방식을 쓰세요.

권장 조합(무인 노트북): 자동 로그인 끄기 + 로그인 비번 사용 + PAM 자동 해제.
EOF
}

case "$CMD" in
  check) check ;;
  empty) set_empty ;;
  pam)   set_pam ;;
  *) echo "사용법: $0 {check|empty|pam}"; exit 1 ;;
esac
