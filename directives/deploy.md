# 지침: 자동 배포 (deploy)

이 지침은 프로젝트를 자동으로 배포하는 과정을 정의합니다.

## 목표
테스트 통과 후 프로덕션 환경에 안전하게 자동 배포하고, 실패 시 롤백합니다.

## 입력 항목
- `project_name`: 배포할 프로젝트 (기본값: prayer-agent)
- `environment`: 배포 환경 (dev/staging/production, 기본값: staging)
- `platform`: 배포 플랫폼 (vercel/railway/heroku/fly, 자동 감지)

## 사전 조건 (자동 확인)

```
✅ 모든 테스트 통과
✅ Git 커밋 완료 (uncommitted changes 없음)
✅ 환경 변수 설정 완료
✅ 빌드 성공
```

**하나라도 실패 시: 배포 중단 + 사용자에게 알림**

## 배포 전략

### 1. Staging First (기본)
```
1. Staging 배포 → 2. Smoke Test → 3. Production 배포
```

### 2. Canary (선택)
```
1% 트래픽 → 10% → 50% → 100%
```

### 3. Blue-Green (선택)
```
Green 환경 배포 → 검증 → 트래픽 전환 → Blue 환경 제거
```

## 자동 플랫폼 감지

```javascript
// 우선순위 순서
1. vercel.json 존재 → Vercel
2. railway.json 또는 Procfile → Railway
3. Dockerfile → Docker/Fly.io
4. requirements.txt + Python → Heroku
```

## 배포 단계

### Phase 1: 준비 (자동)
```bash
# 1. 현재 상태 확인
git status

# 2. 최신 코드 동기화
git pull origin main

# 3. 의존성 재설치
npm ci  # 또는 pip install -r requirements.txt

# 4. 환경 변수 검증
source .env.production
echo "환경 변수 개수: $(env | wc -l)"
```

### Phase 2: 빌드 (자동)
```bash
# Node.js
npm run build

# Python (필요 시)
python -m compileall .
```

**빌드 실패 시: 배포 중단**

### Phase 3: 배포 (자동)

#### Vercel
```bash
# CLI 설치 확인
which vercel || npm install -g vercel

# 배포 실행
vercel --prod --yes

# 배포 URL 저장
DEPLOY_URL=$(vercel inspect --json | jq -r '.url')
```

#### Railway
```bash
railway up
```

#### Heroku
```bash
git push heroku main
```

#### Custom (SSH)
```bash
rsync -avz --delete dist/ user@server:/var/www/app/
ssh user@server "pm2 restart app"
```

### Phase 4: 검증 (자동)

```bash
# Smoke Tests
1. Health Check: GET /api/health
2. 주요 엔드포인트 테스트: GET /api/generate-prayer
3. 응답 시간 확인: < 2초
4. 에러율 확인: < 1%
```

**검증 실패 시: 자동 롤백**

### Phase 5: 롤백 (필요 시)

```bash
# Vercel
vercel rollback <previous-deployment-id>

# Railway
railway rollback

# Git 기반
git revert HEAD
git push origin main
```

## 배포 후 작업 (자동)

```
1. 슬랙/이메일 알림
2. 배포 로그 저장 (.tmp/deploys/)
3. 성능 모니터링 시작
4. Git 태그 생성: v1.2.3
```

## 환경별 설정

### Development
- 자동 배포: 매 커밋
- 테스트: Unit만
- 도메인: dev.grace-ai.com

### Staging
- 자동 배포: main 브랜치 머지 시
- 테스트: 전체
- 도메인: staging.grace-ai.com

### Production
- 수동 승인 필요
- 테스트: 전체 + E2E
- 도메인: grace-ai.com

## 보안 체크리스트 (자동)

```
- [ ] API 키가 코드에 하드코딩되지 않았는지
- [ ] .env 파일이 .gitignore에 포함되었는지
- [ ] CORS 설정이 올바른지
- [ ] HTTPS 강제 적용
- [ ] Rate Limiting 설정
```

## 실행 스크립트 호출

```bash
# Bash 실행 스크립트
bash execution/deploy.sh <project_name> [environment] [platform]

# 내부 로직:
# 1. 사전 조건 확인
# 2. 플랫폼 감지 또는 선택
# 3. 빌드
# 4. 배포
# 5. 검증
# 6. 알림
```

## 출력 형식

### 성공 시
```
🚀 배포 완료: prayer-agent → Production

URL: https://grace-ai.com
상태: ✅ 정상
응답 시간: 243ms
배포 ID: dpl_abc123xyz

커밋: a1b2c3d "feat: add new prayer feature"
시간: 2026-02-02 12:34:56
소요 시간: 2분 15초
```

### 실패 시
```
❌ 배포 실패: prayer-agent

단계: Phase 4 - 검증
원인: Health check 실패 (502 Bad Gateway)

자동 조치: 이전 버전으로 롤백 완료
현재 상태: https://grace-ai.com (정상)

필요한 조치:
- 서버 로그 확인
- 의존성 충돌 검사
```

## 비용 최적화

### Vercel (무료 한도)
- 빌드 시간: 100시간/월
- 대역폭: 100GB/월
- 함수 실행: 100만 호출/월

**초과 시: 사용자에게 알림**

### Railway (무료 티어)
- 500시간/월
- 메모리: 512MB

## CI/CD 통합 (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Auto Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run Tests
        run: python execution/run_tests.py prayer-agent
      - name: Deploy
        run: bash execution/deploy.sh prayer-agent production vercel
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

## 모니터링

배포 후 자동으로 다음을 추적:
- 에러율 (Sentry)
- 응답 시간 (Vercel Analytics)
- 사용자 수 (Google Analytics)
- API 사용량 (Gemini Dashboard)

**임계값 초과 시: 자동 알림**

## 학습 내용 (Learnings)

### 공통 배포 실패 원인
1. 환경 변수 누락 → 플랫폼 대시보드에서 설정
2. 빌드 시간 초과 → 캐싱 활용
3. 메모리 부족 → 인스턴스 크기 증가 또는 최적화

### 최적화 팁
- 정적 파일 CDN 사용
- 이미지 최적화 (WebP, lazy loading)
- 번들 사이즈 줄이기 (Tree shaking)
- API 응답 캐싱
