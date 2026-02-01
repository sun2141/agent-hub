#!/bin/bash

# 자동 배포 스크립트
# 사용법: bash execution/deploy.sh <project_name> [environment] [platform]

set -e  # 에러 발생 시 즉시 종료

PROJECT_NAME=${1:-prayer-agent}
ENVIRONMENT=${2:-staging}
PLATFORM=${3:-auto}

echo "🚀 배포 시작: $PROJECT_NAME"
echo "환경: $ENVIRONMENT"
echo "플랫폼: $PLATFORM"
echo ""

# 프로젝트 디렉토리 찾기
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$ROOT_DIR/projects/$PROJECT_NAME"

if [ ! -d "$PROJECT_DIR" ]; then
    echo "❌ 프로젝트를 찾을 수 없습니다: $PROJECT_DIR"
    exit 1
fi

cd "$PROJECT_DIR"

# Phase 1: 사전 조건 확인
echo "📋 Phase 1: 사전 조건 확인 중..."

# Git 상태 확인
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    echo "⚠️  경고: Uncommitted changes가 있습니다."
    echo "   변경사항을 커밋하거나 stash 하세요."
fi

# 환경 변수 확인
if [ ! -f ".env" ] && [ ! -f ".env.production" ]; then
    echo "❌ 환경 변수 파일이 없습니다 (.env 또는 .env.production)"
    exit 1
fi

echo "✅ 사전 조건 확인 완료"
echo ""

# Phase 2: 플랫폼 감지
echo "🔍 Phase 2: 배포 플랫폼 감지 중..."

if [ "$PLATFORM" = "auto" ]; then
    if [ -f "vercel.json" ]; then
        PLATFORM="vercel"
    elif [ -f "railway.json" ] || [ -f "Procfile" ]; then
        PLATFORM="railway"
    elif [ -f "Dockerfile" ]; then
        PLATFORM="docker"
    elif [ -f "requirements.txt" ]; then
        PLATFORM="heroku"
    else
        echo "❌ 배포 플랫폼을 감지할 수 없습니다."
        echo "   vercel.json, railway.json, Dockerfile 중 하나가 필요합니다."
        exit 1
    fi
    echo "감지된 플랫폼: $PLATFORM"
fi

echo "✅ 플랫폼: $PLATFORM"
echo ""

# Phase 3: 빌드
echo "🔨 Phase 3: 빌드 중..."

if [ -f "package.json" ]; then
    # Node.js 프로젝트
    if grep -q "\"build\":" package.json; then
        echo "npm run build 실행 중..."
        npm run build

        if [ $? -ne 0 ]; then
            echo "❌ 빌드 실패"
            exit 1
        fi
    else
        echo "ℹ️  빌드 스크립트 없음 (선택사항)"
    fi
fi

echo "✅ 빌드 완료"
echo ""

# Phase 4: 배포
echo "🚀 Phase 4: 배포 실행 중..."

case $PLATFORM in
    vercel)
        echo "Vercel 배포 중..."

        # Vercel CLI 설치 확인
        if ! command -v vercel &> /dev/null; then
            echo "Vercel CLI 설치 중..."
            npm install -g vercel
        fi

        # 배포 실행
        if [ "$ENVIRONMENT" = "production" ]; then
            vercel --prod --yes
        else
            vercel --yes
        fi

        DEPLOY_EXIT_CODE=$?
        ;;

    railway)
        echo "Railway 배포 중..."

        # Railway CLI 설치 확인
        if ! command -v railway &> /dev/null; then
            echo "❌ Railway CLI가 설치되어 있지 않습니다."
            echo "   설치: https://docs.railway.app/develop/cli"
            exit 1
        fi

        railway up
        DEPLOY_EXIT_CODE=$?
        ;;

    heroku)
        echo "Heroku 배포 중..."

        # Heroku CLI 설치 확인
        if ! command -v heroku &> /dev/null; then
            echo "❌ Heroku CLI가 설치되어 있지 않습니다."
            echo "   설치: https://devcenter.heroku.com/articles/heroku-cli"
            exit 1
        fi

        git push heroku main
        DEPLOY_EXIT_CODE=$?
        ;;

    docker)
        echo "Docker 배포 중..."

        # Docker 빌드
        docker build -t "$PROJECT_NAME:latest" .

        if [ $? -ne 0 ]; then
            echo "❌ Docker 빌드 실패"
            exit 1
        fi

        echo "✅ Docker 이미지 빌드 완료"
        echo "   다음 명령으로 실행하세요:"
        echo "   docker run -p 3000:3000 $PROJECT_NAME:latest"
        DEPLOY_EXIT_CODE=0
        ;;

    *)
        echo "❌ 지원하지 않는 플랫폼: $PLATFORM"
        echo "   지원: vercel, railway, heroku, docker"
        exit 1
        ;;
esac

if [ $DEPLOY_EXIT_CODE -ne 0 ]; then
    echo "❌ 배포 실패"
    exit 1
fi

echo "✅ 배포 완료"
echo ""

# Phase 5: 검증 (선택사항)
echo "🔍 Phase 5: 배포 검증 중..."

# 간단한 health check (URL이 있는 경우)
# 실제 환경에서는 배포된 URL로 검증
echo "ℹ️  검증은 수동으로 확인해주세요."
echo ""

# Phase 6: 완료
echo "="================================================
echo "✅ 배포 완료!"
echo ""
echo "프로젝트: $PROJECT_NAME"
echo "환경: $ENVIRONMENT"
echo "플랫폼: $PLATFORM"
echo "시간: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

if [ "$PLATFORM" = "vercel" ]; then
    echo "배포 상태 확인:"
    echo "  vercel ls"
    echo ""
    echo "로그 확인:"
    echo "  vercel logs"
fi

echo "🎉 배포가 성공적으로 완료되었습니다!"
