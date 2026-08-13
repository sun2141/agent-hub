# 멀티 프로바이더 오케스트레이션 (3-Provider)

Claude Code / Codex / Antigravity(`agy`)를 구독 인증으로 로테이션하며,
리미트 도달 시 페일오버하거나 리셋까지 대기하는 하이브리드 정책.

## 확정 설계

| 항목 | 값 |
|---|---|
| 페일오버 범위 | **Build / Test-fix만** (Plan·Review는 선호 프로바이더 핀 고정) |
| 디스패치 정책 | 하이브리드 "로테이션 후 대기" |
| 단계별 선호 | Plan→antigravity, Build/Test-fix→claude, Review(eval)→codex |
| 동시성 | 최대 3, 기본 2, **프로바이더당 단일 실행** |
| 티어 | Claude Pro / ChatGPT Plus / Google AI Pro (보수적 주간 캡 예산) |
| weekly 캡 | 핀 고정 단계라도 강등 허용(다일 정지 회피, `PROVIDER_RELAX_WEEKLY`) |
| OCR | 하네스 범위 밖 (제외) |

## 추가된 파일 (기존 동작 비파괴)

```
src/db/db.js                         # harness.providers 테이블 + providerQueries (additive)
src/agent/providers/base.js          # 시간/리미트 파싱, spawnCollect 공용
src/agent/providers/claude.js        # Claude 어댑터 (stream-json, 세션 캡처)
src/agent/providers/codex.js         # Codex 어댑터 (5h + weekly)
src/agent/providers/antigravity.js   # agy 어댑터 (신규)
src/agent/providers/index.js         # 어댑터 레지스트리
src/agent/dispatcher.js              # 선택 정책 (로테이션/대기/재큐)
scripts/setup-antigravity-keyring.sh # ThinkPad 키링 무인 해제
.env.example                         # 프로바이더 env + MULTI_PROVIDER 플래그
```

`MULTI_PROVIDER=false`(기본)면 위 코드는 로드되지 않고 기존 파이프라인이 그대로 동작한다.

## 어댑터 통일 인터페이스

```js
run({ taskId, phase, round, cwd, prompt, resumeId, onText, onSessionId })
  -> { status:'ok'|'limit'|'error', output, sessionId, limitHit, resetAt, windowType, error, provider }
parseLimit(text) -> { limitHit, resetAt, windowType }   // resetAt: UTC 'YYYY-MM-DD HH24:MI:SS'
```

`resetAt`은 `harness.providers.next_available_at`와 동일한 UTC 문자열 포맷.

## 디스패처 사용 예

```js
import { selectProvider, markLimit } from './dispatcher.js';

// phase: 'plan' | 'build' | 'testfix' | 'eval'
// busy : 현재 in-flight 프로바이더 이름 배열 (프로바이더당 단일 실행 강제)
const sel = await selectProvider({ phase, busy: [...this._busyProviders] });

switch (sel.action) {
  case 'run': {
    const result = await sel.adapter.run({ ...ctx, prompt, resumeId });
    if (result.status === 'limit') {
      await markLimit(sel.provider, result);       // cooling 등록
      // → 재큐 후 다음 루프에서 페일오버/대기 재평가
    }
    break;
  }
  case 'busy':  /* 잠깐 대기 후 재큐 (곧 빔) */ break;
  case 'wait':  /* sel.waitMs 만큼 sleep 후 재개, Telegram ⏳ 알림 */ break;
}
```

## runner.js 배선 지점 (MULTI_PROVIDER=true일 때만)

기존 메서드는 유지하고, 아래 지점만 분기한다. 실제 코드 수정은 리뷰 후 진행.

1. **in-flight 프로바이더 추적**: `AgentRunner` 생성자에 `this._busyProviders = new Set()`.
   `selectProvider` 호출 → `run` 시작 시 add, 종료(finally) 시 delete. (단일 실행 강제)

2. **`_runGenerator` (Build)**: `_claudeRun` 직접 호출 대신
   `selectProvider({ phase:'build', busy })` → 반환 어댑터로 실행.
   `resumeId`는 **같은 프로바이더 재개일 때만** 전달(교차 전환은 핸드오프 패킷으로 새 세션).

3. **`_runPlanner`(plan) / `_runEvaluator`(eval)**: 핀 고정.
   `selectProvider`가 `wait`를 반환하면 해당 프로바이더 리셋까지 대기(품질 유지).

4. **리미트 처리**: `_startPipeline` catch의 `RATE_LIMIT` 분기에서
   현재 프로바이더를 `markLimit`으로 cooling 등록 → 태스크 재큐.
   `action:'wait'`면 `scheduled_resume_at`에 `resumeAt` 기록 + `limit_events` 이력 + Telegram ⏳ 알림.

5. **교차 전환 핸드오프**: 기존 `_buildHandoffPrompt`(plan+criteria+prevEval)를
   확장해 `files_to_modify` + `context_summary` + diff를 포함한 포터블 패킷으로 전달.
   → 새 프로바이더에서 새 세션으로 완전 브리핑(agy 컨텍스트 손실 버그 회피).

6. **자동 회수 타이머**: `index.js`에 주기 타이머(예: 60초)로
   `reclaimExpired()` 호출 → 리셋 지난 프로바이더 available 복귀 + 대기 태스크 재개.

## 인증 시딩 (1회)

```bash
# Claude: 데스크톱 OAuth (CLAUDE_CONFIG_DIR가 인증된 .claude/를 가리키게)
# Codex:  codex login → ~/.codex/auth.json 보존 (병렬 실행 금지)
# Antigravity:
agy            # 디바이스 코드 안내 → 브라우저에서 1회 승인
bash scripts/setup-antigravity-keyring.sh check   # 키링 상태 진단
bash scripts/setup-antigravity-keyring.sh empty   # 무인 부팅용 키링 잠금 해제
```

## 운영 주의 (Pro 티어)

- 세 계정 모두 사실상 **주간 캡** 존재 → 프리미엄 단계(Plan)에 집중, 일상 Build/Eval은 저렴 티어.
- **Telegram 단일 폴링**: ThinkPad 메인 / VPS 예비는 한 번에 하나만 봇 폴링(토큰 충돌 방지).
- 노트북 sleep 방지: `systemd-inhibit` 또는 전원 설정으로 suspend 차단.
