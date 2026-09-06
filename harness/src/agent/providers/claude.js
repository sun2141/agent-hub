// src/agent/providers/claude.js
// Claude Code CLI 어댑터 (구독 인증, stream-json 헤드리스).
// 인증: CLAUDE_CONFIG_DIR 이 인증된 .claude/ 를 가리켜야 함.
// 재개: --resume <session_id>. 리미트: 5h 롤링 윈도우(Pro는 주간 캡도 있음).

import { spawn } from 'child_process';
import {
  prependCliNodePath, looksLikeLimit, parseResetDuration,
  minutesFromNow, DEFAULT_5H_BACKOFF_MIN, attachWatchdog,
} from './base.js';

const CLAUDE_CLI   = process.env.CLAUDE_CLI_PATH || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const PLAN_MODEL   = process.env.PLAN_MODEL || CLAUDE_MODEL;

export const name = 'claude';

// Pro 주간 캡 문구 감지 → weekly, 그 외 → 5h
export function parseLimit(text = '') {
  if (!looksLikeLimit(text)) return { limitHit: false, resetAt: null, windowType: null };
  const t = String(text).toLowerCase();
  const weekly = t.includes('week') || t.includes('weekly');
  const windowType = weekly ? 'weekly' : '5h';
  const resetAt = parseResetDuration(text) || minutesFromNow(DEFAULT_5H_BACKOFF_MIN);
  return { limitHit: true, resetAt, windowType };
}

export function resumeArgs(sessionId) {
  return sessionId ? ['--resume', sessionId] : [];
}

// run: stream-json을 파싱해 세션ID 캡처 + 리미트 감지.
export function run({ taskId, phase, round, cwd, prompt, resumeId = null, onText, onSessionId }) {
  return new Promise((resolve) => {
    const model = phase === 'plan' ? PLAN_MODEL : CLAUDE_MODEL;
    const args = [
      '--print', '--verbose',
      '--output-format', 'stream-json',
      '--model', model,
      '--dangerously-skip-permissions',
      ...resumeArgs(resumeId),
      prompt,
    ];
    const env = prependCliNodePath({ ...process.env, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR });

    let proc;
    try {
      proc = spawn(CLAUDE_CLI, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ status: 'error', output: '', error: `spawn 실패: ${err.message}`, provider: name });
      return;
    }

    // 행(hang) 감시. 이 파일에만 감시가 없어서, 가장 오래 걸리고 가장 잘 물리는
    // Build 단계가 무한정 매달릴 수 있었다.
    const wd = attachWatchdog(proc, { label: 'Claude CLI' });

    let finalResult = null;
    let assistant = [];
    let buffer = '';
    let sessionId = null;
    let sessionNotified = false;
    let limit = null;
    let settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve({ ...r, provider: name, sessionId }); } };

    const detect = (text) => {
      if (limit) return;
      const parsed = parseLimit(text);
      if (parsed.limitHit) { limit = parsed; try { proc.kill('SIGTERM'); } catch {} }
    };

    proc.stdout.on('data', (chunk) => {
      wd.notifyActivity();
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (!sessionNotified && msg.session_id) {
          sessionNotified = true;
          sessionId = msg.session_id;
          if (onSessionId) { try { onSessionId(sessionId); } catch {} }
        }
        if (msg.error) detect(String(msg.error));
        if (msg.type === 'result' && msg.is_error) {
          detect(typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result || ''));
        }
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              assistant.push(block.text);
              if (onText) onText(block.text);
              detect(block.text);
            }
          }
        } else if (msg.type === 'result' && !msg.is_error && msg.result != null) {
          finalResult = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result);
        }
      }
    });

    proc.stderr.on('data', (chunk) => { wd.notifyActivity(); detect(chunk.toString()); });

    proc.on('close', (code) => {
      wd.clear();
      if (limit) return settle({ status: 'limit', output: '', limitHit: true, resetAt: limit.resetAt, windowType: limit.windowType });
      // 감시기가 죽인 경우는 리미트도 정상 종료도 아니다. 조용히 빈 결과로 넘기면
      // 파이프라인이 "출력이 없네" 하고 다음 라운드로 가버린다 — 실패로 못 박는다.
      const killed = wd.reason();
      if (killed) return settle({ status: 'error', output: '', error: killed, hung: true });
      const output = (finalResult && finalResult.trim()) ? finalResult : assistant.join('\n').trim();
      // 안전망: 비정상 종료 + 짧은 출력에 리미트 흔적
      if (code !== 0 && output.length < 500 && looksLikeLimit(output)) {
        const parsed = parseLimit(output);
        return settle({ status: 'limit', output, limitHit: true, resetAt: parsed.resetAt, windowType: parsed.windowType });
      }
      if (code !== 0 && !output) return settle({ status: 'error', output: '', error: `Claude CLI 비정상 종료 (code=${code})` });
      settle({ status: 'ok', output: output.trim() });
    });
    proc.on('error', (err) => { wd.clear(); settle({ status: 'error', output: '', error: `Claude CLI 실행 실패: ${err.message}` }); });
  });
}
