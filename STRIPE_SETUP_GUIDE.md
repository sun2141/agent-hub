# Stripe 설정 가이드
**Grace-AI Phase 3: 결제 시스템 통합**

---

## 🎯 개요

Phase 3.1이 완료되었습니다! Stripe 결제 시스템이 구현되어 프리미엄 구독을 받을 수 있습니다.

**구현된 기능**:
- ✅ Stripe Checkout 통합
- ✅ 구독 관리 (Customer Portal)
- ✅ Webhook 이벤트 처리
- ✅ Pricing 페이지 UI
- ✅ 프리미엄 기능 게이트
- ✅ 업그레이드 배너

---

## 📋 Stripe 계정 설정 (15분)

### 1. Stripe 계정 생성

1. **Stripe 가입**
   - https://stripe.com 접속
   - "Sign up" 클릭
   - 이메일, 비밀번호 입력

2. **테스트 모드 활성화**
   - 좌측 상단 토글이 "Test mode" 인지 확인
   - 처음에는 테스트 모드에서 시작

---

### 2. API Keys 가져오기

1. **Dashboard → Developers → API keys**
   - https://dashboard.stripe.com/test/apikeys

2. **복사할 Keys**:
   ```
   Publishable key: pk_test_...
   Secret key: sk_test_...
   ```

3. **보안 주의**:
   - Secret key는 절대 노출 금지!
   - GitHub에 커밋하지 말 것
   - 환경 변수로만 관리

---

### 3. 제품 및 가격 생성

1. **Products → Add Product**
   - https://dashboard.stripe.com/test/products

2. **제품 정보 입력**:
   ```
   Name: Grace-AI Premium
   Description: 무제한 기도문 생성, PDF 다운로드, 음성 낭독, 광고 제거
   ```

3. **가격 설정**:
   ```
   Pricing model: Standard pricing
   Price: 4,900 (KRW)
   Billing period: Monthly
   ```

4. **Price ID 복사**:
   ```
   생성 후 표시되는 Price ID: price_...
   이 값을 STRIPE_PREMIUM_PRICE_ID로 사용
   ```

---

### 4. Webhook 설정

1. **Developers → Webhooks → Add endpoint**
   - https://dashboard.stripe.com/test/webhooks

2. **Endpoint URL 입력**:
   ```
   https://prayer-agent.vercel.app/api/stripe/webhook
   ```

3. **이벤트 선택** (Select events):
   ```
   ✓ checkout.session.completed
   ✓ customer.subscription.created
   ✓ customer.subscription.updated
   ✓ customer.subscription.deleted
   ✓ invoice.payment_succeeded
   ✓ invoice.payment_failed
   ```

4. **Webhook Secret 복사**:
   ```
   생성 후 "Signing secret" 클릭
   whsec_... 복사
   이 값을 STRIPE_WEBHOOK_SECRET으로 사용
   ```

---

## 🔐 환경 변수 설정

### 로컬 (.env.local)

```bash
cd /Users/sun/20260128_test/projects/prayer-agent

# .env.local 파일에 추가
cat >> .env.local << 'EOF'

# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_your_secret_key_here
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_your_publishable_key_here
STRIPE_PREMIUM_PRICE_ID=price_your_price_id_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here
VITE_APP_URL=http://localhost:5173
EOF
```

### Vercel (Production)

```bash
cd /Users/sun/20260128_test/projects/prayer-agent

# Stripe Secret Key
vercel env add STRIPE_SECRET_KEY production
# 입력: sk_test_... (나중에 sk_live_...로 변경)

# Stripe Publishable Key
vercel env add VITE_STRIPE_PUBLISHABLE_KEY production
# 입력: pk_test_... (나중에 pk_live_...로 변경)

# Premium Price ID
vercel env add STRIPE_PREMIUM_PRICE_ID production
# 입력: price_...

# Webhook Secret
vercel env add STRIPE_WEBHOOK_SECRET production
# 입력: whsec_...

# App URL
vercel env add VITE_APP_URL production
# 입력: https://prayer-agent.vercel.app
```

---

## 🧪 테스트

