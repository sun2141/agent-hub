# Design Agent Directive

## Overview
디자인 개선을 위한 통합 에이전트 시스템.
- **디자인 리서치**: 트렌드 검색, 경쟁 앱 분석
- **시안 생성**: AI 기반 디자인 제안서 생성
- **CSS 수정**: 승인된 디자인 실제 적용
- **사용자 확인**: Telegram을 통한 리뷰/승인 프로세스

## 에이전트 구성

### 1. Design Research Agent (`design_research.py`)
디자인 조사 및 시안 생성 담당

```bash
# 트렌드 검색
python execution/design_research.py search "기도앱 UI 트렌드"

# 경쟁앱 비교 분석
python execution/design_research.py compare "Calm Headspace Pray.com"

# 시안 생성
python execution/design_research.py draft "홈페이지 히어로 섹션 개선"

# 시안 확인
python execution/design_research.py present <draft_id>

# 시안 목록
python execution/design_research.py list
```

### 2. Design Agent (`design_agent.py`)
CSS 수정 및 적용 담당

```bash
# 요청 처리
python execution/design_agent.py process "로그인 버튼 둥글게"

# 승인/거절
python execution/design_agent.py approve <request_id>
python execution/design_agent.py reject <request_id>

# 커밋
python execution/design_agent.py commit <request_id>
```

## 워크플로우

## 전체 워크플로우

```
┌─────────────────────────────────────────────────────────────┐
│                    디자인 개선 프로세스                        │
└─────────────────────────────────────────────────────────────┘

1️⃣ 리서치 단계
   사용자: "기도앱 디자인 개선하고 싶어"
      ↓
   /design research "기도앱 UI 트렌드"
      ↓
   [트렌드 검색 + 경쟁앱 분석]
      ↓
   📊 리서치 결과 제공

2️⃣ 시안 단계
   사용자: "홈 화면 히어로 섹션 개선해줘"
      ↓
   /design draft "홈 화면 히어로 섹션"
      ↓
   [AI가 시안 생성]
      ↓
   📐 시안 제시 (컨셉, 컬러, CSS 변경사항)
      ↓
   사용자 리뷰

3️⃣ 적용 단계
   사용자: /design approve <draft_id>
      ↓
   [CSS 변경 적용]
      ↓
   /design commit
      ↓
   🚀 Git 커밋 & 배포
```

## Telegram 명령어

### 리서치 & 시안
| 명령어 | 설명 |
|--------|------|
| `/design research <키워드>` | 디자인 트렌드 검색 |
| `/design compare <앱들>` | 경쟁 앱 디자인 비교 |
| `/design draft <설명>` | AI 시안 생성 |
| `/design list` | 시안 목록 조회 |
| `/design show <draft_id>` | 시안 상세 보기 |

### 적용 & 관리
| 명령어 | 설명 |
|--------|------|
| `/design <설명>` | 간단한 CSS 수정 요청 |
| `/design status` | 현재 진행 중인 작업 상태 |
| `/design approve [id]` | 대기 중인 변경사항 승인 |
| `/design reject [id] [이유]` | 변경사항 거절 |
| `/design preview <컴포넌트>` | 특정 컴포넌트 현재 상태 분석 |
| `/design compare` | before/after diff 보기 |
| `/design commit` | 승인된 변경사항 커밋 |

## 요청 예시

**좋은 요청:**
```
/design 로그인 모달의 버튼을 더 둥글게 만들고, 호버 시 부드러운 애니메이션 추가해줘
/design Home 페이지 히어로 섹션 배경을 그라데이션으로 변경 (#667eea → #764ba2)
/design 모바일에서 카드 간격이 너무 좁아. padding 늘려줘
/design Pricing 페이지의 가격 카드에 그림자 효과 추가
```

**모호한 요청 (개선 필요):**
```
/design 더 예쁘게 만들어줘 → 구체적으로 어떤 부분?
/design 전체적으로 개선해줘 → 특정 페이지/컴포넌트 지정 필요
```

## 대상 프로젝트

**Palmoni (기도문 생성 앱)**
- 경로: `/home/sun/workspace/palmoni`
- 구조:
  ```
  src/
  ├── components/     # 재사용 컴포넌트
  ├── pages/          # 페이지 컴포넌트
  ├── contexts/       # React Context
  └── lib/            # 유틸리티
  ```

## 변경 프로세스

### 1단계: 요청 분석
```json
{
  "request_id": "design_001",
  "original_request": "로그인 모달 버튼 둥글게",
  "analysis": {
    "target_files": [
      "src/components/auth/LoginModal.css"
    ],
    "changes_needed": [
      "border-radius 값 증가",
      "transition 속성 추가"
    ],
    "estimated_impact": "low"
  }
}
```

