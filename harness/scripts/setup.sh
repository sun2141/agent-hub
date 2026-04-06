#!/bin/bash
# scripts/setup.sh
# 최초 설치 시 한 번만 실행

set -e
HARNESS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "═══════════════════════════════════"
echo "  Agent Harness 설치"
echo "═══════════════════════════════════"

# .env 생성
if [ ! -f "$HARNESS_DIR/.env" ]; then
  cp "$HARNESS_DIR/.env.example" "$HARNESS_DIR/.env"
  echo "[1/3] .env 파일 생성됨 → 값을 입력하세요: nano $HARNESS_DIR/.env"
else
  echo "[1/3] .env 이미 존재"
fi

# npm install
echo "[2/3] 패키지 설치 중..."
cd "$HARNESS_DIR" && npm install

# data 디렉토리
mkdir -p "$HARNESS_DIR/data"
echo "[3/3] data 디렉토리 생성됨"

echo ""
echo "✅ 설치 완료!"
echo ""
echo "다음 단계:"
echo "  1. .env 수정: nano $HARNESS_DIR/.env"
echo "  2. 실행: npm start"
echo "  3. 개발 모드: npm run dev"
