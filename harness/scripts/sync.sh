#!/bin/bash
# scripts/sync.sh
# 작업 시작 전: bash scripts/sync.sh pull
# 작업 완료 후: bash scripts/sync.sh push "커밋 메시지"

set -e
HARNESS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HARNESS_DIR/.."  # agent-hub 루트

ACTION=${1:-"status"}
MESSAGE=${2:-"harness: 작업 업데이트 $(date '+%Y-%m-%d %H:%M')"}

case "$ACTION" in
  pull)
    echo "📥 최신 코드 가져오는 중..."
    git pull origin main
    echo "✅ 동기화 완료"
    ;;
  push)
    echo "📤 변경사항 업로드 중..."
    git add harness/
    git status --short
    git diff --cached --quiet && echo "변경사항 없음" && exit 0
    git commit -m "$MESSAGE"
    git push origin main
    echo "✅ 업로드 완료"
    ;;
  status)
    git status --short harness/
    ;;
  *)
    echo "사용법: bash scripts/sync.sh [pull|push|status] [커밋메시지]"
    ;;
esac
