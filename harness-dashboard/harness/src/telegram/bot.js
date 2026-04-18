// src/telegram/bot.js
// Telegram 봇 — 명령어 수신 + 파이프라인 이벤트 알림

import TelegramBot from 'node-telegram-bot-api';
import { taskQueries, projectQueries } from '../db/db.js';

const PHASE_EMOJI = {
  planning:   '📋',
  building:   '🔨',
  evaluating: '🔍',
  done:       '✅',
  failed:     '❌',
  paused:     '⏸',
  pending:    '○',
};

export function createTelegramBot(agentRunner) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('[Telegram] 봇 토큰 또는 채팅 ID 미설정 — 봇 비활성화');
    return { bot: null, notify: () => {} };
  }

  const bot = new TelegramBot(token, { polling: true });

  function notify(text) {
    return bot.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(err => {
      console.error('[Telegram] 전송 실패:', err.message);
    });
  }

  // ── 명령어 핸들러 ─────────────────────────────────────────

  // /status — 하네스 상태
  bot.onText(/\/status/, () => {
    const status = agentRunner.getStatus();
    const running = status.running.length > 0
      ? `▶ 실행 중: <code>${status.running.join(', ')}</code>`
      : '○ 대기 중';
    const queue = status.queue.length > 0
      ? `\n대기열: ${status.queue.length}개`
      : '';

    let detail = '';
    if (status.currentTask) {
      const { phase, round } = status.currentTask;
      detail = `\n현재: ${PHASE_EMOJI[phase] || ''} ${phase} Round ${round}`;
    }

    notify(`<b>🤖 하네스 상태</b>\n\n${running}${detail}${queue}`);
  });

  // /run <project> <prompt>
  bot.onText(/\/run\s+(\S+)\s+(.+)/, async (msg, match) => {
    const projectId = match[1].trim();
    const prompt    = match[2].trim();

    if (!prompt) { notify('❗ 사용법: /run &lt;project_id&gt; &lt;작업 내용&gt;'); return; }

    try {
      const taskId = await agentRunner.run({ projectId, prompt });
      notify(
        `▶ <b>파이프라인 시작</b>\n\n` +
        `ID: <code>${taskId}</code>\n` +
        `프로젝트: ${projectId}\n` +
        `작업: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`
      );
    } catch (err) {
      notify(`❌ <b>시작 실패</b>\n${err.message}`);
    }
  });

  // /resume [taskId]
  bot.onText(/\/resume(?:\s+(\S+))?/, async (msg, match) => {
    let taskId = match[1]?.trim();

    if (!taskId) {
      // 가장 최근 paused 작업 찾기
      const paused = await taskQueries.listPaused();
      if (paused.length === 0) { notify('⏸ 재개 대기 중인 작업이 없습니다.'); return; }
      taskId = paused[0].id;
    }

    try {
      await agentRunner.resume(taskId);
      notify(`▶ <b>재개됨</b>\n<code>${taskId}</code>`);
    } catch (err) {
      notify(`❌ <b>재개 실패</b>\n${err.message}`);
    }
  });

  // /stop [taskId]
  bot.onText(/\/stop(?:\s+(\S+))?/, async (msg, match) => {
    const taskId = match[1]?.trim();
    const status = agentRunner.getStatus();

    const targetId = taskId || status.running[0];
    if (!targetId) { notify('○ 중지할 실행 중인 작업이 없습니다.'); return; }

    try {
      await agentRunner.stop(targetId);
      notify(`⏸ <b>중지됨</b>\n<code>${targetId}</code>`);
    } catch (err) {
      notify(`❌ <b>중지 실패</b>\n${err.message}`);
    }
  });

  // /tasks — 최근 작업 목록
  bot.onText(/\/tasks/, async () => {
    const tasks = await taskQueries.list(8);
    if (tasks.length === 0) { notify('○ 작업 이력이 없습니다.'); return; }

    const list = tasks.map(t => {
      let pipeline = '';
      try {
        if (t.checkpoint) {
          const cp = JSON.parse(t.checkpoint);
          pipeline = ` | R${cp.round} ${cp.phase || ''}`;
        }
      } catch { /* 무시 */ }
      const icon    = PHASE_EMOJI[t.status] || '?';
      const project = t.project_name || t.project_id || '';
      const prompt  = (t.prompt || '').slice(0, 30);
      return `${icon} <code>${t.id.slice(-10)}</code>${pipeline}\n   ${project} | ${prompt}...`;
    }).join('\n\n');

    notify(`<b>📋 최근 작업</b>\n\n${list}`);
  });

  // /projects — 프로젝트 목록
  bot.onText(/\/projects/, async () => {
    const projects = await projectQueries.list();
    if (projects.length === 0) { notify('○ 등록된 프로젝트가 없습니다.'); return; }

    const list = projects.map(p => {
      const taskInfo = p.latestTask
        ? ` — ${PHASE_EMOJI[p.latestTask.status] || ''} ${p.latestTask.status}`
        : '';
      return `• <b>${p.name}</b> (<code>${p.id}</code>)${taskInfo}`;
    }).join('\n');

    notify(`<b>📁 프로젝트 목록</b>\n\n${list}`);
  });

  // /help
  bot.onText(/\/help|\/start/, () => {
    notify(
      '<b>🤖 Agent Harness</b>\n\n' +
      '<b>명령어:</b>\n' +
      '/status — 하네스 실행 상태\n' +
      '/projects — 프로젝트 목록\n' +
      '/run &lt;id&gt; &lt;prompt&gt; — 파이프라인 실행\n' +
      '/resume [taskId] — 한도 후 재개\n' +
      '/stop [taskId] — 작업 중지\n' +
      '/tasks — 최근 작업 이력\n\n' +
      '<b>파이프라인:</b>\n' +
      '📋 Plan → 🔨 Build → 🔍 Eval → ✅'
    );
  });

  // 폴링 오류 처리
  bot.on('polling_error', (err) => {
    console.error('[Telegram] 폴링 오류:', err.message);
  });

  // ── 이벤트 → 알림 매핑 ───────────────────────────────────

  agentRunner.on('phase:start', ({ taskId, phase, round }) => {
    notify(`${PHASE_EMOJI[phase] || '▶'} <b>${phase}</b> 시작 (Round ${round})\n<code>${taskId}</code>`);
  });

  agentRunner.on('phase:complete', ({ taskId, phase, round }) => {
    notify(`✓ <b>${phase}</b> 완료 (Round ${round})\n<code>${taskId}</code>`);
  });

  agentRunner.on('task:complete', ({ task, rounds }) => {
    const taskId = task?.id || '';
    notify(
      `✅ <b>완료</b>\n\n` +
      `ID: <code>${taskId}</code>\n` +
      `총 라운드: ${rounds}`
    );
  });

  agentRunner.on('task:paused', ({ task, phase, round, reason }) => {
    const taskId = task?.id || '';
    const reasonText = reason === 'rate_limit'
      ? '사용량 한도 도달'
      : reason === 'manual_stop' ? '수동 중지' : reason;

    notify(
      `⏸ <b>일시정지</b>\n\n` +
      `ID: <code>${taskId}</code>\n` +
      `단계: ${PHASE_EMOJI[phase] || ''} ${phase} (Round ${round})\n` +
      `사유: ${reasonText}\n\n` +
      `한도 리셋 후 /resume 으로 재개`
    );
  });

  agentRunner.on('task:failed', ({ task, error }) => {
    const taskId = task?.id || '';
    notify(
      `❌ <b>실패</b>\n\n` +
      `ID: <code>${taskId}</code>\n` +
      `오류: ${String(error || '').slice(0, 200)}`
    );
  });

  agentRunner.on('task:queued', ({ taskId, queueLength }) => {
    notify(`📌 <b>큐에 추가됨</b>\n<code>${taskId}</code>\n대기열: ${queueLength}번째`);
  });

  console.log('[Telegram] 봇 활성화');
  return { bot, notify };
}
