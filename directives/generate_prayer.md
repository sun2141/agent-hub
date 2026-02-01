# 지침: AI 기도문 생성 (generate_prayer)

이 지침은 사용자의 기도 제목을 바탕으로 따뜻하고 위로가 되는 기도문을 생성하는 과정을 정의합니다.

## 목표
사용자가 입력한 고민이나 감사 제목을 바탕으로, 기독교적 가치관을 담은 정성스러운 기도문을 작성합니다.

## 입력 항목
- `prayer_topic`: 사용자가 입력한 구체적인 기도 제목이나 현재의 상황/감정

## 출력 형식
마크다운 형식으로 다음 요소를 포함해야 합니다:
1. **제목**: 기도문의 주제를 담은 짧은 문구
2. **본문**: 300~500자 내외의 따뜻한 기도문 (나-전달법 사용, 위로와 희망의 메시지 포함)
3. **맺음말**: "예수님의 이름으로 기도드립니다. 아멘."

## 기도문 작성 원칙
- **감정 공감**: 사용자의 어려움이나 기쁨에 깊이 공감하는 표현을 사용합니다.
- **비정치/비논쟁**: 종교적 논쟁이나 정치적 이슈를 피하고 순수한 신앙적 위로에 집중합니다.
- **문체**: 정중하고 부드러운 경어체를 사용합니다. (예: ~하시옵소서, ~기도합니다)

## 에이전트 행동 지침
1. 입력된 `prayer_topic`을 분석합니다.
2. 위 원칙에 따라 기도문을 초안합니다.
3. 기도문이 사용자에게 위로가 되는지 다시 한번 검토 후 최종 출력합니다.

## 기술 구현 (Technical Implementation)

### 사용 도구
- **Python Script**: `projects/prayer-agent/execution/generate_prayer.py`
- **AI Model**: Google Gemini API (`gemini-2.5-flash`)
- **실행 환경**: Python 3.13+ with virtual environment

### API 설정
- **환경 변수**: `GOOGLE_API_KEY` (`.env` 파일에 저장)
- **SDK**: `google-genai` (v1.61.0+) - 새로운 공식 패키지
  - ⚠️ **주의**: 구 `google-generativeai` 패키지는 deprecated됨
- **필수 의존성**: `google-genai`, `python-dotenv`

### 모델 선택 히스토리
- ❌ `gemini-1.5-flash`: 2026년 2월 기준 v1/v1beta API에서 제거됨
- ✅ `gemini-2.5-flash`: 현재 사용 가능한 최신 모델
- 대안: `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-flash-latest` 등

### 에러 처리
- API 키 누락 시: Mock 응답 반환
- 네트워크/API 오류 시: Fallback 메시지 제공
- JSON 파싱 실패 시: Markdown 코드블록 제거 후 재시도

### 통합 방식 (Express.js)
- Node.js 서버에서 Python 스크립트를 `child_process.exec()`로 실행
- 가상환경 Python 경로: `<root>/venv/bin/python`
- 스크립트 경로: `projects/prayer-agent/execution/generate_prayer.py`
- 입출력: JSON 형식 (stdout 통신)

### 학습 내용 (Learnings)
1. Google Gemini API는 빠르게 업데이트되므로 모델명 확인 필요 (`ListModels` API 사용)
2. Python 가상환경 절대경로 사용 권장 (상대경로 문제 방지)
3. 서버 실행 시 `cwd` 옵션으로 작업 디렉토리 명시
4. `.env` 파일 위치: 프로젝트 루트와 서브프로젝트 모두 필요할 수 있음