### 1. 로컬 테스트

```bash
npm run dev
```

1. http://localhost:5173 접속
2. 로그인
3. `/pricing` 페이지 접속
4. "프리미엄 시작하기" 클릭
5. Stripe Checkout 페이지 로딩 확인

### 2. 테스트 카드 사용

Stripe 테스트 모드에서 사용할 수 있는 카드:

**성공 테스트**:
```
카드 번호: 4242 4242 4242 4242
만료일: 12/34 (미래 날짜)
CVC: 123
우편번호: 12345
```

**실패 테스트** (결제 거부):
```
카드 번호: 4000 0000 0000 0002
```

**3D Secure 테스트**:
```
카드 번호: 4000 0027 6000 3184
```

### 3. Webhook 테스트

#### 로컬에서 Webhook 테스트:

1. **Stripe CLI 설치**:
   ```bash
   brew install stripe/stripe-cli/stripe
   ```

2. **로그인**:
   ```bash
   stripe login
   ```

3. **Webhook 포워딩**:
   ```bash
   stripe listen --forward-to localhost:5173/api/stripe/webhook
   ```

4. **테스트 이벤트 발송**:
   ```bash
   stripe trigger checkout.session.completed
   ```

---

## 🚀 프로덕션 배포

### 1. 라이브 모드로 전환

1. **Stripe Dashboard 좌측 상단**
   - "Test mode" → "Live mode" 전환

2. **라이브 API Keys 가져오기**
   - Developers → API keys
   - `pk_live_...` 와 `sk_live_...` 복사

3. **라이브 Webhook 생성**
   - Developers → Webhooks
   - 동일한 이벤트로 새 webhook 생성
   - 라이브 모드 `whsec_...` 복사

4. **Vercel 환경 변수 업데이트**
   ```bash
   vercel env rm STRIPE_SECRET_KEY production
   vercel env add STRIPE_SECRET_KEY production
   # sk_live_... 입력

   vercel env rm VITE_STRIPE_PUBLISHABLE_KEY production
   vercel env add VITE_STRIPE_PUBLISHABLE_KEY production
   # pk_live_... 입력

   vercel env rm STRIPE_WEBHOOK_SECRET production
   vercel env add STRIPE_WEBHOOK_SECRET production
   # 라이브 whsec_... 입력
   ```

### 2. 배포

```bash
vercel --prod
```

### 3. Stripe 비즈니스 정보 입력

라이브 모드 사용을 위해 필요:

1. **Settings → Business settings**
2. **회사 정보 입력**:
   - 회사명 (또는 개인 이름)
   - 주소
   - 전화번호
   - 사업자 등록번호 (선택)

3. **은행 계정 연결**:
   - Settings → Payouts
   - 정산 받을 은행 계정 등록

---

## 📊 작동 플로우

### 구독 시작 플로우

```
1. 사용자가 /pricing 접속
2. "프리미엄 시작하기" 클릭
3. POST /api/stripe/create-checkout-session
4. Stripe Checkout 페이지로 리다이렉트
5. 카드 정보 입력 및 결제
6. checkout.session.completed 이벤트 발생
7. Webhook이 /api/stripe/webhook 호출
8. Supabase subscriptions 테이블 업데이트
9. profiles.subscription_tier → 'premium'
10. 사용자에게 성공 페이지 표시
```

### 구독 관리 플로우

```
1. 프리미엄 사용자가 "구독 관리" 클릭
2. POST /api/stripe/create-portal-session
3. Stripe Customer Portal로 리다이렉트
4. 결제 수단 변경, 구독 취소 등
5. 변경 시 webhook 이벤트 발생
6. Supabase 자동 업데이트
```

---

## 🔧 구현된 파일

### API 엔드포인트 (3개)

```
api/stripe/create-checkout-session.js
- Stripe Checkout 세션 생성
- Customer 생성/조회
- 구독 시작

api/stripe/webhook.js
- Webhook 이벤트 처리
- Supabase 동기화
- 구독 상태 관리

api/stripe/create-portal-session.js
- Customer Portal 세션 생성
- 구독 관리 페이지 접근
```

