# Phase 2 Setup Guide
**Grace-AI 데이터베이스 및 인증 시스템 설정 가이드**

## 완료된 작업 ✅

### 1. 인증 시스템 (100% 완료)
- ✅ AuthContext 구현 (Google OAuth, 이메일/비밀번호)
- ✅ LoginModal 컴포넌트 (우아한 UI/UX)
- ✅ Supabase 클라이언트 설정
- ✅ App.jsx 통합 (로그인/로그아웃, 프로필 표시)
- ✅ Rate limiting 로직 (익명 3회/일, 무료 10회/일, 프리미엄 무제한)
- ✅ 기도문 저장 기능

### 2. 파일 구조
```
src/
├── components/
│   ├── auth/
│   │   ├── LoginModal.jsx ✅
│   │   └── LoginModal.css ✅
│   └── prayer/
│       ├── PrayerAmbience.jsx ✅
│       ├── PrayerProgress.jsx ✅
│       └── (CSS files) ✅
├── contexts/
│   └── AuthContext.jsx ✅
├── hooks/
│   ├── usePrayerGeneration.js ✅
│   └── useStreamingText.js ✅
├── lib/
│   └── supabaseClient.js ✅
└── App.jsx ✅ (완전히 통합됨)

directives/
└── supabase_setup.md ✅ (전체 데이터베이스 스키마 및 가이드)
```

---

## 사용자 액션 필요 🚀

### Step 1: Supabase 프로젝트 생성

1. **Supabase 계정 생성**
   - https://supabase.com 방문
   - 'Start your project' 클릭
   - GitHub 또는 이메일로 가입

2. **새 프로젝트 생성**
   - 'New Project' 클릭
   - **Organization**: 개인 organization 선택 또는 새로 생성
   - **Project Name**: `grace-ai` 또는 원하는 이름
   - **Database Password**: 강력한 비밀번호 생성 (저장해두기!)
   - **Region**: `Northeast Asia (Seoul)` 선택 (한국 사용자용)
   - **Pricing Plan**: `Free` 선택
   - 'Create new project' 클릭 (약 2분 소요)

---

### Step 2: 데이터베이스 스키마 설정

1. **SQL Editor 열기**
   - Supabase Dashboard 좌측 메뉴에서 'SQL Editor' 클릭
   - 'New query' 클릭

2. **스키마 실행**
   - `/directives/supabase_setup.md` 파일 열기
   - 모든 SQL 코드를 복사 (profiles, prayers, prayer_likes, subscriptions, usage_logs 테이블)
   - SQL Editor에 붙여넣기
   - 'Run' 버튼 클릭

3. **RPC 함수 추가**
   다음 SQL을 별도로 실행:
   ```sql
   -- Function to increment prayer count
   CREATE OR REPLACE FUNCTION increment_prayer_count(user_id_param UUID)
   RETURNS void AS $$
   BEGIN
     UPDATE profiles
     SET
       daily_prayer_count = daily_prayer_count + 1,
       total_prayers_generated = total_prayers_generated + 1
     WHERE id = user_id_param;
   END;
   $$ LANGUAGE plpgsql;
   ```

4. **확인**
   - 좌측 'Table Editor' 클릭
   - profiles, prayers, subscriptions, usage_logs 테이블이 생성되었는지 확인

---

### Step 3: Google OAuth 설정

1. **Google Cloud Console에서 OAuth 설정**
   - https://console.cloud.google.com 방문
   - 새 프로젝트 생성 또는 기존 프로젝트 선택
   - '사용자 인증 정보' → 'OAuth 2.0 클라이언트 ID' 생성
   - 애플리케이션 유형: 웹 애플리케이션
   - **승인된 리디렉션 URI 추가**:
     ```
     https://[YOUR-PROJECT-ID].supabase.co/auth/v1/callback
     ```
   - Client ID와 Client Secret 저장

2. **Supabase에서 Google Provider 활성화**
   - Supabase Dashboard → 'Authentication' → 'Providers'
   - 'Google' 활성화
   - Google Client ID 입력
   - Google Client Secret 입력
   - 'Save' 클릭

3. **Site URL 설정**
   - 'Authentication' → 'URL Configuration'
   - **Site URL**: `https://prayer-agent.vercel.app` (또는 실제 도메인)
   - **Redirect URLs** 추가:
     ```
     https://prayer-agent.vercel.app/*
     https://prayer-agent.vercel.app
     http://localhost:5173/*
     ```

---

### Step 4: 환경 변수 설정

1. **Supabase 환경 변수 가져오기**
   - Supabase Dashboard → 'Project Settings' (톱니바퀴 아이콘)
   - 'API' 탭 클릭
   - 다음 정보 복사:
     - **Project URL**: `https://[project-id].supabase.co`
     - **anon public key**: `eyJhbGc...` (긴 JWT 토큰)
     - **service_role key**: `eyJhbGc...` (비밀 키, 조심스럽게 다루기)

