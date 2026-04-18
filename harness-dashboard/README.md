# harness-dashboard

Agent Harness + 모바일 대시보드 레포

## 구조

```
harness-dashboard/
├── harness/                ← Node.js 백엔드 (Plan → Build → Eval)
│   ├── src/
│   │   ├── index.js        ← 진입점 (PID 락, 환경변수 검증, 부팅)
│   │   ├── watchdog.js     ← 프로세스 감시 + 자동 재시작
│   │   ├── projects.js     ← 프로젝트 목록 정의
│   │   ├── agent/
│   │   │   └── runner.js   ← 파이프라인 실행기 (Claude Code CLI)
│   │   ├── api/
│   │   │   └── server.js   ← Express REST API + WebSocket
│   │   ├── db/
│   │   │   └── db.js       ← SQLite (projects, tasks, logs)
│   │   └── telegram/
│   │       └── bot.js      ← Telegram 봇 (명령어 + 이벤트 알림)
│   ├── scripts/
│   │   └── deploy_detached.sh
│   ├── .claude/
│   │   └── settings.json   ← Claude Code CLI 전용 설정
│   ├── package.json
│   └── .env.example
│
└── dashboard/              ← React/Vite 모바일 대시보드
    ├── src/
    │   ├── App.jsx
    │   ├── main.jsx
    │   ├── index.css
    │   └── hooks/
    │       └── useHarness.js
    ├── package.json
    └── .env.example
```

## 시작하기

### 1. 백엔드 세팅

```bash
cd harness
cp .env.example .env
nano .env            # API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 필수 입력
npm install
node src/index.js    # 직접 실행
# 또는
node src/watchdog.js # watchdog 통해 실행 (자동 재시작)
```

### 2. 대시보드 세팅 (개발)

```bash
cd dashboard
cp .env.example .env.local
nano .env.local      # VITE_API_KEY를 harness/.env의 API_KEY와 동일하게
npm install
npm run dev
```

### 3. 대시보드 빌드 (백엔드에서 정적 서빙)

```bash
cd dashboard
npm run build
# 빌드 결과: dashboard/dist/
# harness API 서버가 자동으로 서빙함 (http://localhost:3000/)
```

## Telegram 명령어

| 명령어 | 설명 |
|--------|------|
| `/status` | 하네스 실행 상태 |
| `/projects` | 프로젝트 목록 |
| `/run <id> <prompt>` | 파이프라인 실행 |
| `/resume [taskId]` | 한도 후 재개 |
| `/stop [taskId]` | 작업 중지 |
| `/tasks` | 최근 작업 이력 |

## 파이프라인 흐름

```
사용자 요청
    ↓
📋 Plan  — spec-rN.md 생성
    ↓
🔨 Build — build-log-rN.md 생성
    ↓
🔍 Eval  — eval-report-rN.md 생성
    ↓
PASS → ✅ 완료
FAIL → (maxRounds 이하면) 다음 라운드
```

각 프로젝트 폴더 내 `.harness/` 에 파이프라인 산출물이 저장됩니다.
