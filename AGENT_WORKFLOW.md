# 🤖 에이전트 자동 개발 워크플로우

이 문서는 에이전트가 **자율적으로** 개발, 테스트, 배포를 진행하는 방법을 설명합니다.

## 🎯 핵심 원칙

```
사용자는 "무엇"만 말한다
에이전트가 "어떻게"를 결정한다
실행 스크립트가 "실제로" 한다
```

## 📋 전체 워크플로우

```mermaid
사용자 요청
    ↓
에이전트 분석 (Layer 2)
    ↓
Directive 읽기 (Layer 1)
    ↓
실행 스크립트 호출 (Layer 3)
    ↓
결과 확인 & Self-Annealing
    ↓
완료 or 재시도
```

## 🚀 사용 예시

### 예시 1: 새 기능 추가

**사용자:**
> "prayer-agent에 기도문 저장 기능을 추가해줘"

**에이전트 (자동 실행):**
```
1. 📖 directives/develop_feature.md 읽기
2. 🔍 프로젝트 구조 분석 (Glob, Grep)
3. 💡 계획 수립:
   - 백엔드: /api/save-prayer 엔드포인트
   - 프론트: SaveButton 컴포넌트
   - 저장소: localStorage 사용 (간단함)
4. 💻 코드 작성:
   - server.js: POST /api/save-prayer
   - App.jsx: SaveButton 추가
5. 🧪 테스트: python execution/run_tests.py prayer-agent
6. 📝 커밋: git commit -m "feat: add prayer save feature"
7. ✅ 완료 보고
```

**질문 없이 자동 진행** ✅

---

### 예시 2: 버그 수정

**사용자:**
> "기도문 생성 API가 느려. 최적화해줘"

**에이전트 (자동 실행):**
```
1. 🔍 성능 분석:
   - generate_prayer.py 읽기
   - API 호출 시간 측정
2. 💡 문제 발견: 매번 새 client 생성
3. 🔧 수정: client를 전역 변수로 재사용
4. 🧪 테스트: 응답 시간 측정 (8초 → 2초)
5. 📝 커밋
6. ✅ 완료 보고 + 성능 개선 결과
```

**질문 없이 자동 진행** ✅

---

### 예시 3: 테스트 추가

**사용자:**
> "prayer-agent에 테스트 추가해줘"

**에이전트 (자동 실행):**
```
1. 📖 directives/run_tests.md 읽기
2. 🔍 테스트 프레임워크 확인:
   - package.json에 vitest 발견
3. 📝 테스트 파일 생성:
   - src/__tests__/App.test.jsx
   - execution/test_generate_prayer.py
4. 🧪 실행: python execution/run_tests.py prayer-agent
5. ✅ 통과 확인
6. 📝 커밋
```

**질문 없이 자동 진행** ✅

---

### 예시 4: 배포

**사용자:**
> "prayer-agent를 Vercel에 배포해줘"

**에이전트 (자동 실행):**
```
1. 📖 directives/deploy.md 읽기
2. ✅ 사전 조건 확인:
   - 테스트 통과 확인
   - Git 커밋 확인
   - 빌드 성공 확인
3. 🚀 배포: bash execution/deploy.sh prayer-agent production vercel
4. 🔍 검증: Health check
5. ✅ 완료 보고 + URL 제공
```

**질문 없이 자동 진행** ✅
**예외: Vercel 토큰 없으면 사용자에게 요청**

---

## 🎛️ 에이전트가 자동으로 결정하는 것들

### ✅ 자동 결정 (질문 없음)

| 상황 | 에이전트 결정 |
|------|---------------|
| 파일 저장 위치 | 기존 구조 따름 |
| 코딩 스타일 | ESLint/Prettier 설정 |
| 라이브러리 선택 | 이미 사용 중인 것 우선 |
| API 디자인 | RESTful 원칙 |
| 에러 처리 | 항상 포함 |
| 변수명 | 기존 컨벤션 따름 |
| 테스트 위치 | `__tests__/` 또는 `.test.js` |
| 커밋 메시지 | Conventional Commits |

### ⚠️ 사용자 확인 필요

| 상황 | 확인 이유 |
|------|-----------|
| 외부 API 비용 발생 | 비용 발생 |
| 데이터베이스 삭제 | 데이터 손실 위험 |
| 새 의존성 추가 (유료) | 라이선스/비용 |
| Production 배포 | 중대한 영향 |
| API 키 입력 | 보안 |

