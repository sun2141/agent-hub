# GitHub ↔ Google Drive 양방향 동기화 에이전트

## 개요
GitHub push 이벤트와 Google Drive 폴더 변경사항을 **양방향**으로 동기화하는 에이전트.

## 아키텍처

```
GitHub Webhook (push)
    │
    ▼
execution/github_drive_webhook.py  ← FastAPI 서버 (포트 8080)
    │
    ├─► [무한루프 방지] [drive-sync] 커밋이면 Drive 재동기화 스킵
    │
    ├─► execution/github_drive_sync.py  ← GitHub→Drive 동기화 엔진
    │       │
    │       ├─► Google Drive API (업로드/업데이트/삭제)
    │       └─► execution/sync_logger.py  ← 로그/상태 추적
    │
    └─► execution/telegram_notifier.py  ← 알림 발송

Drive Watch API (실시간, DRIVE_WATCH_WEBHOOK_URL 설정 시 활성화)
    │
    Google Drive 변경 → POST /webhook/drive
    │
    ▼
DriveWatchManager.process_watch_notification()
    │
    ├─► Changes API로 실제 변경 파일 조회
    └─► drive_github_sync.py: sync_drive_to_github()

Drive 폴링 루프 (안전망, DRIVE_POLL_INTERVAL_SECONDS 간격으로 항상 병행)
    │
    ▼
execution/drive_github_sync.py  ← Drive→GitHub 동기화 엔진
    │
    ├─► Drive API: 폴더 재귀 탐색 → 변경 파일 감지 (modifiedTime 비교)
    ├─► 충돌 감지: GitHub 최신 커밋 확인
    ├─► GitHub Contents API: 파일 커밋 ([drive-sync] 태그 포함)
    └─► execution/sync_logger.py  ← Drive 파일 상태 추적
```

## 입력

- **GitHub Webhook 이벤트**: push, pull_request, release
- **Drive Watch 알림**: `/webhook/drive` 엔드포인트로 Google이 전송 (Watch API 활성화 시)
- **설정 파일**: `config/repo_drive_mapping.json` — 저장소 ↔ Drive 폴더 매핑
- **환경 변수** (`.env`):
  - `GITHUB_WEBHOOK_SECRET` — Webhook HMAC 서명 검증
  - `GITHUB_TOKEN` — GitHub API 토큰 (Drive→GitHub 동기화에 필수)
  - `GOOGLE_DRIVE_FOLDER_ID` — grace-ai 저장소 Drive 폴더
  - `GOOGLE_DRIVE_FOLDER_ID_PALMONI` — palmoni 저장소 Drive 폴더
  - `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — 알림
  - `WEBHOOK_PORT` — 서버 포트 (기본 8080)
  - `DRIVE_POLL_INTERVAL_SECONDS` — Drive 폴링 간격 (기본 300초)
  - `DRIVE_WATCH_WEBHOOK_URL` — Watch API 콜백 URL (미설정 시 폴링 전용 모드)

## 출력

- Google Drive에 동기화된 파일 (GitHub → Drive)
- GitHub 저장소에 커밋된 파일 (Drive → GitHub)
- `.tmp/sync_state.json` — 파일별 마지막 동기화 SHA 및 Drive ID
- `.tmp/sync_log.jsonl` — 동기화 이력 (JSON Lines)
- 텔레그램 알림 (성공/실패/충돌)

## 실행 스크립트

| 스크립트 | 역할 |
|---------|------|
| `execution/github_drive_webhook.py` | FastAPI 서버 + Drive 폴링 루프 |
| `execution/github_drive_sync.py` | GitHub→Drive 동기화 엔진 |
| `execution/drive_github_sync.py` | Drive→GitHub 동기화 엔진 |
| `execution/sync_logger.py` | 로그/상태 관리 (양방향) |
| `execution/drive_auth.py` | Google OAuth2 인증 |
| `execution/telegram_notifier.py` | 알림 발송 (충돌/성공/실패) |
| `execution/test_sync_integration.py` | 통합 테스트 (30개) |

## 저장소-폴더 매핑 (`config/repo_drive_mapping.json`)

```json
{
  "repositories": {
    "owner/repo": {
      "drive_folder_id": "${ENV_VAR_NAME}",
      "sync_paths": ["execution/", "directives/"],
      "exclude_patterns": ["*.pyc", "__pycache__/", ".tmp/"],
      "description": "설명"
    }
  },
  "defaults": {
    "max_file_size_mb": 50,
    "retry_attempts": 3,
    "retry_backoff_seconds": [1, 2, 4]
  }
}
```

`drive_folder_id`는 환경 변수 참조(`${VAR}`) 또는 직접 입력 가능.

## 동기화 전략

### GitHub → Drive
1. Webhook payload에서 `commits[].added/modified/removed` 추출
2. `.tmp/sync_state.json`의 파일 SHA와 비교 (Delta sync)
3. GitHub Contents API로 파일 내용 다운로드
4. Drive API로 업로드/업데이트/삭제 (폴더 구조 유지)
5. 성공 시 sync_state 업데이트

### Drive → GitHub
1. 서버 시작 시 백그라운드 폴링 루프 시작 (기본 5분 간격)
2. Drive 폴더 재귀 탐색 → modifiedTime 비교
3. 변경 파일만 GitHub Contents API로 커밋
4. 커밋 메시지에 `[drive-sync]` 태그 포함
5. 성공 시 drive_modified_time 및 github_sync_sha 업데이트

## 무한루프 방지

| 방향 | 방지 방법 |
|------|---------|
| GitHub → Drive → GitHub | Drive 동기화 커밋에 `[drive-sync]` 태그 포함; Webhook 수신 시 모든 커밋이 `[drive-sync]`이면 Drive 재업로드 스킵 |
| Drive → GitHub → Drive | GitHub push에서 변경된 파일의 Drive modifiedTime이 마지막 Drive sync 이후가 아니면 스킵 |

## 충돌 처리 전략

**충돌 정의**: GitHub와 Drive 양쪽에서 마지막 동기화 이후 동일 파일 변경

**처리 방식**: Drive 버전 우선 (Drive wins)
1. 충돌 감지 시 Telegram 알림 전송
2. Drive 버전을 GitHub에 커밋 (강제 적용)
3. `.tmp/sync_log.jsonl`에 충돌 이벤트 기록

## HTTP 엔드포인트

| 경로 | 메서드 | 설명 |
|------|-------|------|
| `/webhook/github` | POST | GitHub Webhook 수신 (HMAC-SHA256 서명 검증) |
| `/webhook/drive` | POST | Drive Watch Push Notification 수신 |
| `/health` | GET | 헬스 체크 (업타임, 설정 상태) |
| `/status` | GET | JSON 동기화 통계 |
| `/logs?n=50` | GET | 최근 로그 조회 |
| `/dashboard` | GET | HTML 대시보드 (30초 자동 갱신) |
| `/poll` | POST | Drive 수동 폴링 트리거 |
| `/mappings` | GET | 저장소-폴더 매핑 현황 |
| `/watch/status` | GET | Drive Watch 채널 현황 |
| `/watch/register` | POST | Watch 채널 수동 등록 |

## 바이너리 파일 처리

- **확장자 기반 감지**: `.png`, `.pdf`, `.zip`, `.woff2` 등 50종
- **base64 인코딩**: 바이너리 파일도 GitHub Contents API에 base64로 업로드
- **Google Native 파일**: Docs → text/plain, Sheets → text/csv로 export
- **크기 제한**: 50MB 초과 시 스킵 (로그 기록)

## Drive 폴더 구조 유지

GitHub 파일 경로 `execution/sync_logger.py` → Drive에서:
```
Drive 루트 폴더/
└── execution/
    └── sync_logger.py
