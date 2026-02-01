# 지침: 자동 테스트 실행 (run_tests)

이 지침은 프로젝트의 테스트를 자동으로 실행하고, 실패 시 자동으로 수정하는 과정을 정의합니다.

## 목표
코드 변경 후 모든 테스트를 자동 실행하고, 실패 시 자율적으로 문제를 해결합니다.

## 입력 항목
- `project_name`: 테스트할 프로젝트 (기본값: prayer-agent)
- `test_type`: 테스트 유형 (unit/integration/e2e/all, 기본값: all)
- `auto_fix`: 실패 시 자동 수정 여부 (기본값: true)

## 테스트 우선순위

```
1. 단위 테스트 (Unit) - 빠름, 먼저 실행
2. 통합 테스트 (Integration) - 중간
3. E2E 테스트 - 느림, 마지막 실행
```

## 자동 실행 전략

### 1. 사전 점검
```bash
# 프로젝트 상태 확인
- Git status (uncommitted changes)
- 의존성 설치 여부
- 환경 변수 설정 (.env)
```

### 2. 테스트 발견
자동으로 다음 파일들을 찾아 실행:
- `**/*.test.js`, `**/*.test.jsx`
- `**/*.spec.js`, `**/*.spec.jsx`
- `**/test_*.py`, `**/*_test.py`
- `tests/`, `__tests__/` 디렉토리

### 3. 실행 순서
```
1. Linting (ESLint, Pylint) → 코드 스타일 검사
2. Type Checking (TypeScript) → 타입 오류
3. Unit Tests → 개별 함수/컴포넌트
4. Integration Tests → 모듈 간 상호작용
5. E2E Tests → 전체 워크플로우
```

## 자동 수정 전략 (Self-Annealing)

### Lint 에러
```
자동 수정: eslint --fix, prettier --write
수동 확인 필요: 복잡한 규칙 위반
```

### 단위 테스트 실패
```
1. 에러 메시지 분석
2. 관련 코드 읽기
3. 문제 원인 파악:
   - API 변경? → 테스트 업데이트
   - 로직 버그? → 코드 수정
   - 환경 문제? → 설정 수정
4. 수정 후 재실행 (최대 3회)
```

### 통합 테스트 실패
```
1. 의존성 확인 (API 서버, DB)
2. Mock 데이터 확인
3. 환경 변수 확인
4. 타임아웃 설정 확인
```

### E2E 테스트 실패
```
1. 서버 구동 상태 확인
2. 브라우저/환경 호환성
3. 네트워크 지연 고려
4. 스크린샷/로그 확인
```

## 실행 도구

### JavaScript/Node.js
```bash
# 도구 우선순위
1. Jest (선호)
2. Vitest
3. Mocha + Chai
```

### Python
```bash
# 도구 우선순위
1. pytest (선호)
2. unittest
```

## 실행 스크립트 호출

```bash
# Python 실행 스크립트
python execution/run_tests.py <project_name> [--type unit] [--fix]

# 내부 로직:
# 1. 프로젝트 타입 감지 (package.json, requirements.txt)
# 2. 적절한 테스트 러너 선택
# 3. 테스트 실행
# 4. 결과 파싱
# 5. 실패 시 자동 수정 시도
```

## 출력 형식

### 성공 시
```
✅ 모든 테스트 통과

단위 테스트: 45/45 통과
통합 테스트: 12/12 통과
E2E 테스트: 3/3 통과

총 소요 시간: 8.3초
```

### 실패 시
```
❌ 테스트 실패: 3개

실패 내역:
1. [Unit] user.test.js:42
   - 예상: 'John'
   - 실제: undefined
   - 원인: API response 변경
   - 조치: 테스트 업데이트 완료 ✅

2. [Integration] api.test.js:88
   - 에러: Connection timeout
   - 원인: 서버 미실행
   - 조치: 서버 시작 필요 (수동)

3. [E2E] login.spec.js:15
   - 에러: Element not found
   - 시도: 재실행 3회 → 실패
   - 원인: UI 변경으로 셀렉터 무효
   - 조치: 셀렉터 업데이트 필요 (수동)

자동 수정: 1/3
수동 확인 필요: 2/3
```

## 성능 최적화

### 병렬 실행
```javascript
// Jest 예시
{
  "jest": {
    "maxWorkers": "50%",  // CPU 코어의 50% 사용
    "testTimeout": 10000
  }
}
```

### 캐싱
- 변경된 파일과 관련된 테스트만 재실행
- `--changedSince` 플래그 활용

### Watch Mode
개발 중: `npm test -- --watch`

## 커버리지 보고

```bash
# 자동으로 커버리지 생성
- 목표: 80% 이상
- 부족 시: 경고 (실패 아님)
```

## CI/CD 통합

```yaml
# GitHub Actions 예시
- name: Run Tests
  run: |
    source venv/bin/activate
    python execution/run_tests.py prayer-agent --type all
```

## 학습 내용 (Learnings)

### 공통 테스트 실패 원인
1. 환경 변수 미설정 → `.env.test` 파일 생성
2. 비동기 타이밍 → `await`/`done` 사용
3. Mock 데이터 불일치 → 실제 API 응답 구조 확인

### 성능 개선
- 큰 테스트는 별도 파일로 분리
- Setup/Teardown 최적화
- 불필요한 의존성 제거
