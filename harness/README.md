# Agent Harness

Claude Code 파이프라인(Plan → Build → Eval)을 휴대폰에서 제어하는 오케스트레이션 시스템.

## 구조

```
harness/
├── src/
│   ├── index.js          ← 진입점
│   ├── projects.js       ← 프로젝트 목록 정의
│   ├── db/db.js          ← SQLite 스키마 + 쿼리
│   ├── agent/runner.js   ← 파이프라인 엔진 (Plan→Build→Eval)
│   ├── api/server.js     ← Express REST + WebSocket
│   └── telegram/bot.js   ← 텔레그램 봇
├── scripts/
│   ├── setup.sh          ← 최초 설치
│   └── sync.sh           ← 맥북↔아이맥 동기화
├── data/                 ← SQLite DB (gitignore)
├── .env                  ← 환경변수 (gitignore)
└── .env.example          ← 환경변수 템플릿
```

## 최초 설치

```bash
cd /Users/sun/agent-hub/harness
bash scripts/setup.sh

# .env 설정
nano .env
```

`.env` 필수 항목:
```
API_KEY=임의의_긴_문자열
TELEGRAM_BOT_TOKEN=텔레그램_봇_토큰
TELEGRAM_CHAT_ID=텔레그램_채팅_ID
```

## 실행

```bash
cd /Users/sun/agent-hub/harness
npm start        # 일반 실행
npm run dev      # 개발 모드 (파일 변경 시 자동 재시작)
```

## 맥북 ↔ 아이맥 동기화

**GitHub 레포 설정 (최초 1회):**
1. https://github.com/new 에서 `agent-hub` 레포 생성
2. 아이맥에서:
```bash
cd /Users/sun/agent-hub
git remote set-url origin https://github.com/sun2141/agent-hub.git
git push -u origin main
```
3. 맥북에서:
```bash
git clone https://github.com/sun2141/agent-hub.git
cd agent-hub/harness
cp .env.example .env && nano .env  # 동일한 값 입력
npm install
```

**매일 사용:**
```bash
# 작업 시작 전 (최신 코드 받기)
bash harness/scripts/sync.sh pull

# 작업 완료 후 (업로드)
bash harness/scripts/sync.sh push "기능 추가"
```

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | /api/status | 하네스 전체 상태 |
| GET | /api/projects | 프로젝트 목록 |
| POST | /api/run | 파이프라인 시작 |
| POST | /api/resume | 일시정지 재개 |
| DELETE | /api/stop/:taskId | 작업 중지 |
| GET | /api/tasks | 최근 작업 목록 |
| GET | /api/tasks/:id | 작업 상세 + 로그 |

WebSocket: `ws://localhost:3000/ws?key=API_KEY`

## 텔레그램 명령어

| 명령어 | 설명 |
|--------|------|
| /help | 명령어 목록 |
| /status | 실행 중인 작업 상태 |
| /projects | 프로젝트 목록 |
| /run palmoni 기능 추가 | 파이프라인 시작 |
| /resume task_xxx | rate limit 후 재개 |
| /stop task_xxx | 작업 중지 |
| /tasks | 최근 작업 이력 |

## 주의사항

- `harness/data/` 와 `harness/.env` 는 git에 올라가지 않음
- 맥북과 아이맥 각각 `.env` 파일을 별도로 설정해야 함
- Telegram 봇 토큰은 한 곳에서만 polling해야 충돌 없음
  - 현재 VPS 봇이 있다면, 하네스용 봇은 별도 토큰 사용 권장
