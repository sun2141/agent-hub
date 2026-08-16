#!/usr/bin/env bash
# scripts/setup-thinkpad.sh
# 씽크패드(Ubuntu) 하네스 상시 가동 셋업 — 한 번에 끝내는 대화형 설치기.
#
#   bash scripts/setup-thinkpad.sh            # 처음부터 (완료된 단계는 자동으로 건너뜀)
#   bash scripts/setup-thinkpad.sh --status   # 진행 상황만 확인
#   bash scripts/setup-thinkpad.sh --step 5   # 특정 단계만 다시
#   bash scripts/setup-thinkpad.sh --reset    # 진행 상태 초기화
#
# 성격:
#   - 재실행 안전(idempotent). 중간에 끊겨도 다시 실행하면 이어서 진행한다.
#   - 되돌릴 수 없거나 sudo가 필요한 작업은 실행 전에 명령을 보여주고 물어본다.
#   - 비밀값은 화면에 절대 출력하지 않는다.
#
# 이 스크립트가 건드리는 시스템 설정(전부 확인을 거침):
#   · systemd sleep/suspend 마스킹, 노트북 뚜껑 정책 (7단계, sudo)
#   · 사용자 systemd 서비스 등록 + linger (8단계, sudo 없음)
#   · GNOME 키링 잠금 해제 (4단계, setup-antigravity-keyring.sh 위임)

set -uo pipefail
cd "$(dirname "$0")/.."
HARNESS_DIR="$(pwd)"
REPO_DIR="$(cd .. && pwd)"

STATE_DIR="$HARNESS_DIR/data"
STATE_FILE="$STATE_DIR/setup-thinkpad.state"
mkdir -p "$STATE_DIR"
touch "$STATE_FILE"

TOTAL_STEPS=9

# WSL2에서는 절전·자동시작이 윈도우 쪽 설정이고, 키링과 systemd 구성도 달라진다.
# 해당 단계에서 분기한다.
IS_WSL=0
grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1

# ── 출력 헬퍼 ────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=''; G=''; Y=''; R=''; D=''; N=''
fi
ok()   { echo "  ${G}✓${N} $1"; }
warn() { echo "  ${Y}!${N} $1"; }
bad()  { echo "  ${R}✗${N} $1"; }
info() { echo "  ${D}·${N} $1"; }
head_() { echo; echo "${B}━━ $1 ━━${N}"; }

done_step()    { grep -qx "step$1" "$STATE_FILE"; }
mark_done()    { done_step "$1" || echo "step$1" >> "$STATE_FILE"; }
unmark_step()  { grep -vx "step$1" "$STATE_FILE" > "$STATE_FILE.tmp" 2>/dev/null; mv "$STATE_FILE.tmp" "$STATE_FILE"; }

ask() {  # ask "질문" → yes면 0
  local prompt="$1"
  read -r -p "  ${B}?${N} $prompt [y/N] " ans </dev/tty
  [[ "$ans" =~ ^[Yy]$ ]]
}

pause_for() {  # pause_for "설명"
  echo
  read -r -p "  ${B}↵${N} $1 (계속하려면 Enter, 건너뛰려면 s) " ans </dev/tty
  [[ ! "$ans" =~ ^[Ss]$ ]]
}

STEP_NAMES=(
  "사전 점검 (OS / node / 저장소)"
  "CLI 3종 설치 (claude / codex / agy)"
  "인증 시딩 (구독 3개 로그인)"
  "키링 무인 잠금 해제 (agy 무인 운영)"
  ".env 이관 (맥 → 리눅스 경로)"
  "프로젝트 저장소 clone"
  "절전 방지 (24시간 가동 핵심)"
  "자동 시작 등록 (부팅 후에도 살아남기)"
  "최종 검증 (preflight + 테스트)"
)

show_status() {
  echo "${B}씽크패드 셋업 진행 상황${N}"
  for i in $(seq 1 $TOTAL_STEPS); do
    if done_step "$i"; then echo "  ${G}✓${N} $i. ${STEP_NAMES[$((i-1))]}"
    else echo "  ${D}○${N} $i. ${STEP_NAMES[$((i-1))]}"; fi
  done
  echo
}

