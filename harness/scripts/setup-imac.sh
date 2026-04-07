#!/bin/bash
# 아이맥 최초 설치 스크립트
# 실행: bash harness/scripts/setup-imac.sh

set -e
HARNESS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "═══════════════════════════════════"
echo "  Agent Harness - 아이맥 설치"
echo "═══════════════════════════════════"

# 1. npm install
echo "[1/3] 패키지 설치 중..."
cd "$HARNESS_DIR"

# Xcode 라이선스 확인
if ! xcodebuild -license check 2>/dev/null; then
  echo "⚠️  Xcode 라이선스 동의 필요..."
  sudo xcodebuild -license accept
fi

npm install
echo "✅ 패키지 설치 완료"

# 2. .env 생성
echo ""
echo "[2/3] .env 파일 생성 중..."

if [ -f "$HARNESS_DIR/.env" ]; then
  echo "⚠️  .env 이미 존재 — 덮어쓰지 않음"
else
  CLAUDE_PATH=$(which claude 2>/dev/null || echo "claude")
  cp "$HARNESS_DIR/.env.example" "$HARNESS_DIR/.env"
  # CLAUDE_CLI_PATH만 자동 감지해서 채움
  sed -i '' "s|CLAUDE_CLI_PATH=|CLAUDE_CLI_PATH=${CLAUDE_PATH}|" "$HARNESS_DIR/.env"
  echo "✅ .env 생성됨 (CLAUDE_CLI_PATH: $CLAUDE_PATH)"
  echo ""
  echo "⚠️  다음 값을 직접 입력해야 합니다:"
  echo "   nano $HARNESS_DIR/.env"
  echo ""
  echo "   필요한 값은 맥북의 harness/.env 파일 참조"
fi

echo ""
echo "[3/3] 완료!"
echo "실행: cd $HARNESS_DIR && npm start"
