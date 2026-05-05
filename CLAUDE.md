# Agent Instructions

> This file is mirrored across CLAUDE.md, AGENTS.md, and GEMINI.md so the same instructions load in any AI environment.

You operate within a 3-layer architecture that separates concerns to maximize reliability. LLMs are probabilistic, whereas most business logic is deterministic and requires consistency. This system fixes that mismatch.

## The 3-Layer Architecture

**Layer 1: Directive (What to do)**
- Basically just SOPs written in Markdown, live in `directives/`
- Define the goals, inputs, tools/scripts to use, outputs, and edge cases
- Natural language instructions, like you'd give a mid-level employee

**Layer 2: Orchestration (Decision making)**
- This is you. Your job: intelligent routing.
- Read directives, call execution tools in the right order, handle errors, ask for clarification, update directives with learnings
- You're the glue between intent and execution. E.g you don't try scraping websites yourself—you read `directives/scrape_website.md` and come up with inputs/outputs and then run `execution/scrape_single_site.py`

**Layer 3: Execution (Doing the work)**
- Deterministic Python scripts in `execution/`
- Environment variables, api tokens, etc are stored in `.env`
- Handle API calls, data processing, file operations, database interactions
- Reliable, testable, fast. Use scripts instead of manual work. Commented well.

**Why this works:** if you do everything yourself, errors compound. 90% accuracy per step = 59% success over 5 steps. The solution is push complexity into deterministic code. That way you just focus on decision-making.

## Operating Principles

**1. Check for tools first**
Before writing a script, check `execution/` per your directive. Only create new scripts if none exist.

**2. Self-anneal when things break**
- Read error message and stack trace
- Fix the script and test it again (unless it uses paid tokens/credits/etc—in which case you check w user first)
- Update the directive with what you learned (API limits, timing, edge cases)
- Example: you hit an API rate limit → you then look into API → find a batch endpoint that would fix → rewrite script to accommodate → test → update directive.

**3. Update directives as you learn**
Directives are living documents. When you discover API constraints, better approaches, common errors, or timing expectations—update the directive. But don't create or overwrite directives without asking unless explicitly told to. Directives are your instruction set and must be preserved (and improved upon over time, not extemporaneously used and then discarded).

## Self-annealing loop

Errors are learning opportunities. When something breaks:
1. Fix it
2. Update the tool
3. Test tool, make sure it works
4. Update directive to include new flow
5. System is now stronger

## File Organization

**Deliverables vs Intermediates:**
- **Deliverables**: Google Sheets, Google Slides, or other cloud-based outputs that the user can access
- **Intermediates**: Temporary files needed during processing

**Directory structure:**
- `.tmp/` - All intermediate files (dossiers, scraped data, temp exports). Never commit, always regenerated.
- `execution/` - Python scripts (the deterministic tools)
- `directives/` - SOPs in Markdown (the instruction set)
- `.env` - Environment variables and API keys
- `credentials.json`, `token.json` - Google OAuth credentials (required files, in `.gitignore`)
- `~/.secrets/` - 민감 정보 저장소 (SSH 키, API 키, 서버 접속 정보)

**Key principle:** Local files are only for processing. Deliverables live in cloud services (Google Sheets, Slides, etc.) where the user can access them. Everything in `.tmp/` can be deleted and regenerated.

## Summary

You sit between human intent (directives) and deterministic execution (Python scripts). Read instructions, make decisions, call tools, handle errors, continuously improve the system.

Be pragmatic. Be reliable. Self-anneal.

---

## Automation Management

세션 시작 시 자동화 시스템 상태를 확인합니다.

**자동화 레지스트리**: `directives/automation_registry.md`
- 모든 자동화 요소의 단일 진실 소스
- 상시(always-on) / 요청시(on-demand) / 조건부(conditional) 분류

**폴더 구조**:
```
directives/
├── core/           # 상시 참조 (resource_management 등)
├── workflows/      # 작업별 (deploy, develop_feature 등)
└── agents/         # 복잡한 작업 (pm_agent, sub-agents)
```

**진단 명령어**:
```bash
python execution/automation_manager.py status    # 현황
python execution/automation_manager.py suggest   # 최적화 제안
```

---

## Checkpoint System (작업 중단/재개 프로토콜)

### 세션 시작 시 체크포인트 확인 절차

