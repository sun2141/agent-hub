// src/agent/providers/antigravity.js
// Antigravity CLI (agy) 어댑터 — Gemini CLI 개인용 종료(2026-06-18) 이후 공식 후속.
// 인증: OAuth 디바이스 코드 1회 시드 → 토큰이 시스템 키링(Linux libsecret)에 캐시.
//   ⚠️ 무인 운영 시 키링 잠금 해제 필요(scripts/setup-antigravity-keyring.sh).
// 재개: --conversation <id> (또는 -c). 리미트: "Individual quota reached — Resets in Xh".
//   ⚠️ 한 대화 안에서 모델 전환 시 컨텍스트 손실(issue #163) → 전환은 항상 새 세션으로.

import {
  spawnCollect, prependCliNodePath, looksLikeLimit, parseResetDuration,
  minutesFromNow, DEFAULT_5H_BACKOFF_MIN,
} from './base.js';

const AGY_CLI   = process.env.AGY_CLI_PATH || 'agy';
const AGY_MODEL = process.env.AGY_MODEL || null; // 예: gemini-3-pro (미지정 시 기본값)

export const name = 'antigravity';

export function parseLimit(text = '') {
  if (!looksLikeLimit(text)) return { limitHit: false, resetAt: null, windowType: null };
  // agy는 개인 쿼터(individual quota) 단일 윈도우. 주간 개념 없이 "Resets in Xh".
  const resetAt = parseResetDuration(text) || minutesFromNow(DEFAULT_5H_BACKOFF_MIN);
  return { limitHit: true, resetAt, windowType: '5h' };
}

export function buildArgs({ prompt, resumeId }) {
  const args = ['-p', prompt, '--output-format', 'json'];
  if (AGY_MODEL) args.push('--model', AGY_MODEL);
  if (resumeId) args.push('--conversation', resumeId);
  return args;
}

// agy --output-format json 응답에서 conversation/session id와 텍스트 추출.
function extractFromJson(stdout) {
  let sessionId = null;
  let text = stdout.trim();
  try {
    const obj = JSON.parse(stdout);
    sessionId = obj.conversation_id || obj.conversationId || obj.session_id || obj.sessionId || null;
    if (typeof obj.result === 'string') text = obj.result;
    else if (typeof obj.output === 'string') text = obj.output;
    else if (typeof obj.text === 'string') text = obj.text;
  } catch { /* JSON 아니면 원문 유지 */ }
  return { sessionId, text };
}

export async function run({ taskId, phase, round, cwd, prompt, resumeId = null, onText }) {
  const args = buildArgs({ prompt, resumeId });
  const env = prependCliNodePath();
  const res = await spawnCollect({
    cmd: AGY_CLI, args, cwd, env, timeoutMs: 600_000,
    onStdout: (s) => { if (onText) onText(s); },
  });

  const combined = `${res.stdout}\n${res.stderr}`;
  const parsed = parseLimit(combined);
  if (parsed.limitHit) {
    return { status: 'limit', output: '', limitHit: true, resetAt: parsed.resetAt, windowType: parsed.windowType, provider: name };
  }
  if (res.spawnError) {
    return { status: 'error', output: '', error: `agy spawn 실패: ${res.stderr.slice(0, 200)}`, provider: name };
  }
  if (res.code !== 0 && !res.stdout.trim()) {
    return { status: 'error', output: '', error: `agy exit ${res.code}: ${res.stderr.slice(0, 200)}`, provider: name };
  }
  const { sessionId, text } = extractFromJson(res.stdout);
  return { status: 'ok', output: text, sessionId, provider: name };
}
