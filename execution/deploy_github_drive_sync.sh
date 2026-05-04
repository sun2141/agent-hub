#!/bin/bash
# GitHub-Drive Sync 에이전트 VPS 배포 스크립트
# 실행: bash execution/deploy_github_drive_sync.sh

set -e

VPS_HOST="agent@91.99.58.70"
WORKSPACE="~/workspace"
SERVICE_NAME="github-drive-sync"

echo "=== GitHub-Drive Sync 에이전트 VPS 배포 ==="

# 1. VPS에 필요한 패키지 설치
echo "[1/5] 의존성 설치..."
ssh $VPS_HOST "cd $WORKSPACE && pip install \
    fastapi \
    uvicorn[standard] \
    google-api-python-client \
    google-auth \
    google-auth-oauthlib \
    python-dotenv \
    requests \
    --quiet"

# 2. 코드 동기화 (token.json, credentials.json은 별도 전송)
echo "[2/5] 코드 동기화..."
rsync -avz --exclude='.git' --exclude='.tmp' --exclude='.venv' \
    --exclude='node_modules' --exclude='*.pyc' \
    execution/github_drive_webhook.py \
    execution/github_drive_sync.py \
    execution/sync_logger.py \
    execution/drive_auth.py \
    execution/telegram_notifier.py \
    config/ \
    $VPS_HOST:$WORKSPACE/

# 3. 민감 파일 전송 (credentials.json, token.json)
echo "[3/5] 인증 파일 전송..."
if [ -f "credentials.json" ]; then
    scp credentials.json $VPS_HOST:$WORKSPACE/
    echo "  ✓ credentials.json 전송 완료"
else
    echo "  ⚠️  credentials.json 없음 — 건너뜀"
fi

if [ -f "token.json" ]; then
    scp token.json $VPS_HOST:$WORKSPACE/
    echo "  ✓ token.json 전송 완료"
else
    echo "  ⚠️  token.json 없음 — 서버에서 OAuth 플로우 필요"
fi

# 4. .env 파일 (GITHUB_WEBHOOK_SECRET 등 포함 확인)
echo "[4/5] .env 확인..."
if [ -f ".env" ]; then
    scp .env $VPS_HOST:$WORKSPACE/
    echo "  ✓ .env 전송 완료"
else
    echo "  ⚠️  .env 없음 — 서버에서 직접 설정 필요"
    echo "     필요 변수:"
    echo "     - GITHUB_WEBHOOK_SECRET"
    echo "     - GOOGLE_DRIVE_FOLDER_ID"
    echo "     - TELEGRAM_BOT_TOKEN"
    echo "     - TELEGRAM_CHAT_ID"
    echo "     - GITHUB_TOKEN (선택, API rate limit 증가)"
fi

# 5. PM2로 서비스 시작/재시작
echo "[5/5] PM2 서비스 등록..."
ssh $VPS_HOST "
    cd $WORKSPACE
    mkdir -p .tmp

    # 기존 서비스 중지 (있으면)
    pm2 stop $SERVICE_NAME 2>/dev/null || true
    pm2 delete $SERVICE_NAME 2>/dev/null || true

    # 서비스 시작
    pm2 start execution/github_drive_webhook.py \
        --name $SERVICE_NAME \
        --interpreter python3 \
        --cwd $WORKSPACE \
        --log .tmp/webhook.log \
        --time

    pm2 save
    echo '✓ PM2 서비스 시작 완료'
    pm2 show $SERVICE_NAME | grep -E 'status|pid|uptime'
"

echo ""
echo "=== 배포 완료 ==="
echo "Webhook URL: http://91.99.58.70:8080/webhook/github"
echo "헬스 체크:   http://91.99.58.70:8080/health"
echo "현황 조회:   http://91.99.58.70:8080/status"
echo ""
echo "GitHub Webhook 설정:"
echo "  1. 저장소 Settings → Webhooks → Add webhook"
echo "  2. Payload URL: http://91.99.58.70:8080/webhook/github"
echo "  3. Content type: application/json"
echo "  4. Secret: .env의 GITHUB_WEBHOOK_SECRET 값"
echo "  5. Events: Push, Releases"