```
중간 폴더가 없으면 자동 생성.

## 재시도 로직

- 최대 3회 재시도
- 지수 백오프: 1초, 2초, 4초
- Rate limit (429): 즉시 대기 후 재시도 + Telegram 알림
- 최종 실패 시 Telegram 알림

## VPS 배포

```bash
# VPS에서 실행
cd ~/workspace
source .venv/bin/activate
python execution/github_drive_webhook.py

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

## 테스트

```bash
# 통합 테스트 (30개, API 없이 Mock 기반)
python execution/test_sync_integration.py --verbose

# Drive 수동 폴링 테스트
python execution/drive_github_sync.py --poll

# Drive 인증 확인
python execution/drive_auth.py
```

## Drive Watch API (실시간 Push Notification)

폴링 방식보다 빠른 실시간 변경 감지를 위해 Google Drive Watch API를 사용할 수 있습니다.

### 활성화 방법

```bash
# .env에 추가
DRIVE_WATCH_WEBHOOK_URL=https://your-server-domain.com
```

- 공개 HTTPS URL이 필요합니다 (localhost 불가, VPS 도메인 또는 ngrok 사용)
- 미설정 시 폴링 모드로 자동 폴백 (기능은 동일, 실시간성만 차이)

### Watch API 동작 방식

1. 서버 시작 시 매핑된 모든 Drive 폴더에 Watch 채널 등록
2. Drive 파일 변경 → Google이 `/webhook/drive` 로 즉시 POST 전송
3. 서버는 Changes API로 실제 변경 파일 목록 조회
4. Drive→GitHub 동기화 실행
5. Watch 채널은 23시간마다 자동 갱신

### 제약사항

- 공개 HTTPS 엔드포인트 필수
- Watch 알림은 "변경 발생" 신호만 포함 (변경 파일 목록은 Changes API 별도 조회)
- 폴링은 Watch API 활성화 시에도 안전망으로 병행 유지

## 알려진 제약사항

- Google Drive API: 100MB 이상 파일은 resumable upload 필요 (현재 미지원, 50MB 제한)
- GitHub API rate limit: 5000 req/hr (인증 시)
- **Drive 스코프**: `drive` 스코프 필요 (기존 `drive.file`로 발급된 token.json은 재인증 필요)
  - `drive.file` 스코프는 앱이 만든 파일만 접근 가능 → 사용자가 직접 Drive에 추가한 파일 접근 불가
  - 재인증: `rm token.json && python execution/drive_auth.py`
- Drive Watch API는 polling 방식과 병행 운영 (안전망 역할)

## 학습 메모

- `[drive-sync]` 태그는 커밋 메시지 첫 줄에 포함해야 무한루프 방지 필터에서 감지됨
- Drive→GitHub 동기화 시 `GITHUB_TOKEN` 필수 (write 권한 필요)
- VPS 환경에서 Google OAuth 초기 인증은 로컬에서 먼저 수행 후 token.json 복사
- Drive modifiedTime은 UTC ISO 8601 형식 (예: `2026-05-04T10:00:00.000Z`)
