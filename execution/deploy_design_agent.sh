#!/bin/bash
#
# Design Agent VPS 배포 스크립트
# 사용법: ./deploy_design_agent.sh
#

set -e

VPS_HOST="91.99.58.70"
VPS_USER="sun"
REMOTE_DIR="/home/sun/workspace/orchestrator"

echo "🚀 Design Agent 배포 시작"

# 1. 필요 파일 복사
echo "📦 파일 전송 중..."
scp execution/design_agent.py ${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/scripts/
scp execution/telegram_design_handler.py ${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/scripts/
scp directives/agents/design_agent.md ${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/directives/

# 2. 원격 설정
echo "⚙️ 원격 설정 중..."
ssh ${VPS_USER}@${VPS_HOST} << 'ENDSSH'
cd /home/sun/workspace/orchestrator

# 필요한 Python 패키지 설치
pip3 install python-telegram-bot --quiet

# .env 파일에 PALMONI_PATH 추가 (없으면)
if ! grep -q "PALMONI_PATH" .env 2>/dev/null; then
    echo "PALMONI_PATH=/home/sun/workspace/palmoni" >> .env
fi

# 임시 디렉토리 생성
mkdir -p /home/sun/workspace/.tmp/design_drafts

# PM2 프로세스 재시작
cd scripts
if pm2 list | grep -q "design-bot"; then
    pm2 restart design-bot
else
    pm2 start telegram_design_handler.py --name design-bot --interpreter python3
fi

pm2 save

echo "✅ Design Agent 설정 완료"
ENDSSH

echo ""
echo "✅ 배포 완료!"
echo ""
echo "📋 사용 방법:"
echo "  Telegram에서 /design <요청> 으로 디자인 작업 요청"
echo ""
echo "예시:"
echo "  /design 로그인 버튼 더 둥글게"
echo "  /design status"
echo "  /design approve"
echo "  /design commit"