---

## 📊 Self-Annealing 예시

### 시나리오: 테스트 실패

```
1. 🧪 테스트 실행 → 3개 실패
2. 🔍 에러 분석:
   - 에러 1: API response 구조 변경
   - 에러 2: 타임아웃
   - 에러 3: Mock 데이터 불일치
3. 🔧 자동 수정:
   - 에러 1: 테스트 업데이트 ✅
   - 에러 2: timeout 설정 증가 ✅
   - 에러 3: Mock 데이터 동기화 ✅
4. 🔁 재실행 → 모두 통과 ✅
5. 📝 Directive 업데이트:
   - "학습 내용" 섹션에 추가
```

**3회 시도 후에도 실패하면: 사용자에게 명확한 상황 설명**

---

## 🛠️ 사용 가능한 Directives

| Directive | 용도 | 자동화 수준 |
|-----------|------|-------------|
| [develop_feature.md](directives/develop_feature.md) | 새 기능 개발 | 95% 자동 |
| [run_tests.md](directives/run_tests.md) | 테스트 실행 | 100% 자동 |
| [deploy.md](directives/deploy.md) | 배포 | 90% 자동 |
| [generate_prayer.md](directives/generate_prayer.md) | 기도문 생성 | 100% 자동 |

---

## 💬 효과적인 사용자 요청 작성법

### ✅ 좋은 요청

```
"prayer-agent에 다크모드 추가해줘"
→ 명확함, 에이전트가 알아서 구현

"API 응답이 느려. 최적화해줘"
→ 문제 명확, 에이전트가 분석 후 해결

"테스트 추가하고 배포해줘"
→ 순서 명확, 자동 진행 가능
```

### ❌ 나쁜 요청

```
"뭔가 이상해"
→ 너무 모호함

"이거 어떻게 하면 좋을까?"
→ 결정을 요구함 (에이전트가 결정해야 함)

"A 방법과 B 방법 중 어떤 게 나아?"
→ 에이전트가 판단할 것
```

---

## 🔄 반복 개발 사이클

```bash
# 1단계: 기능 개발
"새 기능 추가해줘"
→ 에이전트가 자동 구현

# 2단계: 테스트
"테스트 실행해줘"
→ 자동 실행 & 수정

# 3단계: 배포
"배포해줘"
→ 자동 배포

# 반복...
```

**모든 단계가 자동화되어 있어서 빠른 이터레이션 가능** ⚡

---

## 📈 에이전트 성능 향상

에이전트는 작업할수록 똑똑해집니다:

1. **Directive 학습**: 각 작업 후 "Learnings" 섹션 업데이트
2. **패턴 인식**: 반복되는 코드 패턴 기억
3. **에러 데이터베이스**: 과거 에러와 해결법 축적
4. **최적화**: 자주 사용하는 도구/명령어 우선 사용

---

## 🎓 다음 단계

### 추가 가능한 Directives

1. **directives/optimize_performance.md**
   - 번들 사이즈 분석
   - 불필요한 리렌더링 제거
   - API 호출 최적화

2. **directives/add_feature_flag.md**
   - Feature flag 시스템 구축
   - A/B 테스트 자동화

3. **directives/security_audit.md**
   - 보안 취약점 스캔
   - 의존성 업데이트
   - API 키 검증

4. **directives/generate_docs.md**
   - 코드 → 문서 자동 생성
   - API 스펙 생성
   - README 업데이트

### 새 프로젝트 시작

```bash
# projects/ 폴더에 새 프로젝트 생성
mkdir projects/my-new-agent
cd projects/my-new-agent
npm init -y

# 에이전트에게 요청
"my-new-agent에 [기능] 추가해줘"
→ 자동으로 구조 파악하고 구현
```

---

## 🎉 결론

이제 당신은:
- ✅ "무엇"만 말하면 됩니다
- ✅ 에이전트가 "어떻게"를 알아서 합니다
- ✅ 질문 없이 빠르게 개발합니다
- ✅ 에러가 나면 자동으로 고칩니다
- ✅ 학습하면서 점점 더 똑똑해집니다

**개발에만 집중하세요. 나머지는 에이전트가 합니다.** 🚀
