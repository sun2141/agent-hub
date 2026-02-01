#!/bin/bash

# grace-ai 원스톱 설정 스크립트

echo "🚀 grace-ai 자동화 설정을 시작합니다..."

# 1. 의존성 확인 및 설치
echo "📦 1. 의존성 설치 중..."
npm install
pip install google-generativeai python-dotenv

# 2. .env 파일 설정
if [ ! -f .env ]; then
    echo "🔑 2. API 키가 설정되지 않았습니다."
    read -p "Google Gemini API Key를 입력해주세요: " api_key
    echo "GOOGLE_API_KEY=$api_key" > .env
    echo "✅ .env 파일이 생성되었습니다."
else
    echo "✅ 이미 .env 파일이 존재합니다."
fi

# 3. 프로젝트 폴더 구조화 (필요 시)
if [ ! -d "projects/prayer-agent" ]; then
    echo "📂 3. 프로젝트 폴더 구조를 재편성합니다..."
    mkdir -p projects/prayer-agent/src
    mkdir -p projects/prayer-agent/execution
    
    # 파일 이동 (기존 파일이 있는 경우)
    mv src/* projects/prayer-agent/src/ 2>/dev/null
    mv execution/* projects/prayer-agent/execution/ 2>/dev/null
    mv server.js projects/prayer-agent/ 2>/dev/null
    mv index.html projects/prayer-agent/ 2>/dev/null
    mv package.json projects/prayer-agent/ 2>/dev/null
    
    # 루트에 통합 관리 패키지 생성 제안
    echo "✅ 폴더 구조 재편성 완료."
fi

echo "✨ 모든 설정이 완료되었습니다!"
echo "💡 서버를 실행하려면 다음 명령어를 입력하세요:"
echo "   (프로젝트 폴더로 이동 후) npm run server & npm run dev"
