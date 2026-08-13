# 커밋 & PR 초안 — 멀티 프로바이더 오케스트레이션

## ⚠️ 스테이징 주의

이번 세션과 무관하게 이미 수정돼 있던 파일이 있습니다 (내가 건드리지 않음):
`directives/core/database_standards.md`, `harness/src/projects.js`, `harness/src/telegram/bot.js`

멀티 프로바이더 변경만 커밋하려면 아래처럼 명시적으로 add 하세요:

```bash
cd /Users/sun/agent-hub
git add harness/src/db/db.js \
        harness/src/agent/runner.js \
        harness/src/index.js \
        harness/src/agent/dispatcher.js \
        harness/src/agent/phaseDispatch.js \
        harness/src/agent/providers/ \
        harness/tests/multi_provider.test.js \
        harness/scripts/setup-antigravity-keyring.sh \
        harness/scripts/preflight.sh \
        harness/scripts/provider-status.js \
        harness/docs/ \
        harness/package.json \
        harness/.env.example
git status   # 위 목록만 staged 됐는지 확인
```

---

## 커밋 메시지

```
feat(harness): 3-프로바이더 오케스트레이션 (Claude/Codex/Antigravity)

Plan→Build→Eval 파이프라인을 구독 인증 3종 CLI로 로테이션하고,
리미트 도달 시 페일오버 또는 리셋까지 대기하는 하이브리드 정책 도입.
모두 MULTI_PROVIDER 플래그(기본 false) 뒤 — off면 기존 동작 불변.

정책:
- Plan/Review(eval)는 선호 프로바이더 핀 고정 (품질 민감)
- Build/Test-fix만 페일오버 허용 (로테이션)
- 셋 다 cooling이면 가장 빠른 리셋까지 대기 후 자동 재개
- weekly 캡이면 핀 고정 단계도 강등 허용 (다일 정지 회피)
- 프로바이더당 단일 실행(single-flight)

구성:
- db: harness.providers 상태 테이블 + providerQueries (additive)
- providers/: base + claude/codex/antigravity 어댑터 (통일 인터페이스)
- dispatcher.js: 선택 정책 (store 주입 가능 → 테스트 가능)
- phaseDispatch.js: 단계 실행 루프 (select→run→limit시 rotate/wait)
- runner.js: plan/build/eval을 _dispatchPhase로 분기 (플래그 뒤)
- index.js: 자동 회수 타이머 + Telegram ⏳ 대기/▶️ 재개 알림
- scripts/setup-antigravity-keyring.sh: ThinkPad 무인 키링 해제

검증: multi_provider.test.js 7 시나리오 통과, 기존 28 테스트 무회귀.
```

---

## PR 설명

**제목:** 3-프로바이더 구독 오케스트레이션 (Claude / Codex / Antigravity)

### 배경
Claude Pro / ChatGPT Plus / Google AI Pro — 세 구독을 로테이션해 개별 한도를
분산하고, 한도 소진 시에도 파이프라인이 멈추지 않게 한다. Gemini CLI 개인용
종료(2026-06-18) 이후 Google은 Antigravity(`agy`)로 대체.

### 변경 요약
| 파일 | 내용 |
|---|---|
| `db.js` | `harness.providers` 테이블 + 상태 쿼리 (additive, boot 시 자동 생성) |
| `providers/*.js` | claude/codex/antigravity 어댑터 + 공용 리미트/시간 파서 |
| `dispatcher.js` | 로테이션/대기/핀고정 선택 정책 (store 주입 테스트 가능) |
| `phaseDispatch.js` | 단계 실행 루프 (limit → mark cooling → 재선택) |
| `runner.js` | plan/build/eval을 `_dispatchPhase`로 분기 (MULTI_PROVIDER 뒤) |
| `index.js` | 자동 회수 타이머(기본 60s) + Telegram 알림 |
| `.env.example` | AGY_CLI_PATH, PROVIDER_* , MULTI_PROVIDER 등 |
| `setup-antigravity-keyring.sh` | ThinkPad 키링 무인 해제 |

### 안전성
- 전부 `MULTI_PROVIDER=false`(기본) 뒤 → 병합해도 현재 운영 동작 불변.
- DB 변경은 additive만 (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).

### 테스트
- `node tests/multi_provider.test.js` — 정책 7 시나리오 (페일오버/핀고정/대기/회수/단일실행).
- `node tests/path_validation.test.js` — 기존 28 통과 (무회귀).

### 활성화 절차 (병합 후, 준비되면)
1. Codex/Antigravity 인증 시딩 (`codex login`, `agy` 디바이스 코드).
2. ThinkPad 키링 해제: `bash scripts/setup-antigravity-keyring.sh empty`.
3. `.env`에 `AGY_CLI_PATH`, `CODEX_CLI_PATH` 실경로 + `MULTI_PROVIDER=true`.
4. 하네스 재시작 → `harness.providers` 자동 생성 + 타이머 활성.

### 후속(별도 PR 권장)
- 교차 전환 핸드오프 패킷 확장(files_to_modify + context_summary + diff).
- 대시보드에 프로바이더 상태(cooling/next_available_at) 표시.
```
