# ThinkPad(Ubuntu 24.04) 멀티 프로바이더 하네스 셋업 가이드

메인 런타임 = ThinkPad X13, VPS = 예비. 아래 순서대로 1회 설정하면 무인 운영된다.
각 단계 후 `npm run preflight`로 검증할 수 있다.

---

## 0. 전제

- Ubuntu Desktop 24.04, Node.js 22, git, 하네스 레포(`agent-hub`) 클론 완료.
- 구독: Claude Pro / ChatGPT Plus / Google AI Pro (모두 로그인 가능한 계정).

```bash
cd ~/agent-hub/harness
npm install
```

---

## 1. 세 CLI 설치

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code       # 또는 공식 설치 스크립트
which claude

# Codex CLI
npm install -g @openai/codex                   # 배포 채널에 맞게
which codex

# Antigravity CLI (agy) — Gemini CLI 개인용 종료 후속
#   설치 방법은 Google 공식 안내를 따른다. 설치 후:
which agy
```

`which` 결과 경로를 뒤(4단계) `.env`의 `*_CLI_PATH`에 넣는다.

---

## 2. 인증 시딩 (각 1회)

```bash
# Claude: 데스크톱 로그인(OAuth). 하네스 전용 설정 디렉토리 사용 권장.
mkdir -p ~/.claude-harness
CLAUDE_CONFIG_DIR=~/.claude-harness claude   # 로그인 완료 후 종료
#   → .env 의 CLAUDE_CONFIG_DIR=/home/<user>/.claude-harness

# Codex: ChatGPT 계정 로그인 → ~/.codex/auth.json 생성
codex login

# Antigravity: OAuth 디바이스 코드. 터미널 안내 URL을 브라우저에서 승인.
agy            # 최초 실행 시 디바이스 코드 → 승인하면 키링에 토큰 캐시
```

> Codex `auth.json`은 **제자리 갱신**된다. 하네스 인스턴스를 두 개 돌리면
> 동시 갱신으로 손상될 수 있으니 **한 대에서만** 실행한다.

---

## 3. 키링 무인 잠금 해제 (Antigravity 핵심)

GNOME 자동 로그인이면 키링이 잠긴 채 부팅되어 `agy`가 재인증을 요구한다.
무인 운영하려면 아래 중 하나:

```bash
bash scripts/setup-antigravity-keyring.sh check   # 진단
bash scripts/setup-antigravity-keyring.sh empty    # 무인 부팅용(권장): 로그인 키링 비번 빈 값
bash scripts/setup-antigravity-keyring.sh pam      # 비번 유지 + PAM 자동 해제 방식
```

권장(개인 노트북): **empty** 방식 + 물리 접근 통제.
보안 민감 환경이면 자동 로그인 끄고 PAM 방식.

---

## 4. `.env` 설정

```bash
cp .env.example .env    # 최초만
nano .env
```

멀티 프로바이더 관련 최소 값:

```ini
MULTI_PROVIDER=true
CLAUDE_CLI_PATH=/usr/local/bin/claude
CLAUDE_CONFIG_DIR=/home/<user>/.claude-harness
CODEX_CLI_PATH=/usr/local/bin/codex
AGY_CLI_PATH=/usr/local/bin/agy
AGY_MODEL=                       # 비우면 기본, 예: gemini-3-pro

PROVIDER_PLAN=antigravity        # Plan 핀 고정
PROVIDER_BUILD=claude            # Build/Test-fix (페일오버 허용)
PROVIDER_REVIEW=codex            # Review(eval) 핀 고정
PROVIDER_RELAX_WEEKLY=true       # weekly 캡이면 핀 단계도 강등
PROVIDER_RECLAIM_INTERVAL_MS=60000

# 기존 필수값 유지: NEON_DATABASE_URL, API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
#                   DASHBOARD_PASSWORD, PROJECTS_ROOT 등
```

> **Telegram 단일 폴링**: ThinkPad와 VPS가 같은 봇 토큰을 동시에 폴링하면 충돌한다.
> ThinkPad를 메인으로 켤 땐 VPS 하네스를 멈추거나(`pm2 stop`), 예비 전용으로만 둔다.

---

## 5. sleep(절전) 방지 — 무인 운영 필수

노트북 뚜껑 닫기/절전은 실행 중단의 최대 원인.

```bash
# suspend/hibernate 계열 차단 (가장 확실)
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# 뚜껑 닫아도 안 자게 (logind)
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sudo sed -i 's/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
```

---

## 6. 서비스 등록 (systemd, 부팅 자동 시작 + 자동 재시작)

`~/.config/systemd/user/harness.service`:

```ini
[Unit]
Description=Agent Harness (multi-provider)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/agent-hub/harness
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now harness.service
loginctl enable-linger $USER      # 로그아웃/부팅 후에도 유지
journalctl --user -u harness -f   # 로그 확인
```

> pm2를 이미 쓰고 있다면 systemd 대신 `pm2 start src/index.js --name harness && pm2 save`도 가능.
> 단, 한 방식만 사용(중복 기동 = harness.pid 락으로 차단됨).

---

## 7. 활성화 & 검증

```bash
npm run preflight        # 3 CLI/인증/키링/env/DB/sleep 종합 점검
npm run test:mp          # 멀티 프로바이더 정책 7 시나리오
npm run providers        # 현재 프로바이더 상태(available/cooling) 표
```

하네스를 처음 기동하면 `harness.providers` 테이블이 자동 생성·시드된다.
정상이면 `providers`에 claude/antigravity/codex 3행이 `available`로 나온다.

동작 확인: 간단한 태스크를 Telegram으로 하나 던져
Plan→antigravity, Build→claude, Review→codex 로 흐르는지 로그(`[MP] <phase> → <provider>`)로 확인.
한도에 걸리면 `🧊cooling` 표시 + Build는 페일오버, Plan/Review는 `⏳` 대기 후 `▶️` 자동 재개.

---

## 8. 운영 팁 (Pro 티어)

- 세 계정 모두 사실상 **주간 캡** 존재. Plan에 프리미엄을 집중하고 Build/Eval은 저렴 티어로.
- 한 도구의 주간 캡이 소진되면 `weight`를 낮춰 강등: `providerQueries.setWeight('codex', 30)`.
- 동시성은 `.env`의 `MAX_CONCURRENT_AGENTS=2`(기본), 최대 3까지. 프로바이더당 단일 실행은 코드가 강제.
- 롤백: `.env`에서 `MULTI_PROVIDER=false` → 재시작하면 기존 Claude 단독 경로로 즉시 복귀.

---

## 문제 해결

| 증상 | 확인 |
|---|---|
| agy가 매번 재인증 요구 | 키링 잠김 → 3단계 empty/pam 재적용, `preflight`의 키링 항목 확인 |
| codex 곧바로 실패 | `~/.codex/auth.json` 없음/손상 → `codex login` 재실행 |
| Telegram 봇 무응답/충돌 | VPS와 동시 폴링 여부 확인, 한쪽만 실행 |
| providers 조회 실패 | 하네스 최초 기동 전이거나 `NEON_DATABASE_URL` 오류 |
| 자꾸 대기만 함 | `npm run providers`로 전부 cooling인지 확인, 리셋 시각 도달 여부 |
| 노트북이 잠들어 중단 | 5단계 sleep 방지 재적용, `systemctl is-enabled sleep.target`=masked 확인 |