### 2단계: Draft 작성
변경사항을 `.tmp/design_drafts/` 에 저장
```
.tmp/design_drafts/
├── design_001/
│   ├── original/           # 원본 파일 백업
│   ├── modified/           # 수정된 파일
│   └── diff.txt            # 변경사항 요약
```

### 3단계: Telegram 알림
```
📐 디자인 변경 준비됨 #design_001

📁 대상 파일:
- src/components/auth/LoginModal.css

✏️ 변경 내용:
- .email-auth-btn border-radius: 16px → 24px
- hover transition: 150ms → 200ms ease-out
- 새로운 box-shadow 효과 추가

🎯 예상 결과:
버튼이 더 둥글어지고 호버 시 부드러운 애니메이션

👇 다음 단계:
/design approve - 적용
/design reject - 취소
/design compare - diff 보기
```

### 4단계: 승인 후 적용
```bash
# 파일 적용
cp .tmp/design_drafts/design_001/modified/* src/

# Git 커밋
git add -A
git commit -m "style: 로그인 버튼 디자인 개선 (design_001)"

# Vercel 자동 배포 (push 시)
git push origin main
```

## 디자인 원칙

### 컬러 팔레트
```css
/* Primary */
--accent: #7C3AED;
--accent-hover: #6D28D9;
--accent-soft: #EDE9FE;

/* Neutral */
--text-primary: #111827;
--text-secondary: #6B7280;
--text-muted: #9CA3AF;
--bg-primary: #FAFBFC;
--bg-secondary: #F3F4F6;
--border: #E5E7EB;

/* Semantic */
--success: #10B981;
--warning: #F97316;
--error: #EF4444;
```

### 간격 시스템
```css
/* Spacing */
--space-xs: 0.25rem;  /* 4px */
--space-sm: 0.5rem;   /* 8px */
--space-md: 1rem;     /* 16px */
--space-lg: 1.5rem;   /* 24px */
--space-xl: 2rem;     /* 32px */
--space-2xl: 3rem;    /* 48px */
```

### Border Radius
```css
--radius-sm: 8px;
--radius-md: 16px;
--radius-lg: 24px;
--radius-full: 9999px;
```

### 애니메이션
```css
/* Transitions */
--transition-fast: 150ms ease;
--transition-normal: 200ms ease;
--transition-slow: 300ms ease-out;

/* 권장 easing */
ease-out: 부드러운 감속
ease-in-out: 양방향 부드럽게
cubic-bezier(0.4, 0, 0.2, 1): Material Design 스타일
```

## 에러 처리

### 요청 분석 실패
```
❌ 요청 분석 실패

원인: 대상 컴포넌트를 찾을 수 없음
요청: "헤더 버튼 색상 변경"

💡 가능한 원인:
- 컴포넌트명이 다를 수 있음 (Header vs Navigation)
- 파일 경로가 다를 수 있음

다시 시도: /design preview Header
```

### 변경 충돌
```
⚠️ 파일 충돌 감지

src/pages/Home.jsx가 마지막 동기화 후 변경됨

옵션:
1. /design sync - 최신 버전으로 동기화 후 재시도
2. /design force - 현재 버전으로 덮어쓰기
3. /design cancel - 취소
```

## 상태 관리

`.tmp/design_state.json`:
```json
{
  "current_request": "design_001",
  "status": "awaiting_approval",
  "history": [
    {
      "id": "design_001",
      "request": "로그인 버튼 둥글게",
      "status": "pending",
      "created_at": "2026-03-07T10:00:00Z"
    }
  ],
  "last_sync": "2026-03-07T09:55:00Z"
}
```

## 통합 테스트

작업 완료 후 자동 검증:
1. CSS 문법 오류 체크 (stylelint)
2. 빌드 테스트 (npm run build)
3. 주요 페이지 렌더링 확인

실패 시:
```
❌ 빌드 실패

오류: Unexpected token in LoginModal.css:45
원인: 닫는 괄호 누락

자동 수정 시도 중...
✅ 수정 완료. 다시 빌드 중...
✅ 빌드 성공
```

## 디자인 레퍼런스 DB

`design_research.py`에 내장된 참고 자료:

### 기도 앱
- **Pray.com**: 미니멀, 따뜻한 톤
- **Hallow**: 클래식, 다크 테마
- **Abide**: 밝고 친근함, 파스텔

### 명상 앱
- **Calm**: 자연스러운, 블루-그린
- **Headspace**: 일러스트 중심

### 2026 트렌드
- Glassmorphism (유리 효과)
- Micro-interactions
- Dark mode
- Variable fonts
- Rounded corners (24px+)

## 참고 문서

- UI Agent: `directives/sub_agents/ui_agent.md`
- 스타일 가이드: `directives/style_guide.md` (생성 필요)
- Telegram Bot: `execution/telegram_bot.py`
- Design Research: `execution/design_research.py`
- Design Agent: `execution/design_agent.py`
