// src/agent/providers/codex.js
// Codex CLI 어댑터 (ChatGPT 구독 인증).
// 인증: ~/.codex/auth.json (제자리 갱신 — 보존 필수, 병렬 실행 금지).
// 재개: `codex exec resume`. 리미트: 5h 윈도우 + 주간 캡.
//   ⚠️ 주간 캡은 한 번 소진되면 며칠간 복구 불가 → weekly로 표시해 강등한다.

import {
  spawnCollect, prependCliNodePath, looksLikeLimit, parseResetDuration,
  minutesFromNow, DEFAULT_5H_BACKOFF_MIN, DEFAULT_WEEKLY_BACKOFF_MIN,
} from './base.js';

const CODEX_CLI = process.env.CODEX_CLI_PATH || 'codex';

export const name = 'codex';

export function parseLimit(text = '') {
  if (!looksLikeLimit(text)) return { limitHit: false, resetAt: null, windowType: null };
  const t = String(text).toLowerCase();
  const weekly = t.includes('week') || t.includes('weekly');
  const windowType = weekly ? 'weekly' : '5h';
  const fallbackMin = weekly ? DEFAULT_WEEKLY_BACKOFF_MIN : DEFAULT_5H_BACKOFF_MIN;
  const resetAt = parseResetDuration(text) || minutesFromNow(fallbackMin);
  return { limitHit: true, resetAt, windowType };
}

// codex exec resume 는 별도 서브커맨드. resumeId가 있으면 resume 경로 사용.
export function buildArgs({ prompt, resumeId }) {
  if (resumeId) return ['exec', 'resume', resumeId, prompt];
  return ['exec', prompt];
}

export async function run({ taskId, phase, round, cwd, prompt, resumeId = null, onText }) {
  const args = buildArgs({ prompt, resumeId });
  const env = prependCliNodePath();
  const res = await spawnCollect({
    cmd: CODEX_CLI, args, cwd, env, timeoutMs: 600_000,
    onStdout: (s) => { if (onText) onText(s); },
  });

  const combined = `${res.stdout}\n${res.stderr}`;
  const parsed = parseLimit(combined);
  if (parsed.limitHit) {
    return { status: 'limit', output: res.stdout.trim(), limitHit: true, resetAt: parsed.resetAt, windowType: parsed.windowType, provider: name };
  }
  if (res.spawnError) {
    return { status: 'error', output: '', error: `Codex spawn 실패: ${res.stderr.slice(0, 200)}`, provider: name };
  }
  if (res.code !== 0 && !res.stdout.trim()) {
    return { status: 'error', output: '', error: `Codex exit ${res.code}: ${res.stderr.slice(0, 200)}`, provider: name };
  }
  return { status: 'ok', output: res.stdout.trim(), provider: name };
}
