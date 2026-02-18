# Task: Prayer Agent UI 디자인 개선

## 목표
projects/prayer-agent/src의 컴포넌트들을 분석하고, 퍼플→핑크 그라데이션 디자인 시스템에 맞게 개선합니다.

## 작업 디렉토리
/home/agent/workspace/grace-ai/projects/prayer-agent

## 분석 및 개선 항목

### 1. 컴포넌트 스캔
- src/components/ 하위 모든 컴포넌트를 읽고 분석
- 디자인 일관성 문제 파악 (하드코딩된 색상, 그라데이션 미사용 등)

### 2. 개선 우선순위 (중요도 순)
1. **버튼 컴포넌트**: gradient-primary 적용 미흡한 경우 수정
2. **카드 컴포넌트**: shadow-glow, glass effect 미적용 부분 추가
3. **헤더/네비게이션**: Pretendard 폰트 weight 최적화 (font-semibold 활용)
4. **로딩 상태**: 스피너 색상을 violet(#a855f7)으로 통일
5. **빈 상태(empty state)**: 일관된 그라데이션 배경 적용

### 3. 제약 조건
- index.css의 CSS 변수(--gradient-primary, --shadow-glow 등)를 최대한 활용
- Tailwind 클래스 사용 시 arbitrary value 최소화
- 기능 변경 없이 스타일만 수정
- 각 파일 수정 후 문법 오류 없는지 확인

### 4. 완료 후
- 수정된 파일 목록을 정리해서 출력
- git diff --stat으로 변경 요약 출력

## 완료 조건
- 최소 3개 이상의 컴포넌트 개선
- 빌드 에러 없음 (npm run build)
