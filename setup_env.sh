#!/bin/bash

# Grace-AI Environment Setup Script

echo "======================================"
echo "Grace-AI 환경 변수 설정"
echo "======================================"
echo ""

# Project details
PROJECT_ID="bajdvcdstxzrmoxfvwvj"
PROJECT_URL="https://${PROJECT_ID}.supabase.co"

echo "프로젝트 정보:"
echo "  Project ID: ${PROJECT_ID}"
echo "  Project URL: ${PROJECT_URL}"
echo ""

echo "👉 다음 페이지에서 API Keys를 복사하세요:"
echo "   https://supabase.com/dashboard/project/${PROJECT_ID}/settings/api"
echo ""

# Read API keys
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "API Keys 입력"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

read -p "anon public key를 붙여넣으세요: " ANON_KEY
echo ""
read -p "service_role key를 붙여넣으세요: " SERVICE_ROLE_KEY
echo ""

# Create .env.local
ENV_FILE="/Users/sun/20260128_test/projects/prayer-agent/.env.local"

echo "📝 .env.local 파일 생성 중..."

cat > "$ENV_FILE" << EOF
# Google Gemini API
GOOGLE_API_KEY=AIzaSyDJf4ZbqCJnfWx1F6wCyS3H0s6sTKfXqYg

# Supabase Configuration
VITE_SUPABASE_URL=${PROJECT_URL}
VITE_SUPABASE_ANON_KEY=${ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
EOF

echo "✅ .env.local 파일 생성 완료!"
echo ""

# Vercel environment variables
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Vercel 환경 변수 설정"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

read -p "Vercel 환경 변수도 설정하시겠습니까? (y/n): " SETUP_VERCEL

if [ "$SETUP_VERCEL" = "y" ] || [ "$SETUP_VERCEL" = "Y" ]; then
    cd /Users/sun/20260128_test/projects/prayer-agent

    echo ""
    echo "🚀 Vercel 환경 변수 설정 중..."
    echo ""

    # VITE_SUPABASE_URL
    echo "${PROJECT_URL}" | vercel env add VITE_SUPABASE_URL production

    # VITE_SUPABASE_ANON_KEY
    echo "${ANON_KEY}" | vercel env add VITE_SUPABASE_ANON_KEY production

    # SUPABASE_SERVICE_ROLE_KEY
    echo "${SERVICE_ROLE_KEY}" | vercel env add SUPABASE_SERVICE_ROLE_KEY production

    echo ""
    echo "✅ Vercel 환경 변수 설정 완료!"
    echo ""

    # Ask about deployment
    read -p "지금 바로 배포하시겠습니까? (y/n): " DEPLOY_NOW

    if [ "$DEPLOY_NOW" = "y" ] || [ "$DEPLOY_NOW" = "Y" ]; then
        echo ""
        echo "🚀 Vercel에 배포 중..."
        vercel --prod
        echo ""
        echo "✅ 배포 완료!"
    fi
fi

echo ""
echo "======================================"
echo "설정 완료! 🎉"
echo "======================================"
echo ""
echo "다음 단계:"
echo "1. Google OAuth 설정 (QUICK_SETUP.md 참조)"
echo "2. 로컬 테스트: npm run dev"
echo "3. 프로덕션 테스트: 배포된 URL 접속"
echo ""
