// src/agent/providers/base.js
// 프로바이더 어댑터 공용 유틸 — 시간 포맷, 리미트 파싱, CLI 실행.
//
// 어댑터 통일 인터페이스:
//   run({ taskId, phase, round, cwd, prompt, resumeId, model, onText, onSessionId })
//     -> { status:'ok'|'limit'|'error', output, sessionId, limitHit, resetAt, windowType, error }
//   parseLimit(text) -> { limitHit, resetAt, windowType }   // resetAt: UTC 'YYYY-MM-DD HH24:MI:SS' | null
//
// resetAt은 DB(harness.providers.next_available_at)와 동일한 UTC 문자열 포맷을 사용한다.

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// ── UTC 'YYYY-MM-DD HH24:MI:SS' 포맷 (DB 컬럼과 동일) ──────────
export function toUtcString(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function minutesFromNow(minutes) {
  return toUtcString(new Date(Date.now() + minutes * 60_000));
}

export function hoursFromNow(hours) {
  return minutesFromNow(hours * 60);
}

// 보수적 기본 백오프 (파싱 실패 시): 5h 윈도우는 +60분, weekly는 +12시간
export const DEFAULT_5H_BACKOFF_MIN = 60;
export const DEFAULT_WEEKLY_BACKOFF_MIN = 12 * 60;

// ── 공통 리미트 신호 감지 ──────────────────────────────────────
const RATE_LIMIT_HINTS = [
  'rate limit', 'rate_limit', 'usage limit', 'usage_limit',
  "you've hit the limit", 'hit the limit', 'you have reached', 'reached your',
  'weekly limit', 'daily limit', 'limit reached',
  '429', 'overloaded', 'quota reached', 'quota exceeded',
  'individual quota', 'too many requests',
];

export function looksLikeLimit(text = '') {
  const t = String(text).toLowerCase();
  return RATE_LIMIT_HINTS.some(h => t.includes(h));
}

// ── 리셋 시각 파서 ─────────────────────────────────────────────
// "Resets in 3h", "resets in 45m", "reset in 2 hours 30 minutes" 등을 UTC 문자열로 변환.
export function parseResetDuration(text = '') {
  const t = String(text).toLowerCase();

  // "in Xh Ym" / "in X hours Y minutes"
  const hm = t.match(/(?:resets?|available|try again)\D{0,20}?(\d+)\s*h(?:ours?|rs?)?(?:\s*(\d+)\s*m(?:in(?:utes?)?)?)?/);
  if (hm) {
    const h = parseInt(hm[1], 10) || 0;
    const m = hm[2] ? parseInt(hm[2], 10) : 0;
    return minutesFromNow(h * 60 + m);
  }
  // "in Xm" / "X minutes"
  const mm = t.match(/(?:resets?|available|try again)\D{0,20}?(\d+)\s*m(?:in(?:utes?)?)?/);
  if (mm) return minutesFromNow(parseInt(mm[1], 10) || 0);

  return null;
}

// ── CLI 실행 (stdout/stderr 수집, 스트림 콜백) ─────────────────
// stdin은 항상 'ignore'로 비워 확인 프롬프트 대기 정지를 원천 차단한다.
export function spawnCollect({ cmd, args, cwd, env, timeoutMs = 600_000, onStdout, onStderr }) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: err.message, spawnError: true, proc: null });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);
    proc.stdout.on('data', d => {
      const s = d.toString();
      stdout += s;
      if (stdout.length > 400_000) stdout = stdout.slice(-200_000);
      if (onStdout) onStdout(s);
    });
    proc.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      if (onStderr) onStderr(s);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[timeout] ${Math.round(timeoutMs / 1000)}초 초과로 강제 종료`;
      resolve({ code: code ?? 1, stdout, stderr, timedOut, proc });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}`, spawnError: true, proc });
    });
  });
}

// PATH에 node 바이너리 디렉토리를 앞세워 CLI가 올바른 node를 찾도록 함.
export function prependCliNodePath(env = process.env) {
  const dirs = [];
  const add = (nodePath) => {
    if (!nodePath) return;
    try { if (fs.existsSync(nodePath)) dirs.push(path.dirname(fs.realpathSync(nodePath))); } catch {}
  };
  add(process.env.NODE_BIN);
  add(process.execPath);
  return { ...env, PATH: [...new Set([...dirs, env.PATH].filter(Boolean))].join(path.delimiter) };
}
