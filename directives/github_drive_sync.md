# GitHub → Google Drive 동기화 에이전트

## 개요
GitHub push/PR/release 이벤트를 수신하여 변경된 파일을 Google Drive에 자동 동기화하는 에이전트.

## 아키텍처

```
GitHub Webhook
    │
    ▼
execution/github_drive_webhook.py  ← FastAPI 서버 (포트 8080)
    │
    ├─► execution/github_drive_sync.py  ← 파일 동기화 엔진
    │       │
    │       ├─► Google Drive API (업로드/업데이트/삭제)
    │       └─► execution/sync_logger.py  ← 로그/상태 추적
    │
    └─► execution/telegram_notifier.py  ← 알림 발송
```

## 입력

- **GitHub Webhook 이벤트**: push, pull_request, release
- **설정 파일**: `config/repo_drive_mapping.json` — 저장소 ↔ Drive 폴더 매핑
- **환경 변수** (`.env`):
  - `GITHUB_WEBHOOK_SECRET` — Webhook HMAC 서명 검증
  - `GOOGLE_DRIVE_FOLDER_ID` — 기본 Drive 폴더 (매핑 없을 때 fallback)
  - `TELEGRAM_BOT_TOKEN` — 텔레그램 봇 토큰
  - `TELEGRAM_CHAT_ID` — 알림 받을 채팅 ID
  - `WEBHOOK_PORT` — 서버 포트 (기본 8080)

## 출력

- Google Drive에 동기화된 파일
- `.tmp/sync_state.json` — 파일별 마지막 동기화 SHA 및 Drive ID
- `.tmp/sync_log.jsonl` — 동기화 이력 (JSON Lines)
- 텔레그램 알림 메시지

## 실행 스크립트

| 스크립트 | 역할 |
|---------|------|
| `execution/github_drive_webhook.py` | FastAPI webhook 서버 |
| `execution/github_drive_sync.py` | Drive 동기화 엔진 |
| `execution/sync_logger.py` | 로그/상태 관리 |
| `execution/drive_auth.py` | Google OAuth2 인증 |

## 저장소-폴더 매핑 (`config/repo_drive_mapping.json`)

```json
{
  "sun2141/grace-ai": {
    "drive_folder_id": "FOLDER_ID_HERE",
    "sync_paths": ["execution/", "directives/"],
    "exclude_patterns": ["*.pyc", "__pycache__", ".tmp/"]
  }
}
```

## Delta Sync 전략

1. Webhook payload에서 `commits[].added`, `commits[].modified`, `commits[].removed` 추출
2. `.tmp/sync_state.json`의 파일 SHA와 비교하여 실제 변경분만 처리
3. GitHub Contents API로 파일 내용 다운로드
4. Drive API로 업로드/업데이트/삭제
5. 성공 시 sync_state 업데이트

## 재시도 로직

- 최대 3회 재시도
- 지수 백오프: 1초, 2초, 4초
- 실패 시 텔레그램으로 에러 알림

## OAuth2 토큰 갱신

- `drive_auth.py`가 `token.json`을 자동 관리
- 만료 전 자동 갱신 (google-auth-oauthlib)
- 갱신 실패 시 텔레그램 알림 + 로그 기록

## VPS 배포

```bash
# VPS에서 실행
cd ~/workspace
source .venv/bin/activate
python execution/github_drive_webhook.py &

# PM2로 상시 실행
pm2 start execution/github_drive_webhook.py --name github-drive-sync --interpreter python3
pm2 save
```

## Webhook 설정 (GitHub)

1. 저장소 Settings → Webhooks → Add webhook
2. Payload URL: `http://91.99.58.70:8080/webhook/github`
3. Content type: `application/json`
4. Secret: `.env`의 `GITHUB_WEBHOOK_SECRET` 값
5. Events: Push, Pull requests, Releases

## 알려진 제약사항

- Google Drive API: 100MB 이상 파일은 resumable upload 필요 (현재 미지원)
- GitHub API rate limit: 5000 req/hr (인증 시)
- Drive API quota: 1,000,000,000 files/day
- token.json에 `https://www.googleapis.com/auth/drive.file` 스코프 필요

## 학습 메모

- (이 섹션에 운영 중 발견한 내용 추가)
