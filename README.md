# agent-hub

AI 에이전트 오케스트레이션 시스템. 두 개의 독립 컴포넌트를 포함합니다.

---

## 레포 구조

```
agent-hub/
├── harness/          ← 활성 하네스 백엔드 (Node.js + Express + SQLite)
│   ├── src/
│   │   ├── index.js  ← 메인 서버 (포트 3000)
│   │   ├── runner.js ← Plan/Build/Eval 파이프라인
│   │   └── ...
│   ├── dashboard/    ← React 대시보드 빌드 결과물 (dist/)
│   └── .env          ← 환경변수 (gitignore)
│
├── directives/       ← Grace AI SOP 마크다운 (레거시)
├── execution/        ← Grace AI Python 스크립트 (레거시)
├── config/           ← 설정 파일
└── tasks/            ← 작업 큐
```

---

## 컴포넌트 관계

```
[프론트엔드]                    [백엔드]
sun2141/harness-dashboard  →  agent-hub/harness/
(Vercel 배포)                  (Mac 로컬 실행, port 3000)
        ↕ REST API + WebSocket
[외부 접근]
VPS (91.99.58.70) nginx → SSH 터널 (9091→3000) → Mac
```

---

## 실행 방법

```bash
# 백엔드 시작
cd harness
node src/index.js

# 대시보드 빌드 (백엔드가 dist/ 서빙)
cd harness/dashboard
npm run build
```

---

## 프론트엔드 (별도 레포)

대시보드 프론트엔드는 별도 레포에서 관리됩니다:
👉 https://github.com/sun2141/harness-dashboard

**Vercel 환경변수 필수:**
- `VITE_API_KEY` — harness/.env의 API_KEY와 동일값
- `VITE_API_BASE` — `http://91.99.58.70` (VPS IP)

---

## 롤백

```bash
# 백업 태그 목록 확인
git tag | grep backup/

# 특정 태그로 복원
git checkout backup/pre-cleanup-YYYYMMDD-HHMMSS
```
