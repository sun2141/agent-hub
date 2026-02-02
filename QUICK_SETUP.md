# Grace-AI 빠른 설정 가이드

**Supabase Project ID**: `bajdvcdstxzrmoxfvwvj`
**Dashboard**: https://supabase.com/dashboard/project/bajdvcdstxzrmoxfvwvj

---

## ✅ Step 1: SQL 스키마 실행 (3분)

1. **SQL Editor 열기**
   - 왼쪽 메뉴에서 **SQL Editor** 클릭
   - 또는 직접 링크: https://supabase.com/dashboard/project/bajdvcdstxzrmoxfvwvj/sql/new

2. **SQL 실행**
   ```bash
   # 터미널에서 SQL 파일 내용 복사
   cat /Users/sun/20260128_test/projects/prayer-agent/supabase_schema.sql
   ```
   - 위 명령어 출력 내용을 **전체 복사**
   - SQL Editor에 **붙여넣기**
   - 우하단 **Run** 버튼 클릭

3. **확인**
   - 왼쪽 메뉴 **Table Editor** 클릭
   - 다음 테이블들이 보여야 함:
     - ✅ profiles
     - ✅ prayers
     - ✅ prayer_likes
     - ✅ subscriptions
     - ✅ usage_logs

---

## ✅ Step 2: API Keys 가져오기 (1분)

1. **Settings → API 이동**
   - 왼쪽 하단 **⚙️ Settings** 클릭
   - **API** 탭 클릭
   - 또는 직접 링크: https://supabase.com/dashboard/project/bajdvcdstxzrmoxfvwvj/settings/api

2. **다음 정보 복사해두기**
   ```
   Project URL: https://bajdvcdstxzrmoxfvwvj.supabase.co

   anon public key: eyJ... (매우 긴 문자열)

   service_role key: eyJ... (매우 긴 문자열 - 비밀!)
   ```

---

## ✅ Step 3: Google OAuth 설정 (10분)

### 3-1. Google Cloud Console 설정

1. **Google Cloud Console 접속**
   - https://console.cloud.google.com
   - 로그인

2. **새 프로젝트 생성 (또는 기존 선택)**
   - 상단 프로젝트 선택 드롭다운 클릭
   - "새 프로젝트" 클릭
   - 이름: `grace-ai` 입력
   - "만들기" 클릭

3. **OAuth 동의 화면 설정**
   - 왼쪽 메뉴: **API 및 서비스** → **OAuth 동의 화면**
   - User Type: **외부** 선택 → "만들기"
   - 앱 이름: `Grace AI`
   - 사용자 지원 이메일: (본인 이메일)
   - 개발자 연락처 정보: (본인 이메일)
   - "저장 후 계속" 클릭
   - 범위 추가: 그냥 "저장 후 계속"
   - 테스트 사용자: 본인 이메일 추가
   - "저장 후 계속"

4. **OAuth 2.0 클라이언트 ID 만들기**
   - 왼쪽 메뉴: **사용자 인증 정보**
   - 상단 **+ 사용자 인증 정보 만들기** → **OAuth 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 이름: `Grace AI Web`
   - **승인된 자바스크립트 원본** 추가:
     ```
     https://bajdvcdstxzrmoxfvwvj.supabase.co
     ```
   - **승인된 리디렉션 URI** 추가:
     ```
     https://bajdvcdstxzrmoxfvwvj.supabase.co/auth/v1/callback
     ```
   - "만들기" 클릭
   - **클라이언트 ID**와 **클라이언트 보안 비밀번호** 복사

### 3-2. Supabase에서 Google Provider 활성화

1. **Authentication → Providers 이동**
   - https://supabase.com/dashboard/project/bajdvcdstxzrmoxfvwvj/auth/providers
   - **Google** 찾아서 클릭

2. **설정 입력**
   - "Google Enabled" 토글 **ON**
   - **Client ID (for OAuth)**: (Google에서 복사한 클라이언트 ID)
   - **Client Secret (for OAuth)**: (Google에서 복사한 보안 비밀번호)
   - "Save" 클릭

### 3-3. Site URL 설정

1. **Authentication → URL Configuration**
   - https://supabase.com/dashboard/project/bajdvcdstxzrmoxfvwvj/auth/url-configuration

2. **설정**
   - **Site URL**: `https://prayer-agent.vercel.app`
   - **Redirect URLs** 추가:
     ```
     https://prayer-agent.vercel.app/*
     https://prayer-agent.vercel.app
     https://prayer-agent-*.vercel.app/*
     http://localhost:5173/*
     http://localhost:5173
     ```
   - "Save" 클릭

---

## ✅ Step 4: 이메일 인증 설정 (2분)

1. **Authentication → Providers**
   - https://supabase.com/dashboard/project/bajdvcdstxzrmoxfvwvj/auth/providers

2. **Email Provider 설정**
   - **Email** 클릭
   - "Enable Email provider" **ON**
   - "Confirm email" **OFF** (개발 중에는 끄기)
   - "Save" 클릭

---

## ✅ Step 5: 환경 변수 설정 (로컬)

```bash
cd /Users/sun/20260128_test/projects/prayer-agent

# .env.local 파일 생성
cat > .env.local << 'EOF'
# Google Gemini API (기존)
GOOGLE_API_KEY=AIzaSyDJf4ZbqCJnfWx1F6wCyS3H0s6sTKfXqYg

# Supabase
VITE_SUPABASE_URL=https://bajdvcdstxzrmoxfvwvj.supabase.co
VITE_SUPABASE_ANON_KEY=여기에_anon_key_붙여넣기
SUPABASE_SERVICE_ROLE_KEY=여기에_service_role_key_붙여넣기
EOF

echo "✅ .env.local 파일 생성 완료!"
echo "이제 Step 2에서 복사한 API keys를 .env.local 파일에 붙여넣으세요."
```

---

## ✅ Step 6: Vercel 환경 변수 설정

터미널에서 실행:

```bash
cd /Users/sun/20260128_test/projects/prayer-agent

# Supabase URL
vercel env add VITE_SUPABASE_URL production
# 입력: https://bajdvcdstxzrmoxfvwvj.supabase.co

# Supabase Anon Key
vercel env add VITE_SUPABASE_ANON_KEY production
# 입력: eyJ... (Step 2에서 복사한 anon key)

# Supabase Service Role Key
vercel env add SUPABASE_SERVICE_ROLE_KEY production
# 입력: eyJ... (Step 2에서 복사한 service_role key)
```

---

## ✅ Step 7: 재배포 및 테스트

```bash
cd /Users/sun/20260128_test/projects/prayer-agent

# 재배포
vercel --prod
```

배포 완료 후:
1. 배포된 URL 접속
2. 우상단 "로그인/회원가입" 클릭
3. Google 로그인 또는 이메일 회원가입 테스트
4. 기도문 생성 및 저장 테스트

---

## 🎯 체크리스트

- [ ] SQL 스키마 실행 완료 (5개 테이블)
- [ ] API Keys 복사 (URL, anon key, service_role key)
- [ ] Google Cloud Console OAuth 설정
- [ ] Supabase Google Provider 활성화
- [ ] Site URL 및 Redirect URLs 설정
- [ ] 이메일 Provider 활성화
- [ ] 로컬 .env.local 파일 생성
- [ ] Vercel 환경 변수 3개 추가
- [ ] 재배포 완료
- [ ] 로그인 테스트 성공
- [ ] 기도문 저장 테스트 성공

---

**문제가 있으면 말씀해주세요!**