2. **로컬 개발 환경 설정**
   ```bash
   cd /Users/sun/20260128_test/projects/prayer-agent
   cp .env.example .env.local
   ```

   `.env.local` 파일 편집:
   ```bash
   # Google Gemini API (기존)
   GOOGLE_API_KEY=your_existing_key

   # Supabase (새로 추가)
   VITE_SUPABASE_URL=https://[project-id].supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGc...
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
   ```

3. **Vercel 환경 변수 설정**
   ```bash
   cd /Users/sun/20260128_test/projects/prayer-agent

   # Supabase URL
   vercel env add VITE_SUPABASE_URL production
   # [프롬프트에 URL 입력]

   # Supabase Anon Key
   vercel env add VITE_SUPABASE_ANON_KEY production
   # [프롬프트에 anon key 입력]

   # Service Role Key (서버 전용)
   vercel env add SUPABASE_SERVICE_ROLE_KEY production
   # [프롬프트에 service role key 입력]
   ```

---

### Step 5: 배포 및 테스트

1. **로컬 테스트 (선택사항)**
   ```bash
   cd /Users/sun/20260128_test/projects/prayer-agent
   npm run dev
   ```
   - http://localhost:5173 접속
   - 로그인 버튼 클릭
   - Google 로그인 테스트
   - 기도문 생성 및 저장 테스트

2. **프로덕션 배포**
   ```bash
   cd /Users/sun/20260128_test/projects/prayer-agent
   git add .
   git commit -m "Phase 2: Complete authentication and database integration"
   vercel --prod
   ```

3. **프로덕션 테스트**
   - 배포된 URL 접속
   - 회원가입/로그인 테스트
   - 기도문 생성 (Rate limit 확인)
   - 기도문 저장
   - 로그아웃

---

## 데이터베이스 확인

### Supabase Dashboard에서 확인
1. **Table Editor** → **profiles**
   - 새로 가입한 사용자 프로필 확인
   - subscription_tier: 'free'
   - daily_prayer_count: 생성한 기도문 수

2. **Table Editor** → **prayers**
   - 저장된 기도문 확인
   - user_id가 올바르게 연결되었는지 확인

3. **Table Editor** → **usage_logs**
   - API 사용 로그 확인
   - 익명 사용자는 anonymous_id로 추적

---

## 트러블슈팅

### 문제: "Failed to fetch" 또는 CORS 오류
**해결:**
- Supabase Dashboard → Authentication → URL Configuration
- Redirect URLs에 도메인 추가 확인

### 문제: Google 로그인이 작동하지 않음
**해결:**
- Google Cloud Console에서 리디렉션 URI 확인
- Supabase Provider 설정에서 Google Client ID/Secret 재확인

### 문제: Rate limit이 작동하지 않음
**해결:**
- Supabase SQL Editor에서 `increment_prayer_count` 함수 생성 확인
- profiles 테이블에 daily_prayer_count 컬럼 확인

### 문제: 기도문 저장 실패
**해결:**
- Row Level Security 정책 확인
- Supabase Dashboard → Authentication → Policies
- prayers 테이블 정책이 올바르게 설정되었는지 확인

---

## 다음 단계 (Phase 2.3)

1. **MyPrayers 페이지 생성**
   - 사용자의 저장된 기도문 목록 표시
   - 무한 스크롤
   - 검색 및 감정 필터
   - 삭제 기능

2. **Prayer 상세 보기**
   - 개별 기도문 상세 페이지
   - 공유 기능
   - PDF 다운로드 (프리미엄)

---

## 비용 모니터링

### Free Tier 한도
- **Database**: 500MB
- **File Storage**: 1GB
- **Bandwidth**: 2GB
- **Monthly Active Users**: 50,000

### 모니터링 방법
- Supabase Dashboard → 'Settings' → 'Usage'
- 월별 사용량 확인
- 50% 도달 시 알림 설정 권장

---

## 완료 체크리스트

- [ ] Supabase 프로젝트 생성
- [ ] 데이터베이스 스키마 설정 (5개 테이블)
- [ ] RPC 함수 생성 (increment_prayer_count)
- [ ] Google OAuth 설정
- [ ] Site URL 및 Redirect URLs 설정
- [ ] 로컬 `.env.local` 파일 생성
- [ ] Vercel 환경 변수 설정 (3개)
- [ ] 프로덕션 배포
- [ ] 회원가입 테스트
- [ ] 로그인 테스트
- [ ] 기도문 생성 테스트
- [ ] 기도문 저장 테스트
- [ ] Rate limiting 테스트

---

**질문이 있으시면 언제든지 물어보세요!**
