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

// ── 프로세스 감시기 ────────────────────────────────────────────
// CLI가 물리면(hang) Promise가 영원히 resolve되지 않는다. 사람이 승인할 때는
// "왜 안 끝나지" 하고 들여다봤지만, 목표 계층의 자동 실행에서는 그 눈이 없어서
// 며칠을 멈춰 있어도 모른다.
//
// 절대 시간만으로는 부족하다 — 정상적인 긴 빌드와 물린 프로세스를 구분하지 못해서
// 넉넉하게 잡으면 행을 못 잡고, 빡빡하게 잡으면 멀쩡한 작업을 죽인다.
// **무출력 지속 시간(idle)**이 둘을 가르는 신호다: 살아 있는 CLI는 뭐라도 내보낸다.
export const PROVIDER_IDLE_TIMEOUT_MS =
  parseInt(process.env.PROVIDER_IDLE_TIMEOUT_MIN || '10', 10) * 60_000;
export const PROVIDER_HARD_TIMEOUT_MS =
  parseInt(process.env.PROVIDER_HARD_TIMEOUT_MIN || '45', 10) * 60_000;

// SIGTERM 후 이만큼 기다렸다 SIGKILL. 정리할 기회는 주되 무한정은 아니다.
const KILL_GRACE_MS = 10_000;

/**
 * proc에 idle/hard 타임아웃을 건다.
 * @returns {{ notifyActivity: () => void, clear: () => void, reason: () => string|null }}
 *   notifyActivity()를 stdout/stderr 수신 때마다 불러 idle 타이머를 되돌린다.
 */
export function attachWatchdog(proc, { idleTimeoutMs = PROVIDER_IDLE_TIMEOUT_MS,
                                       hardTimeoutMs = PROVIDER_HARD_TIMEOUT_MS,
                                       label = 'CLI' } = {}) {
  let killReason = null;
  let idleTimer = null;
  let killTimer = null;

  const kill = (reason) => {
    if (killReason) return;
    killReason = reason;
    try { proc.kill('SIGTERM'); } catch { /* 이미 죽음 */ }
    killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* 무시 */ } }, KILL_GRACE_MS);
    if (killTimer.unref) killTimer.unref();
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!idleTimeoutMs) return;
    idleTimer = setTimeout(
      () => kill(`${label}이(가) ${Math.round(idleTimeoutMs / 60000)}분간 아무 출력도 내지 않아 행(hang)으로 판단하고 종료했습니다`),
      idleTimeoutMs
    );
    if (idleTimer.unref) idleTimer.unref();
  };

  const hardTimer = hardTimeoutMs
    ? setTimeout(
        () => kill(`${label} 실행이 ${Math.round(hardTimeoutMs / 60000)}분을 넘겨 종료했습니다`),
        hardTimeoutMs
      )
    : null;
  if (hardTimer?.unref) hardTimer.unref();

  armIdle();

  return {
    notifyActivity: armIdle,
    clear: () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (killTimer) clearTimeout(killTimer);
    },
    reason: () => killReason,
  };
}

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
    // 절대 시간(timeoutMs)은 상한으로 유지하고, 그 안에서 idle 감시가 행을 먼저 잡는다.
    const wd = attachWatchdog(proc, { hardTimeoutMs: timeoutMs, label: cmd });
    proc.stdout.on('data', d => {
      const s = d.toString();
      stdout += s;
      if (stdout.length > 400_000) stdout = stdout.slice(-200_000);
      wd.notifyActivity();
      if (onStdout) onStdout(s);
    });
    proc.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      wd.notifyActivity();
      if (onStderr) onStderr(s);
    });
    proc.on('close', code => {
      wd.clear();
      const killed = wd.reason();
      if (killed) stderr += `\n[watchdog] ${killed}`;
      resolve({ code: code ?? 1, stdout, stderr, timedOut: Boolean(killed), killReason: killed, proc });
    });
    proc.on('error', err => {
      wd.clear();
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
