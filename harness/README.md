# Agent Harness

Claude Code 파이프라인(Plan → Build → Eval)을 휴대폰에서 제어하는 오케스트레이션 시스템.

## 구조

```
harness/
├── src/
│   ├── index.js          ← 진입점
│   ├── projects.js       ← 프로젝트 목록 정의
│   ├── db/db.js          ← Neon DB 스키마 + 쿼리
│   ├── agent/runner.js   ← 파이프라인 엔진 (Plan→Build→Eval)
│   ├── api/server.js     ← Express REST + WebSocket
│   ├── telegram/bot.js       ← 텔레그램 봇
│   └── telegram/deploy_worker.js ← 분리 배포 워커
├── scripts/
│   ├── setup.sh              ← 최초 설치
│   ├── start.sh              ← 백그라운드 기동/종료/상태 확인
│   ├── sync.sh               ← 맥북↔아이맥 동기화
│   └── deploy_detached.sh    ← 분리 배포 스크립트 (self-kill 방지)
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
NEON_DATABASE_URL=postgresql://...-pooler.../neondb?sslmode=require
TELEGRAM_BOT_TOKEN=텔레그램_봇_토큰
TELEGRAM_CHAT_ID=텔레그램_채팅_ID
```

## 실행

```bash
cd /Users/sun/agent-hub/harness
npm start            # 포그라운드 실행 (로그 바로 확인)
npm run start:bg     # 백그라운드 실행 (nohup, harness.pid 생성)
npm run status       # 실행 여부 확인
npm run stop         # 하네스 종료
npm run dev          # 개발 모드 (파일 변경 시 자동 재시작)
PATH=/Users/sun/.nvm/versions/node/v22.22.2/bin:$PATH npm run db:health  # Neon DB 운영 점검
```

백그라운드 실행 스크립트 직접 사용:
```bash
bash scripts/start.sh          # 백그라운드 기동
bash scripts/start.sh status   # 실행 여부 확인
bash scripts/start.sh stop     # 종료
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
| POST | /api/deploy | git push + harness 재시작 (웹훅) |

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
| /deploy | git push + harness 재시작 (분리 프로세스) |

## 배포 자동화

### /deploy 명령어 (텔레그램)

텔레그램에서 `/deploy` 명령을 보내면 git push + 하네스 재시작이 자동으로 수행됩니다.

```
/deploy
```

웹훅으로도 동일한 동작을 트리거할 수 있습니다:

```bash
curl -X POST http://localhost:3000/api/deploy \
  -H "x-api-key: YOUR_API_KEY"
```

### 자동화 실패 원인 분석 (self-kill 문제)

**문제:** 하네스 eval 합격 시 `deploy.sh`를 `execSync`로 호출하면 `pm2 reload`나 `kill` 명령이 자기 자신(harness 프로세스)을 종료하는 self-kill이 발생한다.

**원인 상세:**

1. `runner.js`의 `_runCommitAndDeploy()`가 `execSync('bash deploy.sh')`를 동기 호출
2. `deploy.sh`에서 `DEPLOY_METHOD=pm2` 또는 `DEPLOY_METHOD=node`이면 harness 자신을 `pm2 reload` 또는 `kill`로 종료
3. harness 프로세스가 죽으면 `execSync` 자체가 중단되고 이후 코드 실행 불가
4. 결과: git push까지는 성공하더라도 재시작 직후 프로세스가 사라져 실패처럼 보임

**해결 방법:**

`deploy.sh`는 `DEPLOY_METHOD=push`(git push만, 재시작 없음)로 설정하고,
harness 재시작이 필요할 때는 텔레그램 `/deploy` 명령 또는 `POST /api/deploy` 웹훅을 사용한다.

이 두 경로는 `deploy_detached.sh`를 `{ detached: true }` 옵션으로 분리 자식 프로세스에서 실행하므로,
harness가 종료된 후에도 자식 프로세스가 재시작을 완료한다.

**`.env` 권장 설정:**

```
DEPLOY_METHOD=push
```

**배포 흐름 (안전한 경로):**

```
텔레그램 /deploy
  → bot.js onCommand(/\/deploy/)
  → spawnDetached()  [detached: true, unref()]
  → deploy_detached.sh (부모 종료 후에도 실행 계속)
      1. git add -A && git commit
      2. git push origin main
      3. pm2 reload harness  (또는 nohup node 재시작)
```

## 주의사항

- `harness/data/` 와 `harness/.env` 는 git에 올라가지 않음
- 운영 데이터는 Neon Postgres의 `harness` 스키마에 저장됨
- VPS에서는 Node 22가 먼저 잡히도록 `PATH=/Users/sun/.nvm/versions/node/v22.22.2/bin:$PATH`를 붙여 실행
- 맥북과 아이맥 각각 `.env` 파일을 별도로 설정해야 함
- Telegram 봇 토큰은 한 곳에서만 polling해야 충돌 없음
  - 현재 VPS 봇이 있다면, 하네스용 봇은 별도 토큰 사용 권장
- `DEPLOY_METHOD=pm2` 또는 `DEPLOY_METHOD=node`는 harness 내부에서 호출 시 self-kill 위험 — `push`만 사용 권장
- harness 재시작이 필요하면 반드시 텔레그램 `/deploy` 또는 `POST /api/deploy` 사용
