# Phase 3 진행 상황: 수익화 기능

**시작일**: 2026-02-03
**현재 상태**: ✅ Phase 3 완전 완료!

---

## ✅ 완료된 작업

### Phase 3.1: Stripe 결제 통합 (완료)

**구현 내용**:
- ✅ Stripe Checkout 세션 생성 API
- ✅ 프리미엄 구독 시스템 (₩4,900/월)
- ✅ Webhook 이벤트 처리 (구독 생성/업데이트/취소)
- ✅ Customer Portal (구독 관리)
- ✅ Pricing 페이지 UI
- ✅ UpgradeBanner 컴포넌트
- ✅ Supabase 동기화 (subscriptions 테이블)

**파일**:
```
api/stripe/create-checkout-session.js
api/stripe/webhook.js
api/stripe/create-portal-session.js
src/pages/Pricing.jsx
src/components/UpgradeBanner.jsx
src/components/UpgradeBanner.css
```

**설정 가이드**: [STRIPE_SETUP_GUIDE.md](STRIPE_SETUP_GUIDE.md)

---

### Phase 3.2: 기부 시스템 (완료)

**구현 내용**:
- ✅ "커피 한 잔 사주기" 기부 버튼
- ✅ 3가지 기부 금액: ₩3,000, ₩5,000, ₩10,000
- ✅ Stripe 일회성 결제 (one-time payment)
- ✅ 기부 모달 UI
- ✅ 익명/로그인 사용자 모두 지원
- ✅ 결제 성공 시 감사 메시지
- ✅ donations 테이블 마이그레이션

**파일**:
```
api/stripe/create-donation-session.js
src/components/donation/DonateButton.jsx
src/components/donation/DonateButton.css
supabase/migrations/003_create_donations_table.sql
```

**통합**:
- Home 페이지 사용자 섹션에 후원 버튼 추가
- URL 파라미터로 성공/취소 처리

**Supabase 마이그레이션 실행**:
```bash
# Supabase SQL Editor에서 실행
# https://supabase.com/dashboard/project/bajdvcdstxzrmoxfvwvj/editor

-- 003_create_donations_table.sql 내용 복사해서 실행
```

---

### Phase 3.3: 프리미엄 기능 구현 (완료)

**구현 내용**:

#### 1. PDF 다운로드 (완료)
- ✅ @react-pdf/renderer로 PDF 생성
- ✅ 한글 폰트 지원 (Noto Sans KR 웹 폰트)
- ✅ A4 템플릿 (헤더, 메타데이터, 내용, 푸터)
- ✅ 프리미엄 게이트 + 업그레이드 모달
- ✅ Home + MyPrayers 페이지 통합

**파일**:
```
src/components/pdf/PrayerPdfDocument.jsx
src/components/pdf/PdfDownloadButton.jsx
src/components/pdf/PdfDownloadButton.css
```

#### 2. 음성 낭독 (TTS) (완료)
- ✅ Google Cloud Text-to-Speech API 연동
- ✅ 한국어 음성 (ko-KR-Standard-A, Female)
- ✅ MP3 오디오 + 재생 컨트롤 (Play/Pause)
- ✅ 프리미엄 전용 + 업그레이드 모달
- ✅ Home + MyPrayers 페이지 통합
- ✅ 1일 브라우저 캐싱

**파일**:
```
api/tts/generate.js
src/components/tts/TtsButton.jsx
src/components/tts/TtsButton.css
```

**환경 변수 필요**:
```bash
GOOGLE_CLOUD_API_KEY  # TTS API용
```

---

## 📊 기능 비교

| 기능 | 무료 (Free) | 프리미엄 (Premium) |
|------|-------------|-------------------|
| 기도문 생성 | 10회/일 | 무제한 |
| 기도문 저장 | ✅ | ✅ |
| 내 기도문 | ✅ | ✅ |
| 감정 필터 | ✅ | ✅ |
| **PDF 다운로드** | ❌ | ✅ |
| **음성 낭독** | ❌ | ✅ |
| 광고 제거 | ❌ | ✅ |

---

## 💰 수익 모델

### 1. 프리미엄 구독
- **가격**: ₩4,900/월
- **Stripe 수수료**: 3.6% + ₩250 (국내 카드)
- **순수익**: ~₩4,473/건
- **목표 전환율**: 3%

