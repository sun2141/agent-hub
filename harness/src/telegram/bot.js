// src/telegram/bot.js
// Telegram 봇 — 명령 수신 + 이벤트 알림
// VPS의 기존 봇과 토큰을 공유하지 않고, 로컬에서 독립 실행

import TelegramBot from 'node-telegram-bot-api';
import { projectQueries, taskQueries } from '../db/db.js';

const PHASE_EMOJI = {
  planning:   '📋',
  building:   '🔨',
  evaluating: '🔍',
  done:       '✅',
  failed:     '❌',
  paused:     '⏸',
};

export function createTelegramBot(agentRunner) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[Telegram] 환경변수 미설정 — 봇 비활성화');
    return { notify: () => {} };
  }

  const bot = new TelegramBot(token, { polling: true });
  console.log('[Telegram] 봇 시작됨');

  // ── 알림 헬퍼 ─────────────────────────────────────────────
  function notify(text) {
    return bot.sendMessage(chatId, text, { parse_mode: 'HTML' })
      .catch(err => console.error('[Telegram] 전송 실패:', err.message));
  }

  // ── 명령어 핸들러 ─────────────────────────────────────────

  // /help
  bot.onText(/\/help/, () => {
    notify(
      '<b>🤖 하네스 명령어</b>\n\n' +
      '/status — 시스템 상태\n' +
      '/projects — 프로젝트 목록\n' +
      '/run &lt;project&gt; &lt;작업내용&gt; — 파이프라인 시작\n' +
      '/resume &lt;taskId&gt; — 일시정지 재개\n' +
      '/stop &lt;taskId&gt; — 작업 중지\n' +
      '/tasks — 최근 작업 이력\n\n' +
      '<b>파이프라인:</b> 📋 Plan → 🔨 Build → 🔍 Eval → ✅'
    );
  });

  // /status
  bot.onText(/\/status/, () => {
    const s = agentRunner.getStatus();
    let msg = '<b>📊 하네스 상태</b>\n\n';

    if (s.running.length === 0) {
      msg += '⚪ 실행 중인 작업 없음\n';
    } else {
      msg += '<b>실행 중:</b>\n';
      msg += s.running.map(r =>
        `${PHASE_EMOJI[r.phase] || '▶'} <code>${r.taskId}</code>\n` +
        `   ${r.phase} (Round ${r.round})`
      ).join('\n') + '\n';
    }

    if (s.queued > 0) msg += `\n⏳ 대기 중: ${s.queued}개\n`;

    notify(msg);
  });

  // /projects
  bot.onText(/\/projects/, () => {
    const list = projectQueries.list();
    const msg = '<b>📁 프로젝트 목록</b>\n\n' +
      list.map(p =>
        `• <b>${p.name}</b> (<code>${p.id}</code>)\n` +
        `  ${p.stack || '스택미정'} | 최근: ${p.last_task_status || '없음'}`
      ).join('\n\n');
    notify(msg);
  });

  // /run <projectId> <prompt>
  bot.onText(/\/run (.+)/, async (msg, match) => {
    const parts = match[1].trim().split(' ');
    const projectId = parts[0];
    const prompt = parts.slice(1).join(' ');

    if (!prompt) {
      notify('사용법: /run &lt;projectId&gt; &lt;작업내용&gt;\n예: /run palmoni 기도 목록 페이지 추가');
      return;
    }

    const project = projectQueries.get(projectId);
    if (!project) {
      notify(`❌ 프로젝트 없음: <code>${projectId}</code>\n/projects 로 목록 확인`);
      return;
    }

    try {
      const taskId = await agentRunner.run({ projectId, prompt });
      notify(
        `📋 <b>파이프라인 시작</b>\n\n` +
        `ID: <code>${taskId}</code>\n` +
        `프로젝트: ${project.name}\n` +
        `작업: ${prompt.substring(0, 100)}`
      );
    } catch (err) {
      notify(`❌ 시작 실패: ${err.message}`);
    }
  });

  // /resume <taskId>
  bot.onText(/\/resume (.+)/, async (msg, match) => {
    const taskId = match[1].trim();
    try {
      await agentRunner.resume(taskId);
      notify(`▶ 재개: <code>${taskId}</code>`);
    } catch (err) {
      notify(`❌ 재개 실패: ${err.message}`);
    }
  });

  // /stop <taskId>
  bot.onText(/\/stop (.+)/, (msg, match) => {
    const taskId = match[1].trim();
    try {
      agentRunner.stop(taskId);
      notify(`⏹ 중지: <code>${taskId}</code>`);
    } catch (err) {
      notify(`❌ 중지 실패: ${err.message}`);
    }
  });

  // /tasks
  bot.onText(/\/tasks/, () => {
    const list = taskQueries.list(10);
    if (!list.length) { notify('최근 작업 없음'); return; }

    const msg = '<b>📋 최근 작업</b>\n\n' +
      list.map(t =>
        `${PHASE_EMOJI[t.status] || '❓'} <code>${t.id}</code>\n` +
        `   ${t.project_name} | ${t.prompt.substring(0, 40)}...`
      ).join('\n\n');
    notify(msg);
  });

  // ── 에이전트 이벤트 → 텔레그램 알림 ──────────────────────

  agentRunner.on('phase:start', ({ taskId, phase, round }) => {
    notify(`${PHASE_EMOJI[phase] || '▶'} <b>${phase}</b> Round ${round}\n<code>${taskId}</code>`);
  });

  agentRunner.on('task:complete', ({ taskId, round, evalResult, maxRoundsReached }) => {
    const flag = maxRoundsReached ? ' (최대 라운드 도달)' : '';
    notify(
      `✅ <b>완료</b>${flag}\n\n` +
      `ID: <code>${taskId}</code>\n` +
      `총 라운드: ${round}\n` +
      `평가 점수: ${evalResult?.score ?? '-'}/100`
    );
  });

  agentRunner.on('task:paused', ({ taskId, reason }) => {
    const label = reason === 'rate_limit' ? '사용량 한도 도달' : '수동 중지';
    notify(
      `⏸ <b>일시정지</b>\n\n` +
      `ID: <code>${taskId}</code>\n` +
      `사유: ${label}\n\n` +
      (reason === 'rate_limit' ? '리셋 후 /resume ' + taskId + ' 으로 재개' : '')
    );
  });

  agentRunner.on('task:failed', ({ taskId, error }) => {
    notify(
      `❌ <b>실패</b>\n\n` +
      `ID: <code>${taskId}</code>\n` +
      `오류: ${(error || '').substring(0, 200)}`
    );
  });

  return { bot, notify };
}
