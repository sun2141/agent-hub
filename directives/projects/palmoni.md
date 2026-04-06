# Palmoni Project Directive

## Project Info

- **ID**: palmoni
- **Name**: Palmoni 기도앱
- **Path**: `/Users/sun/palmoni/`
- **GitHub**: sun2141/palmoni
- **Deploy**: palmoni.vercel.app (Vercel)

## Tech Stack

- Frontend: React 18 + Vite + Tailwind CSS
- Backend: Vercel Serverless Functions
- Database: Supabase (PostgreSQL + Auth)
- APIs: Google Gemini, Google TTS, Stripe

## Monitoring Rules

### Health Check
- URL: `https://palmoni.vercel.app/api/test`
- Interval: 5분
- Alert: 3회 연속 실패 시 텔레그램 알림

### Error Patterns
- Supabase 연결 오류 → DB 연결 확인
- Stripe webhook 실패 → 시크릿 키 만료 확인
- Gemini API 오류 → 쿼타/키 확인

## Auto-Fix Rules

1. **빌드 실패**:
   - `npm run build` 에러 로그 분석
   - TypeScript/ESLint 에러 자동 수정 시도

2. **배포 실패**:
   - Vercel 로그 확인
   - 환경 변수 누락 체크

3. **런타임 에러**:
   - Vercel Function 로그 분석
   - 최근 커밋과 비교하여 롤백 판단

## Sync with VPS

Hetzner VPS의 `~/workspace/prayer-app/`과 동기화:
- 로컬 → VPS: `git push` 시 자동
- VPS → 로컬: 수동 (필요 시)

## Related Directives

- `directives/deploy.md` - 배포 워크플로우
- `directives/run_tests.md` - 테스트 실행
- `directives/generate_prayer.md` - 기도문 생성 로직
