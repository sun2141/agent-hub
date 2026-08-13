// src/agent/phaseDispatch.js
// 한 파이프라인 단계를 멀티 프로바이더 정책으로 실행하는 루프.
// runner.js는 단계별로 이 함수 한 번만 호출하면 되어, 라이브 코드 변경이 최소화된다.
//
// 흐름(하이브리드 로테이션 후 대기):
//   selectProvider → run
//     · ok    → 반환
//     · limit → 해당 프로바이더 cooling 등록 후 재선택(페일오버 or 대기)
//     · error → 반환
//   selectProvider가 wait/busy를 주면 그대로 반환(호출자가 sleep/재큐 결정)
//
// deps 주입으로 DB 없이 유닛 테스트 가능.

import { selectProvider as defaultSelect, markLimit as defaultMarkLimit } from './dispatcher.js';

export async function runPhase({
  phase,
  adapterCtx = {},          // { taskId, round, cwd, onText, onSessionId }
  prompt,
  resumeIds = {},           // { [provider]: sessionId }  — 같은 프로바이더 재개 전용
  busy = new Set(),         // 현재 in-flight 프로바이더 이름 집합 (단일 실행 강제)
  maxRotations = 4,         // 무한 루프 방지
  deps = {},
  onEvent = () => {},       // ('limit'|'run'|'wait'|'busy', payload)
}) {
  const selectProvider = deps.selectProvider || defaultSelect;
  const markLimit      = deps.markLimit      || defaultMarkLimit;

  let rotations = 0;
  const tried = [];

  while (rotations <= maxRotations) {
    const sel = await selectProvider({ phase, busy: [...busy] });

    if (sel.action === 'wait') {
      onEvent('wait', { phase, provider: sel.provider, resumeAt: sel.resumeAt, waitMs: sel.waitMs });
      return { status: 'wait', provider: sel.provider, resumeAt: sel.resumeAt, waitMs: sel.waitMs, tried };
    }
    if (sel.action === 'busy') {
      onEvent('busy', { phase, provider: sel.provider });
      return { status: 'busy', provider: sel.provider, tried };
    }

    // action === 'run'
    const provider = sel.provider;
    const adapter  = sel.adapter;
    const resumeId = resumeIds[provider] || null;   // 교차 전환은 재개하지 않음(핸드오프 패킷 사용)
    tried.push(provider);

    busy.add(provider);
    onEvent('run', { phase, provider, resumeId });
    let result;
    try {
      result = await adapter.run({ ...adapterCtx, phase, prompt, resumeId });
    } finally {
      busy.delete(provider);
    }

    if (result.status === 'limit') {
      await markLimit(provider, { resetAt: result.resetAt, windowType: result.windowType, reason: `limit@${phase}` });
      onEvent('limit', { phase, provider, resetAt: result.resetAt, windowType: result.windowType });
      rotations++;
      continue; // 재선택: 페일오버(가능 단계) 또는 대기(핀 고정)
    }
    if (result.status === 'error') {
      onEvent('error', { phase, provider, error: result.error });
      return { status: 'error', provider, error: result.error, tried };
    }
    // ok
    return { status: 'ok', provider, output: result.output, sessionId: result.sessionId ?? null, tried };
  }

  return { status: 'exhausted', tried };
}