# ══════════════════════════════════════════════════════════════
step1() {
  head_ "1/9  사전 점검"

  if [ -f /etc/os-release ]; then
    . /etc/os-release; ok "OS: ${PRETTY_NAME:-unknown}"
  else
    warn "리눅스가 아닌 것 같습니다. 이 스크립트는 Ubuntu용입니다."
    ask "그래도 계속할까요?" || return 1
  fi

  if [ "$IS_WSL" = "1" ]; then
    ok "WSL2 환경 (윈도우 위의 우분투)"
    info "절전 방지와 자동 시작은 윈도우 쪽 설정이라 7·8단계에서 안내합니다"

    # WSL은 기본적으로 systemd 없이 뜬다. 서비스 자동 시작에 반드시 필요하다.
    if [ -d /run/systemd/system ]; then
      ok "systemd 활성화됨"
    else
      warn "systemd가 꺼져 있습니다 — 부팅 시 자동 시작을 하려면 필요합니다"
      echo
      info "/etc/wsl.conf 에 아래를 넣고 WSL을 재시작해야 합니다:"
      echo "      [boot]"
      echo "      systemd=true"
      echo
      if ask "지금 /etc/wsl.conf 를 설정할까요?"; then
        if [ -f /etc/wsl.conf ] && grep -q "systemd" /etc/wsl.conf; then
          sudo sed -i 's/^systemd=.*/systemd=true/' /etc/wsl.conf
        else
          printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf >/dev/null
        fi
        ok "/etc/wsl.conf 설정됨"
        echo
        warn "${B}윈도우 PowerShell에서 WSL을 재시작한 뒤 이 스크립트를 다시 실행하세요:${N}"
        echo "      wsl --shutdown"
        echo "      wsl"
        echo "      cd ~/agent-hub/harness && npm run setup:thinkpad"
        return 1
      else
        warn "건너뜀 — 자동 시작이 동작하지 않습니다 (수동으로 npm start 해야 함)"
      fi
    fi

    # 윈도우 파일시스템(/mnt/c)에 저장소를 두면 파일 I/O가 수 배 느려지고 권한 문제가 생긴다.
    case "$REPO_DIR" in
      /mnt/[a-z]/*)
        bad "저장소가 윈도우 파일시스템에 있습니다: $REPO_DIR"
        info "리눅스 홈으로 옮기세요 — 그대로 두면 빌드/테스트가 몇 배 느려집니다:"
        info "  git clone git@github.com:sun2141/agent-hub.git ~/agent-hub"
        ask "그래도 계속할까요? (권장하지 않음)" || return 1
        ;;
      *) ok "저장소가 리눅스 파일시스템에 있습니다" ;;
    esac
  fi

  if command -v node >/dev/null 2>&1; then
    local major; major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
    if [ "${major:-0}" -ge 22 ] 2>/dev/null; then ok "node $(node -v)"
    else bad "node $(node -v) — 22 이상이 필요합니다"; return 1; fi
  else
    bad "node 없음 — 설치 후 다시 실행하세요 (nvm 또는 apt)"; return 1
  fi

  command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || { bad "git 없음"; return 1; }

  [ -f "$HARNESS_DIR/package.json" ] || { bad "harness 디렉토리가 아닙니다: $HARNESS_DIR"; return 1; }
  ok "저장소: $REPO_DIR"

  if [ ! -d "$HARNESS_DIR/node_modules" ]; then
    info "의존성 설치 중 (npm install)..."
    npm install --silent || { bad "npm install 실패"; return 1; }
  fi
  ok "의존성 준비됨"
  return 0
}

step2() {
  head_ "2/9  CLI 3종 설치"
  echo "  구독 3개가 각각 하나의 역할을 맡습니다:"
  info "claude → Build (구현)        | codex → Review (교차 리뷰) | agy → Plan (설계)"
  echo

  local missing=0

  if command -v claude >/dev/null 2>&1; then ok "claude: $(command -v claude)"
  else
    warn "claude 없음"
    if ask "npm으로 설치할까요? (@anthropic-ai/claude-code)"; then
      npm install -g @anthropic-ai/claude-code && ok "claude 설치됨" || { bad "설치 실패 — 공식 안내를 따라 수동 설치"; missing=1; }
    else missing=1; fi
  fi

  if command -v codex >/dev/null 2>&1; then ok "codex: $(command -v codex)"
  else
    warn "codex 없음"
    if ask "npm으로 설치할까요? (@openai/codex)"; then
      npm install -g @openai/codex && ok "codex 설치됨" || { bad "설치 실패 — 배포 채널 확인 필요"; missing=1; }
    else missing=1; fi
  fi

  if command -v agy >/dev/null 2>&1; then ok "agy: $(command -v agy)"
  else
    bad "agy 없음 — Antigravity CLI는 자동 설치할 수 없습니다"
    info "Google 공식 안내에 따라 설치한 뒤 이 단계를 다시 실행하세요:"
    info "  bash scripts/setup-thinkpad.sh --step 2"
    missing=1
  fi

  if [ "$missing" -ne 0 ]; then
    echo
    warn "일부 CLI가 없습니다. 없는 프로바이더는 하네스가 자동으로 건너뛰지만,"
    warn "역할 분리(구현≠리뷰)의 효과가 줄어듭니다."
    ask "이대로 진행할까요?" || return 1
  fi
  return 0
}

step3() {
  head_ "3/9  인증 시딩"
  echo "  각 CLI를 1회 로그인시킵니다. 브라우저가 열리거나 코드 입력을 요구합니다."
  echo "  ${D}이미 로그인돼 있으면 건너뛰어도 됩니다.${N}"

  local cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude-harness}"
  mkdir -p "$cfg"
  if command -v claude >/dev/null 2>&1; then
    echo
    info "claude — 하네스 전용 설정 디렉토리($cfg)로 로그인합니다."
    info "로그인이 끝나면 claude를 종료(Ctrl+D 또는 /exit)하세요."
    if pause_for "claude 로그인을 시작합니다"; then
      CLAUDE_CONFIG_DIR="$cfg" claude || warn "claude 종료 코드 비정상 (로그인은 됐을 수 있음)"
    fi
  fi

  if command -v codex >/dev/null 2>&1; then
    echo
    if [ -f "$HOME/.codex/auth.json" ]; then ok "codex 이미 인증됨 (~/.codex/auth.json)"
    elif pause_for "codex login 을 실행합니다"; then
      codex login || warn "codex login 실패 — 나중에 수동으로"
    fi
  fi

  if command -v agy >/dev/null 2>&1; then
    echo
    info "agy — 최초 실행 시 디바이스 코드가 표시됩니다. 브라우저에서 승인하세요."
    if pause_for "agy 로그인을 시작합니다"; then
      agy || warn "agy 종료 코드 비정상 (로그인은 됐을 수 있음)"
    fi
  fi

  echo
  ok "인증 단계 완료 (실제 상태는 9단계 preflight에서 확인)"
  return 0
}

step4() {
  head_ "4/9  키링 무인 잠금 해제"
  echo "  agy(Gemini)는 토큰을 리눅스 키링에 저장합니다. 키링이 잠겨 있으면"
  echo "  매번 재인증을 요구해서 무인 운영이 깨집니다."
  echo "  ${Y}트레이드오프:${N} 키링 비밀번호를 비우면 이 사용자로 접근 가능한 사람은"
  echo "  저장된 자격증명을 읽을 수 있습니다."

  if [ "$IS_WSL" = "1" ]; then
    echo
    warn "WSL2에는 데스크톱 세션이 없어 키링 데몬이 자동으로 뜨지 않습니다."
    info "빈 비밀번호 키링을 만들고 실제 저장/조회가 되는지 검증합니다."
    echo
    if ask "WSL용 키링 설정을 진행할까요?"; then
      if bash scripts/setup-keyring-wsl.sh install; then
        ok "키링 준비됨 — agy 토큰이 유지될 수 있습니다"
      else
        echo
        warn "키링이 동작하지 않습니다. agy 없이 가는 편이 안정적입니다."
        if ask "PROVIDER_PLAN 을 claude 로 바꿔 agy 없이 운영할까요?"; then
          if [ -f "$HARNESS_DIR/.env" ]; then
            if grep -q '^PROVIDER_PLAN=' "$HARNESS_DIR/.env"; then
              sed -i 's|^PROVIDER_PLAN=.*|PROVIDER_PLAN=claude|' "$HARNESS_DIR/.env"
            else
              echo 'PROVIDER_PLAN=claude' >> "$HARNESS_DIR/.env"
            fi
            ok "PROVIDER_PLAN=claude 설정됨"
          else
            info ".env가 아직 없습니다 — 5단계 후 직접 PROVIDER_PLAN=claude 로 두세요"
          fi
          info "Review는 codex 그대로라 '구현 ≠ 리뷰' 교차 검증은 유지됩니다"
        fi
      fi
    else
      info "건너뜀. agy가 재인증을 요구하면: bash scripts/setup-keyring-wsl.sh install"
    fi
    return 0
  fi

  if [ ! -f "$HARNESS_DIR/scripts/setup-antigravity-keyring.sh" ]; then
    warn "setup-antigravity-keyring.sh 없음 — 건너뜁니다"; return 0
  fi

  echo
  bash scripts/setup-antigravity-keyring.sh check || true
  echo
  if ask "무인 부팅용으로 키링 잠금을 해제할까요? (empty 방식)"; then
    bash scripts/setup-antigravity-keyring.sh empty || warn "키링 설정 실패 — 수동 확인 필요"
  else
    info "건너뜀. agy가 재인증을 요구하면 이 단계를 다시 실행하세요."
  fi
  return 0
}

step5() {
  head_ "5/9  .env 이관"

  if [ -f "$HARNESS_DIR/.env" ] && grep -q "NEON_DATABASE_URL=." "$HARNESS_DIR/.env" 2>/dev/null; then
    ok ".env 가 이미 있습니다"
    ask "맥에서 가져온 파일로 다시 만들까요? (기존 것은 백업됨)" || return 0
  fi

  echo "  맥에서 복사해온 .env 경로를 입력하세요."
  info "맥에서: cp /Users/sun/agent-hub/harness/.env ~/env-from-mac  → USB/scp로 전송"
  echo
  local src=""
  for cand in "$HOME/env-from-mac" "$HOME/Downloads/env-from-mac" "$HOME/.env-from-mac"; do
    [ -f "$cand" ] && { src="$cand"; break; }
  done
  if [ -n "$src" ]; then
    ok "발견: $src"
    ask "이 파일을 사용할까요?" || src=""
  fi
  if [ -z "$src" ]; then
    read -r -p "  경로 입력 (건너뛰려면 빈 값): " src </dev/tty
    [ -z "$src" ] && { warn "건너뜀 — .env 없이는 하네스가 뜨지 않습니다"; return 1; }
  fi
  src="${src/#\~/$HOME}"
  [ -f "$src" ] || { bad "파일 없음: $src"; return 1; }

  bash scripts/migrate-env-to-linux.sh "$src" || return 1

  echo
  if ask "${Y}원본($src)을 삭제할까요? 평문 비밀값이 들어 있습니다${N}"; then
    rm -f "$src" && ok "삭제됨"
  else
    warn "남겨둠 — 설치가 끝나면 반드시 지우세요: rm $src"
  fi
  return 0
}

step6() {
  head_ "6/9  프로젝트 저장소 clone"

  local root
  root="$(grep -E '^PROJECTS_ROOT=' "$HARNESS_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | cut -d, -f1)"
  root="${root:-$HOME/projects}"
  mkdir -p "$root"
  ok "PROJECTS_ROOT: $root"
  info "에이전트가 접근 가능한 범위입니다. 여기 밖은 건드리지 못합니다."

  echo
  echo "  등록된 프로젝트 중 이 경로에 없는 것:"
  local missing=()
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    if [ -d "$root/$id/.git" ]; then ok "$id"
    else warn "$id — 없음"; missing+=("$id"); fi
  done < <(node -e "
    const path = require('path');
    import('./src/projects.js')
      .then(m => m.PROJECTS.forEach(p => console.log(path.basename(p.path))))
      .catch(() => {});
  " 2>/dev/null || true)

  if [ ${#missing[@]} -eq 0 ]; then ok "모든 프로젝트가 준비됐습니다"; return 0; fi

  echo
  info "없는 저장소는 직접 clone 하세요. 예:"
  for m in "${missing[@]}"; do
    echo "    git -C \"$root\" clone git@github.com:sun2141/$m.git"
  done
  echo
  info "지금 다 하지 않아도 됩니다 — 실제로 돌릴 프로젝트만 있으면 됩니다."
  ask "계속 진행할까요?" || return 1
  return 0
}

step7() {
  head_ "7/9  절전 방지  ${Y}(상시 가동의 핵심)${N}"
  echo "  노트북이 잠들면 파이프라인이 통째로 멈춥니다. 씽크패드를 서버로 쓰는 이유가"
  echo "  '안 꺼져서'인 만큼 이 단계가 사실상 전부입니다."
  echo

  if [ "$IS_WSL" = "1" ]; then
    warn "WSL2에서는 절전이 ${B}윈도우${N} 설정입니다. 리눅스 안에서는 바꿀 수 없습니다."
    echo
    echo "  ${B}윈도우에서 PowerShell을 '관리자 권한으로' 열고 아래를 실행하세요:${N}"
    echo
    echo "    ${D}# 전원 연결 시 대기 모드/최대 절전 안 함${N}"
    echo "    powercfg /change standby-timeout-ac 0"
    echo "    powercfg /change hibernate-timeout-ac 0"
    echo "    powercfg /change monitor-timeout-ac 10"
    echo
    echo "    ${D}# 뚜껑을 닫아도 안 자게 (전원 연결 시)${N}"
    echo "    powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0"
    echo "    powercfg /setactive SCHEME_CURRENT"
    echo
    echo "    ${D}# 확인 — 대기 시간이 0이면 성공${N}"
    echo "    powercfg /query SCHEME_CURRENT SUB_SLEEP"
    echo
    info "추가로 설정 > Windows 업데이트 > 고급 옵션에서"
    info "  '활성 시간'을 넓게 잡아 자동 재부팅을 줄이세요. 업데이트 재부팅은 완전히"
    info "  막을 수 없으니, 8단계의 자동 시작 등록이 재부팅 복구를 담당합니다."
    echo
    pause_for "윈도우에서 위 설정을 마쳤으면 계속" || { info "나중에 하세요 — 안 하면 노트북이 자며 하네스가 멈춥니다"; }
    return 0
  fi

  echo "  ${D}실행할 명령 (sudo 필요):${N}"
  echo "    sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target"
  echo "    /etc/systemd/logind.conf 의 HandleLidSwitch* 를 ignore 로 변경"
  echo "    sudo systemctl restart systemd-logind"
  echo
  info "뚜껑을 닫아도 계속 돌게 됩니다. 발열/전원 연결 상태를 확인하세요."

  ask "적용할까요?" || { info "건너뜀 — 나중에 SETUP_THINKPAD.md 5단계 참고"; return 0; }

  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target \
    && ok "suspend/hibernate 차단됨" || { bad "마스킹 실패"; return 1; }

  if [ -f /etc/systemd/logind.conf ]; then
    sudo cp /etc/systemd/logind.conf "/etc/systemd/logind.conf.bak.$(date +%Y%m%d%H%M%S)"
    sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
    sudo sed -i 's/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
    grep -q '^HandleLidSwitch=ignore' /etc/systemd/logind.conf || echo 'HandleLidSwitch=ignore' | sudo tee -a /etc/systemd/logind.conf >/dev/null
    sudo systemctl restart systemd-logind && ok "뚜껑 닫아도 안 잠김 (logind 재시작됨)"
  fi

  [ "$(systemctl is-enabled sleep.target 2>/dev/null)" = "masked" ] \
    && ok "확인: sleep.target masked" || warn "확인 실패 — systemctl is-enabled sleep.target 직접 확인"
  return 0
}

step8_wsl() {
  echo "  WSL2에서는 두 겹으로 설정합니다:"
  info "  ① 리눅스 안: systemd ${B}시스템${N} 서비스 (WSL이 뜨면 하네스도 뜸)"
  info "  ② 윈도우 쪽: 부팅 시 WSL 자체를 띄우는 작업 스케줄러 등록"

  if [ ! -d /run/systemd/system ]; then
    bad "systemd가 꺼져 있습니다 — 1단계에서 /etc/wsl.conf 설정 후 wsl --shutdown 필요"
    return 1
  fi

  local node_bin; node_bin="$(command -v node)"
  local unit=/etc/systemd/system/harness.service

  # WSL에는 데스크톱 세션이 없어 키링 데몬이 없다. dbus 세션 안에서 실행하고
  # 시작 시 빈 비밀번호로 키링을 열어 agy 토큰을 읽을 수 있게 한다.
  local exec_line="$node_bin src/index.js"
  if command -v dbus-run-session >/dev/null 2>&1 && command -v gnome-keyring-daemon >/dev/null 2>&1; then
    exec_line="/usr/bin/dbus-run-session -- /bin/bash -c 'printf \"\" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1; exec $node_bin src/index.js'"
    info "키링 언락을 포함해 실행하도록 구성합니다"
  fi

  if [ -f "$unit" ]; then
    ok "유닛이 이미 있습니다: $unit"
    ask "덮어쓸까요?" || { sudo systemctl restart harness 2>/dev/null && ok "재시작됨"; return 0; }
  fi

  sudo tee "$unit" >/dev/null <<EOF
[Unit]
Description=Agent Harness (multi-provider, always-on)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HARNESS_DIR
ExecStart=$exec_line
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  ok "유닛 생성: $unit"

  sudo systemctl daemon-reload || warn "daemon-reload 실패"

  if ask "지금 서비스를 시작할까요?"; then
    sudo systemctl enable --now harness \
      && ok "harness 실행 중 (WSL 부팅 시 자동 시작)" \
      || { bad "시작 실패 — sudo journalctl -u harness -n 50"; return 1; }
    sleep 3
    sudo systemctl is-active --quiet harness && ok "상태: active" \
      || warn "active 아님 — sudo journalctl -u harness -n 50 확인"
  else
    info "나중에: sudo systemctl enable --now harness"
  fi

  echo
  echo "  ${B}② 윈도우 부팅 시 WSL 자동 시작${N}"
  echo "  WSL은 누가 열기 전까지 뜨지 않습니다. 윈도우 재부팅(업데이트 등) 후에도"
  echo "  하네스가 살아나려면 작업 스케줄러 등록이 필요합니다."
  echo
  local distro="${WSL_DISTRO_NAME:-Ubuntu}"
  echo "  ${B}윈도우 PowerShell(관리자)에서 아래 한 줄:${N}"
  echo
  echo "    \$A = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument '-d $distro -u $USER --exec /bin/true'"
  echo "    \$T = New-ScheduledTaskTrigger -AtStartup"
  echo "    \$P = New-ScheduledTaskPrincipal -UserId \"\$env:USERNAME\" -LogonType S4U -RunLevel Highest"
  echo "    \$S = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries"
  echo "    Register-ScheduledTask -TaskName 'Start WSL Harness' -Action \$A -Trigger \$T -Principal \$P -Settings \$S"
  echo
  info "확인: Get-ScheduledTask -TaskName 'Start WSL Harness'"
  info "테스트: 윈도우를 재부팅한 뒤 WSL에서 systemctl status harness"
  echo
  pause_for "작업 스케줄러 등록을 마쳤으면 계속" || info "나중에 하세요 — 안 하면 재부팅 후 수동으로 wsl을 열어야 합니다"

  echo
  info "로그 보기:  sudo journalctl -u harness -f"
  info "재시작:     sudo systemctl restart harness"
  return 0
}

step8() {
  head_ "8/9  자동 시작 등록"

  if [ "$IS_WSL" = "1" ]; then step8_wsl; return $?; fi

  echo "  부팅 시 자동 시작 + 죽으면 자동 재시작 + 로그아웃해도 유지."

  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/harness.service"
  local node_bin; node_bin="$(command -v node)"
  mkdir -p "$unit_dir"

  if [ -f "$unit" ]; then
    ok "유닛 파일이 이미 있습니다: $unit"
    ask "덮어쓸까요?" || { systemctl --user restart harness.service 2>/dev/null && ok "재시작됨"; return 0; }
  fi

  cat > "$unit" <<EOF
[Unit]
Description=Agent Harness (multi-provider, always-on)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$HARNESS_DIR
ExecStart=$node_bin src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
  ok "유닛 생성: $unit"

  systemctl --user daemon-reload || warn "daemon-reload 실패"

  # 로그아웃/재부팅 후에도 유지 (sudo 필요할 수 있음)
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
    info "linger 활성화 — 로그아웃 후에도 서비스가 유지됩니다"
    sudo loginctl enable-linger "$USER" && ok "linger 활성" || warn "linger 실패 — 로그인 상태에서만 유지됨"
  else
    ok "linger 이미 활성"
  fi

  if ask "지금 서비스를 시작할까요?"; then
    systemctl --user enable --now harness.service && ok "harness.service 실행 중" \
      || { bad "시작 실패 — 로그: journalctl --user -u harness -n 50"; return 1; }
    sleep 3
    systemctl --user is-active --quiet harness.service && ok "상태: active" \
      || warn "active 아님 — journalctl --user -u harness -n 50 확인"
  else
    info "나중에: systemctl --user enable --now harness.service"
  fi

  echo
  info "로그 보기:   journalctl --user -u harness -f"
  info "재시작:      systemctl --user restart harness"
  info "정지:        systemctl --user stop harness"
  return 0
}

step9() {
  head_ "9/9  최종 검증"

  echo
  echo "${B}[하네스 자체 테스트]${N}"
  npm run verify --silent >/tmp/harness_verify.log 2>&1 \
    && ok "테스트 통과 (45 + 28 + 7)" \
    || { bad "테스트 실패 — tail -40 /tmp/harness_verify.log"; tail -20 /tmp/harness_verify.log; }

  echo
  echo "${B}[환경 종합 점검]${N}"
  bash scripts/preflight.sh

  echo
  echo "${B}[다음 할 일]${N}"
  info "1. 텔레그램에 /help 를 보내 ${B}씽크패드에서만${N} 응답이 오는지 확인"
  info "   (맥이나 VPS 하네스가 살아 있으면 명령이 씹힙니다)"
  info "2. 백로그 작성 — 이게 없으면 /scan 해도 제안이 0건입니다"
  info "   directives/projects/<id>.md 의 '## Backlog' 섹션"
  info "   확인: npm run backlog"
  info "3. 프로젝트에 검증 스크립트 추가 — docs/PROJECT_VERIFY_GATE.md"
  return 0
}

# ══════════════════════════════════════════════════════════════
run_step() {
  local n="$1"
  if done_step "$n" && [ "${FORCE:-0}" != "1" ]; then
    echo "  ${D}✓ $n. ${STEP_NAMES[$((n-1))]} — 완료됨, 건너뜀${N}"
    return 0
  fi
  if "step$n"; then
    mark_done "$n"
    return 0
  else
    echo
    bad "${STEP_NAMES[$((n-1))]} 단계에서 멈췄습니다."
    info "해결 후 다시 실행하면 이 단계부터 이어집니다: bash scripts/setup-thinkpad.sh"
    return 1
  fi
}

case "${1:-}" in
  --status) show_status; exit 0 ;;
  --reset)  : > "$STATE_FILE"; echo "진행 상태를 초기화했습니다."; exit 0 ;;
  --step)
    [ -n "${2:-}" ] || { echo "사용법: --step <1-$TOTAL_STEPS>"; exit 1; }
    FORCE=1 run_step "$2"; exit $?
    ;;
  -h|--help)
    sed -n '2,30p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

clear 2>/dev/null || true
echo "${B}════════════════════════════════════════════${N}"
echo "${B}  Agent Harness — 씽크패드 상시 가동 셋업${N}"
echo "${B}════════════════════════════════════════════${N}"
echo
echo "  9단계로 진행합니다. 중간에 끊겨도 다시 실행하면 이어집니다."
echo "  ${D}진행 상황: bash scripts/setup-thinkpad.sh --status${N}"
show_status

if grep -q "step" "$STATE_FILE" 2>/dev/null; then
  ask "이어서 진행할까요?" || exit 0
fi

for i in $(seq 1 $TOTAL_STEPS); do
  run_step "$i" || exit 1
done

echo
echo "${G}${B}════════════════════════════════════════════${N}"
echo "${G}${B}  셋업 완료${N}"
echo "${G}${B}════════════════════════════════════════════${N}"
echo
if [ "$IS_WSL" = "1" ]; then
  info "상태 확인:  sudo systemctl status harness"
  info "로그:       sudo journalctl -u harness -f"
else
  info "상태 확인:  systemctl --user status harness"
  info "로그:       journalctl --user -u harness -f"
fi
info "재점검:     npm run preflight"
echo