새 세션이 시작되면 **반드시** 다음을 수행합니다:

```bash
python execution/restore_checkpoint.py
```

- 출력에 "중단된 작업 감지됨"이 표시되면 사용자에게 재개 여부를 묻습니다.
- "체크포인트 없음"이면 정상적으로 작업을 시작합니다.

**재개 시 절차**:
1. `restore_checkpoint.py` 출력의 "남은 작업" 목록을 TodoWrite로 복원
2. "저장된 컨텍스트"에 있는 정보를 참고하여 작업 계속
3. 완료 후 `python execution/restore_checkpoint.py --clear` 실행

### 자동 체크포인트 (토큰 리미트 감지 시 자동 저장)

Claude Code의 `gsd-context-monitor.js` hook이 컨텍스트 사용량을 감시합니다:

| 임계치 | 잔여 % | 동작 |
|-------|--------|------|
| WARNING | ≤ 35% | Claude에게 경고 메시지 주입 (마무리 준비) |
| **CRITICAL** | **≤ 25%** | **경고 메시지 + `auto_checkpoint.py` 자동 실행** |

**CRITICAL 도달 시 자동 흐름**:
1. `~/.claude/hooks/gsd-context-monitor.js`가 임계치 감지
2. `execution/auto_checkpoint.py`를 백그라운드로 실행
3. 현재 세션의 TodoWrite 상태를 `.tmp/interrupted_task.json`에 저장
4. 세션당 1회만 자동 저장 (`/tmp/claude-ctx-checkpoint-done-{session_id}` 락)

**자동 저장 우선순위 규칙**:
- 이미 수동 체크포인트(auto_saved 없음)가 있으면 덮어쓰지 않음
- `auto_saved: true` 플래그로 수동/자동 구분 가능

```bash
# 자동 저장 강제 트리거 (테스트/수동 실행)
python3 execution/auto_checkpoint.py \
    --session-id "<세션ID>" \
    --cwd "/Users/sun/agent-hub" \
    --context-pct 20
```

### 작업 중 주기적 체크포인트 저장

장시간 작업(3단계 이상) 시 각 중요 단계 완료 후 체크포인트를 저장합니다:

```bash
python execution/save_checkpoint.py \
  --summary "전체 작업 요약" \
  --completed "완료된 todo 1" "완료된 todo 2" \
  --remaining "남은 todo 1" "남은 todo 2" \
  --last-step "마지막으로 완료한 단계 설명"
```

또는 Python에서 직접:
```python
from execution.save_checkpoint import save_checkpoint
save_checkpoint(
    summary="작업 요약",
    completed_todos=["완료 1", "완료 2"],
    remaining_todos=["남은 1", "남은 2"],
    last_completed_step="마지막 단계",
    context={"key": "추가 정보"}
)
```

### 체크포인트 파일 포맷 (.tmp/interrupted_task.json)

```json
{
  "version": "1.0",
  "saved_at": "2024-01-01T12:00:00+00:00",
  "task_id": "task_1234567890",
  "summary": "전체 작업에 대한 간략한 설명",
  "last_completed_step": "마지막으로 완료한 단계",
  "completed_todos": ["완료된 항목 1", "완료된 항목 2"],
  "remaining_todos": ["남은 항목 1", "남은 항목 2"],
  "context": {
    "추가 컨텍스트 키": "값"
  },
  "status": "interrupted"
}
```

### 체크포인트 파일 포맷 - 자동 저장 필드

자동 저장 시 추가 필드:
```json
{
  "auto_saved": true,
  "context": {
    "session_id": "세션 UUID",
    "cwd": "작업 디렉토리 경로",
    "context_remaining_pct": 20.0,
    "trigger": "context_critical"
  }
}
```

### 도구 목록

| 스크립트 | 역할 |
|---------|------|
| `execution/save_checkpoint.py` | 현재 작업 상태를 체크포인트로 수동 저장 |
| `execution/restore_checkpoint.py` | 체크포인트 읽기 및 재개 안내 출력 |
| `execution/auto_checkpoint.py` | 컨텍스트 CRITICAL 시 hook에서 자동 호출 |

---

## Fallback System (Claude Code → Gemini)

Claude Code 사용량 소진 징후 감지 시:
1. 현재 작업 상태를 `.tmp/fallback_context.json`에 저장
2. `directives/core/fallback_to_gemini.md` 참조
3. Gemini API로 작업 연속성 유지