### 프론트엔드 (3개)

```
src/pages/Pricing.jsx
- 요금제 비교 페이지
- 결제 버튼
- FAQ 섹션

src/components/UpgradeBanner.jsx
- 업그레이드 프롬프트
- 남은 횟수 기반 표시

src/pages/Pricing.css
- 요금제 페이지 스타일
```

---

## 💰 수익 예측

### 가격 정책
```
무료: ₩0/월
- 10회/일 제한
- 광고 표시

프리미엄: ₩4,900/월
- 무제한 생성
- PDF, TTS
- 광고 제거
```

### 예상 전환율
```
방문자 → 회원: 20%
회원 → 프리미엄: 3%
총 전환율: 0.6%
```

### 12개월 예측
```
월 1: 100 방문자 → 0-1 유료 → ₩4,900
월 3: 500 방문자 → 3 유료 → ₩14,700
월 6: 2,000 방문자 → 12 유료 → ₩58,800
월 12: 5,000 방문자 → 30 유료 → ₩147,000
```

---

## ⚠️ 주의사항

### 보안
- [x] Secret keys는 서버 측에서만 사용
- [x] Webhook signature 검증 구현
- [x] HTTPS 강제 (Vercel 기본)
- [x] 환경 변수로 민감 정보 관리

### 법적 요구사항
- [ ] 개인정보 처리방침 작성
- [ ] 이용약관 작성
- [ ] 구독 취소 정책 명시
- [ ] 환불 정책 명시

### Stripe 수수료
```
국내 카드: 3.6% + ₩250
해외 카드: 4.3% + ₩250
```

**₩4,900 구독 시 실수익**:
```
₩4,900 - (₩4,900 × 0.036 + ₩250) = ₩4,473
순이익률: 약 91.3%
```

---

## 📝 체크리스트

### 설정 단계
- [ ] Stripe 계정 생성
- [ ] API Keys 복사
- [ ] 제품 및 가격 생성
- [ ] Price ID 복사
- [ ] Webhook 설정
- [ ] Webhook Secret 복사
- [ ] 로컬 환경 변수 설정
- [ ] Vercel 환경 변수 설정

### 테스트 단계
- [ ] 로컬에서 Pricing 페이지 접속
- [ ] 테스트 카드로 결제
- [ ] Webhook 이벤트 수신 확인
- [ ] Supabase 데이터 업데이트 확인
- [ ] 프리미엄 기능 활성화 확인
- [ ] Customer Portal 접속 테스트

### 프로덕션 단계
- [ ] 라이브 모드 API Keys로 전환
- [ ] 라이브 Webhook 설정
- [ ] 비즈니스 정보 입력
- [ ] 은행 계정 연결
- [ ] 프로덕션 배포
- [ ] 실제 카드로 테스트

---

## 🆘 문제 해결

### "No such price" 오류
**원인**: Price ID가 잘못됨
**해결**: Stripe Dashboard에서 Price ID 재확인

### Webhook이 작동하지 않음
**원인**: Webhook Secret이 잘못됨 또는 URL 오류
**해결**:
1. Webhook Secret 재확인
2. Endpoint URL이 정확한지 확인
3. Webhook 로그에서 에러 확인

### "Customer not found" 오류
**원인**: Customer ID가 Supabase에 저장되지 않음
**해결**: checkout.session.completed 이벤트 처리 확인

---

## 📚 참고 문서

- Stripe API: https://stripe.com/docs/api
- Checkout: https://stripe.com/docs/payments/checkout
- Webhooks: https://stripe.com/docs/webhooks
- Customer Portal: https://stripe.com/docs/billing/subscriptions/customer-portal
- 테스트 카드: https://stripe.com/docs/testing

---

**설정 완료 후 다음 단계**:
1. Phase 3.2: 기부 시스템 구현
2. Phase 3.3: 프리미엄 기능 (PDF, TTS) 구현
3. 법적 문서 작성
4. 마케팅 자료 준비

**작성일**: 2024-02-03
**상태**: ✅ 구현 완료, 설정 대기