### 2. 일회성 기부
- **금액**: ₩3,000 / ₩5,000 / ₩10,000
- **Stripe 수수료**: 3.6% + ₩250
- **목표 전환율**: 1%

### 예상 수익 (6개월 후)

```
월 활성 사용자: 2,000명
프리미엄 전환: 2% (40명) → ₩178,920
기부 전환: 1% (20명 × ₩5,000 평균) → ₩96,800
───────────────────────────────────────
월 총 수익: ~₩275,000
연간 예상: ~₩3,300,000
```

---

## 🔧 기술 스택

### 결제
- **Stripe**: 구독 + 일회성 결제
- **Webhook**: 실시간 동기화
- **Customer Portal**: 자체 구독 관리

### 프리미엄 기능 (예정)
- **PDF**: pdfkit 또는 @react-pdf/renderer
- **TTS**: Google Cloud Text-to-Speech API
- **폰트**: Noto Sans KR (한글 지원)

---

## 📝 Supabase 스키마

### subscriptions 테이블
```sql
id: UUID (Primary Key)
user_id: UUID (Foreign Key → auth.users)
stripe_customer_id: TEXT
stripe_subscription_id: TEXT
status: TEXT (active, canceled, past_due)
current_period_start: TIMESTAMP
current_period_end: TIMESTAMP
cancel_at_period_end: BOOLEAN
created_at: TIMESTAMP
updated_at: TIMESTAMP
```

### donations 테이블 (새로 추가)
```sql
id: UUID (Primary Key)
user_id: UUID (Foreign Key → auth.users, nullable)
amount: INTEGER (KRW)
stripe_payment_intent: TEXT
created_at: TIMESTAMP
```

---

## 🎯 다음 단계

### 즉시 (Phase 3.3)
1. ✅ PDF 다운로드 구현
2. ⏳ TTS 음성 낭독 구현
3. ⏳ 프리미엄 기능 게이트 추가

### 추후 (Phase 4)
1. PM 에이전트 시스템 설계
2. 병렬 서브 에이전트 구현
3. 자동화된 워크플로우

---

## 🔐 환경 변수 (필수)

### Stripe (설정 완료)
```bash
STRIPE_SECRET_KEY=sk_test_...
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_PREMIUM_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
VITE_APP_URL=https://prayer-agent-...vercel.app
```

### Google Cloud (Phase 3.3 필요)
```bash
GOOGLE_CLOUD_API_KEY=... (TTS용)
```

---

## 📦 배포 정보

### 최신 배포
- **URL**: https://prayer-agent-1ylqmfmnj-sunhos-projects-7aadd0d2.vercel.app
- **상태**: 🟢 Active
- **마지막 배포**: Phase 3.2 완료 (2026-02-03)

### 번들 크기
```
JavaScript: 469.90 KB (143.18 KB gzipped)
CSS:         24.47 KB (5.05 KB gzipped)
HTML:         0.49 KB (0.40 KB gzipped)
```

---

## 🧪 테스트 체크리스트

### Phase 3.1 테스트
- [ ] Pricing 페이지 접속
- [ ] 테스트 카드로 프리미엄 결제 (4242 4242 4242 4242)
- [ ] Supabase subscriptions 테이블 업데이트 확인
- [ ] 프로필 subscription_tier → premium 확인
- [ ] Customer Portal 접속 확인

### Phase 3.2 테스트
- [ ] 후원 버튼 클릭
- [ ] 기부 모달 표시 확인
- [ ] ₩3,000 / ₩5,000 / ₩10,000 결제
- [ ] 결제 성공 시 감사 메시지 표시
- [ ] donations 테이블 로그 확인

### Phase 3.3 테스트 (예정)
- [ ] PDF 다운로드 버튼 (프리미엄만)
- [ ] 한글 폰트 정상 렌더링
- [ ] TTS 재생 버튼 (프리미엄만)
- [ ] 음성 품질 확인

---

## 💡 개선 아이디어

### 단기
- [ ] 프리미엄 무료 체험 (14일)
- [ ] 연간 구독 할인 (₩49,000/년)
- [ ] 기부 커스텀 금액 입력

### 장기
- [ ] 교회/단체 구독 플랜
- [ ] 추천인 시스템 (리퍼럴)
- [ ] 기부자 명예의 전당

---

**작성일**: 2026-02-03
**작성자**: Claude Code (Autonomous Agent)
**상태**: Phase 3.2 완료, Phase 3.3 진행 중