**전환 트리거**:
- Rate limit 에러 발생
- 사용량 경고 메시지 감지
- 응답 지연 증가

**복귀 조건**:
- Claude Code 사용량 리셋 후 자동 복귀

---

## Secrets Management

민감한 정보는 `~/.secrets/` 폴더에 저장합니다.

**구조**:
```
~/.secrets/
├── hetzner.env        # Hetzner VPS 접속 정보
├── telegram.env       # 텔레그램 봇 설정
├── api_keys.env       # API 키 모음
└── ssh/               # SSH 키 파일들
```

**사용법**:
```bash
# VPS 접속
source ~/.secrets/hetzner.env
ssh $HETZNER_USER@$HETZNER_IP
```

**보안 원칙**:
- 이 폴더는 Git에 절대 커밋하지 않음
- 권한: 700 (본인만 접근 가능)

---

## Infrastructure Overview

### Agent Hub (이 폴더)

**경로**: `/Users/sun/agent-hub/`
**역할**: 모든 프로젝트를 관리하는 중앙 허브
**GitHub**: sun2141/grace-ai

### 연결된 프로젝트 (Project Registry)

| ID | 프로젝트 | 로컬 경로 | GitHub | 배포 |
|----|---------|----------|--------|------|
| palmoni | Palmoni 기도앱 | `/Users/sun/palmoni/` | sun2141/palmoni | palmoni.vercel.app |
| facepick | FacePick | `/Users/sun/facepick/` | - | 개발중 |
| reddit-insight | Reddit Insight | `/Users/sun/reddit-insight/` | - | 개발중 |

### 프로젝트 자동 연결 규칙

**새 프로젝트 추가 시**:
1. 위 테이블에 프로젝트 등록
2. 해당 프로젝트 폴더에 `CLAUDE.md` 생성 (템플릿: `directives/templates/project_claude_md.md`)
3. `directives/projects/{project_id}.md`에 프로젝트별 directive 생성

**Agent가 프로젝트 폴더에서 작업 시**:
- 해당 프로젝트의 `CLAUDE.md` 지침 따름
- 자동화/인프라 작업은 agent-hub에서만 수행
- 프로젝트 간 공유 로직은 `execution/shared/`에 위치

**모니터링 대상 (Hetzner VPS 연동)**:
- 등록된 모든 프로젝트의 배포 상태 감시
- 오류 발생 시 텔레그램 알림 + 자동 수정 시도

### 클라우드 서비스
- **Vercel**: palmoni.vercel.app (프론트엔드 + Serverless API)
- **Supabase**: 데이터베이스 + Auth
- **Google Cloud**: Gemini API, TTS API

### Hetzner VPS (24/7 Agent 서버)
- **IP**: 91.99.58.70
- **접속**: `ssh agent@91.99.58.70`
- **플랜**: CX23 (2 vCPU, 4GB RAM, 40GB NVMe) - €3.99/월
- **OS**: Ubuntu 24.04
- **설치됨**: Node.js 22, Claude Code, PM2, Git

**서버 워크스페이스**:
```
~/workspace/
├── CLAUDE.md              ← 글로벌 Agent 규칙
├── shared-skills/         ← 공유 스킬
├── facepick/              ← FacePick 프로젝트
├── reddit-insight/        ← Reddit Insight 프로젝트
└── prayer-app/            ← Palmoni 연동
```

**핵심 역할**:
- 프로젝트 상시 모니터링
- 오류 자동 감지 및 수정
- 텔레그램 알림 (Bot: 8580472888)
- 스케줄 작업 실행

### 시스템 연결 구조
```
┌─────────────┐     ┌──────────────────────────────┐
│  텔레그램   │◄────│  Hetzner VPS (24/7 Agent)   │
│  (알림/명령) │     │  - 모니터링                  │
└─────────────┘     │  - 오류 자동 수정            │
                    │  - 스케줄 작업               │
                    └──────────────┬───────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
        ▼                          ▼                          ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│ Palmoni       │      │ FacePick      │      │ Reddit Insight│
│ (Vercel)      │      │ (개발중)       │      │ (개발중)       │
└───────┬───────┘      └───────────────┘      └───────────────┘
        │
        ▼
┌───────────────┐
│ Supabase      │
│ (DB + Auth)   │
└───────────────┘
```