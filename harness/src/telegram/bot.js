// src/telegram/bot.js
// Telegram 봇 — 명령 수신 + 이벤트 알림

import TelegramBot from 'node-telegram-bot-api';
import { checkBranchRunGate as sharedBranchRunGate } from '../agent/runGate.js';
import { projectQueries, taskQueries, backlogQueries, logQueries } from '../db/db.js';
import { formatResumeAt, humanizeAgo, formatLocal } from '../util/time.js';
import { spawnDetached } from './deploy_worker.js';
import { runManagerScan, formatScanDigest, parseDirective } from '../agent/manager.js';
import { listBacklog, addBacklogItem, findBacklogItem, MAX_ITEM_LENGTH } from '../agent/backlogFile.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { spawn, spawnSync } from 'child_process';

// 매니저 루프 (백로그 제안→승인→실행, 기본 off — MULTI_PROVIDER와 동일한 플래그 패턴)
const MANAGER_LOOP = process.env.MANAGER_LOOP === 'true';
// 자동 재개 타이머는 index.js에서 이 플래그로 켜진다 — /status에 상태를 그대로 노출한다.
const MULTI_PROVIDER = process.env.MULTI_PROVIDER === 'true';
const MANAGER_MAX_CONCURRENT = parseInt(process.env.MANAGER_MAX_CONCURRENT || '1', 10);
const MANAGER_MAX_APPROVALS_PER_DAY = parseInt(process.env.MANAGER_MAX_APPROVALS_PER_DAY || '3', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.resolve(__dirname, '../..');

// ── 쿨다운 영속화 파일 경로 ────────────────────────────────────
const COOLDOWN_FILE = path.join(HARNESS_ROOT, 'data', 'fail_notify_cooldown.json');

// 쿨다운 데이터 로드 (재시작 시에도 유지)
function loadCooldownData() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      const raw = fs.readFileSync(COOLDOWN_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Map으로 변환
      return new Map(Object.entries(parsed));
    }
  } catch (err) {
    console.warn('[Telegram] 쿨다운 파일 로드 실패 (초기화):', err.message);
  }
  return new Map();
}

// 쿨다운 데이터 저장
function saveCooldownData(map) {
  try {
    const dir = path.dirname(COOLDOWN_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj = Object.fromEntries(map.entries());
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[Telegram] 쿨다운 파일 저장 실패:', err.message);
  }
}

const PHASE_EMOJI = {
  pending:          '🕘',
  planning:         '📋',
  building:         '🔨',
  evaluating:       '🔍',
  fallback_running: '🔁',
  done:             '✅',
  failed:           '❌',
  paused:           '⏸',
  rate_limited:     '⏳',
  needs_review:     '⚠️',
};

function formatUptime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

export function escapeHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── 인라인 버튼 콜백 ──────────────────────────────────────────
// callback_data는 텔레그램 규격상 64바이트가 상한이다. 항목 문장을 그대로 실을 수 없으므로
// "프로젝트 id + 내용 해시(ref)"만 싣고, 누른 시점에 파일에서 다시 찾는다.
// 해시를 쓰기 때문에 파일에서 그 줄이 지워졌거나 수정됐으면 안전하게 "못 찾음"이 된다.
export const RUN_CALLBACK_PREFIX = 'blrun';
export const CALLBACK_DATA_LIMIT = 64;

export function encodeRunCallback(projectId, ref) {
  const data = `${RUN_CALLBACK_PREFIX}|${projectId}|${ref}`;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_LIMIT) return null;
  return data;
}

export function decodeRunCallback(data) {
  const parts = String(data ?? '').split('|');
  if (parts.length !== 3 || parts[0] !== RUN_CALLBACK_PREFIX) return null;
  const [, projectId, ref] = parts;
  if (!/^[A-Za-z0-9._-]+$/.test(projectId) || !/^[0-9a-f]{8,40}$/.test(ref)) return null;
  return { projectId, ref };
}

// 제안 승인/거부 버튼. 백로그 id는 backlog_<ms>_<8자> 라 40바이트 안쪽이다.
export const DECISION_CALLBACK_PREFIX = 'bldec';
export const BACKLOG_ID_RE = /^backlog_[0-9]+_[a-z0-9]+$/;

export function encodeDecisionCallback(action, id) {
  if (action !== 'apv' && action !== 'rej') return null;
  if (!BACKLOG_ID_RE.test(String(id ?? ''))) return null;
  const data = `${DECISION_CALLBACK_PREFIX}|${action}|${id}`;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_LIMIT) return null;
  return data;
}

export function decodeDecisionCallback(data) {
  const parts = String(data ?? '').split('|');
  if (parts.length !== 3 || parts[0] !== DECISION_CALLBACK_PREFIX) return null;
  const [, action, id] = parts;
  if (action !== 'apv' && action !== 'rej') return null;
  if (!BACKLOG_ID_RE.test(id)) return null;
  return { action, id };
}

// 제안 하나 = 메시지 하나. 버튼이 어느 항목의 것인지 헷갈릴 여지를 없앤다.
export const PROPOSALS_PER_MESSAGE_LIMIT = 8;

export function buildProposalMessage(item) {
  const apv = encodeDecisionCallback('apv', item.id);
  const rej = encodeDecisionCallback('rej', item.id);

  let text = `📥 <b>제안</b> — ${escapeHtml(item.project_name || item.project_id)}\n`;
  text += `<code>${escapeHtml(item.id)}</code>\n\n`;
  text += `<b>${escapeHtml(item.title)}</b>\n`;
  if (item.description) text += `${escapeHtml(String(item.description).slice(0, 400))}\n`;
  if (item.rationale) text += `\n근거: ${escapeHtml(String(item.rationale).slice(0, 200))}\n`;

  const row = [];
  if (apv) row.push({ text: '✅ 승인 (브랜치+PR)', callback_data: apv });
  if (rej) row.push({ text: '🚫 거부', callback_data: rej });
  if (!row.length) {
    text += `\n⚠️ 버튼을 만들 수 없습니다. <code>/approve ${escapeHtml(item.id)}</code> 로 실행하세요.`;
  }
  return { text, reply_markup: row.length ? { inline_keyboard: [row] } : undefined };
}

// 대기 목록만 보여주면 처리된 항목이 조용히 사라져서 "3개였는데 2개네?"가 된다.
// 최근 결정을 함께 보여줘 사라진 항목의 행방을 같은 화면에서 알 수 있게 한다.
export function buildProposalsHeader({ pending = [], recent = [], hidden = 0 } = {}) {
  let msg = `<b>📥 대기 중인 제안 ${pending.length}건</b>\n`;
  if (hidden > 0) msg += `(아래에 ${pending.length - hidden}건만 표시 — 나머지 ${hidden}건은 처리 후 다시 확인)\n`;

  const decided = recent.filter(r => r.status === 'approved' || r.status === 'rejected').slice(0, 5);
  if (decided.length) {
    msg += `\n<b>최근 처리됨</b>\n`;
    for (const d of decided) {
      const mark = d.status === 'approved' ? '✅' : '🚫';
      const when = d.decided_at ? ` · ${formatLocal(d.decided_at)}` : '';
      msg += `${mark} ${escapeHtml(String(d.title || '').slice(0, 44))}${when}\n`;
      if (d.task_id) msg += `   <code>${escapeHtml(d.task_id)}</code>\n`;
    }
    msg += `\n처리된 항목의 근거 신호는 소진되어 /scan 에 다시 올라오지 않습니다.\n`;
  }
  if (!pending.length && !decided.length) {
    msg += `\n제안이 없습니다. /scan 으로 백로그·GitHub 이슈를 읽어 후보를 만들어 보세요.\n`;
  }
  return msg;
}

// 원문 백로그를 프로젝트별 메시지로 조립한다. 버튼을 못 만드는 항목(id가 너무 긺)은
// 조용히 빠지는 대신 번호만 남기고 /run 안내를 붙인다 — 사라지면 원인을 알 수 없다.
export const BACKLOG_ITEMS_PER_PROJECT = 10;

export function buildBacklogSections(projects = []) {
  const sections = [];
  let total = 0;

  for (const proj of projects) {
    const items = (proj.items || []).slice(0, BACKLOG_ITEMS_PER_PROJECT);
    if (items.length === 0) continue;
    total += items.length;

    const hidden = (proj.items || []).length - items.length;
    let text = `📋 <b>${escapeHtml(proj.name || proj.id)}</b> — 백로그 ${items.length}건\n<code>${escapeHtml(proj.id)}</code>\n\n`;
    const rows = [];

    items.forEach((it, i) => {
      const n = i + 1;
      text += `${n}. ${escapeHtml(it.text)}\n`;
      const data = encodeRunCallback(proj.id, it.ref);
      if (data) {
        const label = it.text.length > 24 ? `${it.text.slice(0, 24)}…` : it.text;
        rows.push([{ text: `▶ ${n}. ${label}`, callback_data: data }]);
      } else {
        text += `   ⚠️ 버튼을 만들 수 없습니다 (id가 너무 깁니다). /run 으로 실행하세요.\n`;
      }
    });

    if (hidden > 0) text += `\n… 외 ${hidden}건 (파일에서 확인)\n`;
    text += `\n버튼을 누르면 브랜치+PR 모드로 바로 실행됩니다.`;
    sections.push({ projectId: proj.id, text, reply_markup: { inline_keyboard: rows } });
  }

  return { sections, total };
}

export function buildBacklogEmptyMessage(projects = []) {
  const missing = projects.filter(p => p.exists === false).map(p => p.id);
  let msg = '<b>📋 원문 백로그</b>\n\n등록된 항목이 없습니다.\n\n' +
    '<code>/add &lt;프로젝트&gt; &lt;내용&gt;</code> 으로 여기서 바로 추가할 수 있습니다.\n' +
    '예) <code>/add palmoni 로그인 실패 3회 시 60초 잠금. 남은 초를 응답에 포함</code>\n\n' +
    '검증 가능하게 쓸수록 결과물이 좋아집니다 — "성능 개선"보다 "목록 첫 렌더 50개만 조회"처럼.';
  if (missing.length) {
    msg += `\n\n⚠️ 디렉티브 파일이 없는 프로젝트: ${missing.map(escapeHtml).join(', ')}\n` +
           `<code>directives/projects/&lt;id&gt;.md</code> 가 있어야 추가할 수 있습니다.`;
  }
  return msg;
}

// ── 순수 메시지 빌더 ──────────────────────────────────────────
// 텔레그램/DB 의존 없이 데이터만 받아 문자열을 만든다 (tests/status_visibility.test.js).

export function buildStatusMessage({
  pid, uptimeSec = 0, multiProvider = false,
  running = [], queued = 0, waiting = [],
  activity = {}, waitingError = null, now = Date.now(),
}) {
  const act = (id) => activity[id] || '기록 없음';
  let msg = '<b>📊 하네스 상태</b>\n\n';
  msg += `PID: <code>${pid}</code>\n`;
  msg += `업타임: ${formatUptime(uptimeSec)}\n`;
  msg += `자동 재개: ${multiProvider ? '켜짐' : '⚠️ 꺼짐 (MULTI_PROVIDER=off)'}\n\n`;

  if (running.length === 0) {
    msg += '⚪ 실행 중인 작업 없음\n';
  } else {
    msg += '<b>실행 중:</b>\n';
    for (const r of running) {
      msg += `${PHASE_EMOJI[r.phase] || '▶'} <code>${r.taskId}</code>\n`;
      msg += `   ${r.phase} (Round ${r.round}) · 마지막 활동 ${act(r.taskId)}\n`;
    }
  }

  // 쿨다운 대기 작업은 메모리(_running)에서 지워지기 때문에
  // 이전에는 /status·/tasks 어디에도 나타나지 않았다. DB에서 직접 읽어 여기 표시한다.
  if (waitingError) {
    msg += `\n(쿨다운 대기 조회 실패: ${String(waitingError).slice(0, 80)})\n`;
  } else if (waiting.length) {
    msg += `\n<b>⏳ 쿨다운 대기 (${waiting.length}개):</b>\n`;
    for (const t of waiting) {
      msg += `<code>${t.id}</code>\n`;
      msg += t.scheduled_resume_at
        ? `   재개 예정: ${formatResumeAt(t.scheduled_resume_at, now)}\n`
        : `   ⚠️ 자동 재개 예약 없음 — <code>/resume ${t.id}</code> 필요\n`;
      msg += `   마지막 활동 ${act(t.id)}\n`;
    }
    if (!multiProvider) {
      msg += '\n⚠️ MULTI_PROVIDER가 꺼져 있어 예약 시각이 지나도 자동 재개되지 않습니다.\n';
    }
  }

  if (queued > 0) msg += `\n🕘 실행 대기 큐: ${queued}개\n`;
  return msg;
}

export function buildRateLimitedMessage({ taskId, resumeAt, now = Date.now() }) {
  if (resumeAt) {
    return `⏳ <b>프로바이더 쿨다운</b>\n<code>${taskId}</code>\n` +
           `재개 예정: ${formatResumeAt(resumeAt, now)}\n\n` +
           '재개되면 ▶️ 알림이 갑니다. 그 전까지 상태는 /status 에서 확인하세요.';
  }
  return `🛑 <b>사용량 한도로 중단</b>\n<code>${taskId}</code>\n` +
         '자동 재개 예약이 없습니다.\n\n' +
         `한도가 풀리면 <code>/resume ${taskId}</code> 로 재개하세요.`;
}

export function buildResumingMessage({ taskId, auto = false, round = null }) {
  return `▶️ <b>${auto ? '자동 재개됨' : '재개됨'}</b>\n<code>${taskId}</code>\n` +
         `Round ${round ?? '-'} · build 단계부터 다시 진행합니다.\n\n` +
         '진행 중 상태는 /status 로 확인하세요.';
}

export function createTelegramBot(agentRunner) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[Telegram] 환경변수 미설정 — 봇 비활성화');
    return { notify: () => {} };
  }

  // TELEGRAM_CHAT_ID는 숫자여야 함
  if (!/^-?\d+$/.test(chatId)) {
    throw new Error('TELEGRAM_CHAT_ID는 숫자 형식이어야 합니다');
  }

  // ── 폴링 에러 자동 재연결 (지수 백오프) ───────────────────
  // ENOTFOUND, ECONNRESET 등 네트워크 일시 단절 시 자동 재연결
  let reconnectAttempt = 0;
  const MAX_RECONNECT_DELAY_MS = 60000;
  const BASE_RECONNECT_DELAY_MS = 2000;
  let bot = null;
  let reconnectTimer = null;

  // ── 화이트리스트 검증 ─────────────────────────────────────
  function isAuthorized(msg) {
    return String(msg.chat.id) === String(chatId);
  }

  // ── 알림 헬퍼 ─────────────────────────────────────────────
  // extra로 reply_markup(인라인 버튼) 등을 그대로 넘길 수 있다.
  function notify(text, extra = {}) {
    if (!bot) return Promise.resolve();
    const safeText = String(text).substring(0, 4000);
    return bot.sendMessage(chatId, safeText, { parse_mode: 'HTML', ...extra })
      .catch(err => console.error('[Telegram] 전송 실패:', err.message));
  }

  // ── 인증된 요청에만 명령어 실행 ───────────────────────────
  // 핸들러가 async라 예외를 여기서 잡지 않으면 unhandledRejection으로 새고,
  // 사용자에게는 "아무 응답이 없는" 상태로만 보인다 — DB가 잠깐 흔들려도 명령이
  // 조용히 사라지는 셈이라 원인을 짐작할 수 없다. 실패도 반드시 알린다.
  function onCommand(pattern, handler) {
    bot.onText(pattern, async (msg, match) => {
      if (!isAuthorized(msg)) {
        console.warn(`[Telegram] 미인가 접근 시도: chat_id=${msg.chat.id}`);
        return;
      }
      try {
        await handler(msg, match);
      } catch (err) {
        const cmd = String(msg.text || '').split(/\s+/)[0] || String(pattern);
        console.error(`[Telegram] 명령 처리 실패 (${cmd}):`, err?.stack || err?.message || err);
        notify(`❌ <code>${cmd}</code> 처리 중 오류\n${String(err?.message || err).slice(0, 300)}`);
      }
    });
  }

  // 브랜치+PR 실행의 공용 상한. /approve(매니저 제안)와 /backlog 버튼이 같은 예산을 쓴다.
  // 예전에는 backlog_items의 승인 건수만 셌기 때문에, 제안을 거치지 않는 경로가
  // 생기면 일일 상한을 통째로 우회하게 된다.
  // registerCommands 밖에 둔다 — 인라인 버튼 콜백(registerCallbacks)도 같은 함수를 쓴다.
  // 공용 게이트로 위임한다 (src/agent/runGate.js).
  // 여기에 두 벌째 구현을 두면 한쪽만 고쳐져서 상한이 샌다 — 8/18에 겪은 실패다.
  async function checkBranchRunGate() {
    return sharedBranchRunGate();
  }

  // 승인·거부 로직은 명령어(/approve, /reject)와 인라인 버튼이 함께 쓴다.
  // 두 벌로 두면 한쪽만 고쳐져서 상한이 새거나 상태 전이가 어긋난다.
  async function approveProposal(id) {
    if (!BACKLOG_ID_RE.test(id)) return { ok: false, reason: '잘못된 백로그 ID 형식' };
    const item = await backlogQueries.get(id);
    if (!item) return { ok: false, reason: `백로그 항목 없음: ${id}` };
    if (item.status !== 'proposed') return { ok: false, reason: `이미 처리된 항목입니다 (상태: ${item.status})` };

    const gate = await checkBranchRunGate();
    if (gate) return { ok: false, reason: gate };

    const prompt = `${item.title}\n\n${item.description || ''}`.trim();
    const taskId = await agentRunner.run({ projectId: item.project_id, prompt, branchMode: true, backlogItemId: id });
    await backlogQueries.markApproved(id, taskId);
    return { ok: true, item, taskId };
  }

  async function rejectProposal(id) {
    if (!BACKLOG_ID_RE.test(id)) return { ok: false, reason: '잘못된 백로그 ID 형식' };
    const item = await backlogQueries.get(id);
    if (!item) return { ok: false, reason: `백로그 항목 없음: ${id}` };
    if (item.status !== 'proposed') return { ok: false, reason: `이미 처리된 항목입니다 (상태: ${item.status})` };
    await backlogQueries.markRejected(id);
    return { ok: true, item };
  }

  // 대기 중인 제안을 헤더 + 항목별 메시지(버튼 포함)로 보낸다. /proposals 와 /scan 이 공유한다.
  async function sendProposals(pending) {
    const shown = pending.slice(0, PROPOSALS_PER_MESSAGE_LIMIT);
    const recent = await backlogQueries.listRecent(10).catch(() => []);
    await notify(buildProposalsHeader({ pending, recent, hidden: pending.length - shown.length }));
    for (const item of shown) {
      const m = buildProposalMessage(item);
      await notify(m.text, m.reply_markup ? { reply_markup: m.reply_markup } : {});
    }
  }

  // ── 명령어 등록 ───────────────────────────────────────────
  function registerCommands() {
    onCommand(/\/help/, () => {
      notify(
        '<b>🤖 하네스 명령어</b>\n\n' +
        '/status — 시스템 상태\n' +
        '/projects — 프로젝트 목록\n' +
        '/run &lt;project&gt; [rounds:N] &lt;작업내용&gt; — 파이프라인 시작\n' +
        '/resume &lt;taskId&gt; — 일시정지 재개\n' +
        '/stop &lt;taskId&gt; — 작업 중지\n' +
        '/tasks — 최근 작업 이력\n' +
        '/restart — 하네스 프로세스 재시작\n' +
        '/deploy — git push + harness 재시작 (분리 프로세스)\n' +
        '/clone [projectId] — 프로젝트 저장소 내려받기 (인자 없으면 누락 목록)\n\n' +
        '<b>백로그 (내가 적은 요구사항)</b>\n' +
        '/backlog — 항목 목록 + <b>버튼 한 번으로 실행</b> (브랜치+PR)\n' +
        '/add &lt;프로젝트&gt; &lt;내용&gt; — 백로그에 한 줄 추가\n\n' +
        '<b>파이프라인:</b> 📋 Plan → 🔨 Build → 🔍 Eval → ✅\n\n' +
        '<b>rounds 예시:</b> /run facepick rounds:15 얼굴 인식 개선\n\n' +
        (MANAGER_LOOP
          ? '<b>매니저 루프</b>\n' +
            '/scan — 백로그·이슈를 읽어 LLM이 작업 후보 제안\n' +
            '/proposals — 대기 중인 제안 + <b>승인/거부 버튼</b> · 최근 처리 이력\n' +
            '/approve &lt;id&gt; — (버튼 대신 직접) 승인 → 브랜치+PR 모드로 실행\n' +
            '/reject &lt;id&gt; — (버튼 대신 직접) 거부\n' +
            '/rollback &lt;projectId&gt; — 최근 완료 커밋 되돌리기(revert)\n'
          : '<i>매니저 루프 비활성화 상태 (.env MANAGER_LOOP=true 로 활성화)</i>\n')
      );
    });

    // 마지막 로그 시각 = 실제 활동 신호. 멈춘 작업과 도는 작업을 구분하는 유일한 단서다.
    async function lastActivity(taskId) {
      try {
        const rows = await logQueries.forTask(taskId, 1);
        return rows?.[0]?.created_at ? humanizeAgo(rows[0].created_at) : '기록 없음';
      } catch { return '조회 실패'; }
    }

    onCommand(/\/status/, async () => {
      const s = agentRunner.getStatus();
      let waiting = [], waitingError = null;
      try {
        waiting = await taskQueries.getRateLimitedTasks();
      } catch (err) { waitingError = err.message; }

      const activity = {};
      for (const id of [...s.running.map(r => r.taskId), ...waiting.map(t => t.id)]) {
        activity[id] = await lastActivity(id);
      }

      notify(buildStatusMessage({
        pid: process.pid,
        uptimeSec: process.uptime(),
        multiProvider: MULTI_PROVIDER,
        running: s.running,
        queued: s.queued,
        waiting, activity, waitingError,
      }));
    });

    onCommand(/\/projects/, async () => {
      const list = await projectQueries.list();
      if (!list.length) {
        notify(
          '<b>📁 프로젝트 목록</b>\n\n등록된 프로젝트가 없습니다.\n' +
          'DB에 시드가 안 됐거나 전부 숨김 처리된 상태입니다.\n' +
          '하네스 기동 로그의 <code>[Boot] 프로젝트 N개 등록됨</code> 줄을 확인하세요.'
        );
        return;
      }
      const msg = '<b>📁 프로젝트 목록</b>\n\n' +
        list.map(p =>
          `• <b>${p.name}</b> (<code>${p.id}</code>)\n` +
          `  ${p.stack || '스택미정'} | 최근: ${p.last_task_status || '없음'}`
        ).join('\n\n');
      notify(msg);
    });

    // /run <projectId> [rounds:N] <prompt>
    onCommand(/\/run (.+)/, async (msg, match) => {
      const parts = match[1].trim().split(' ');
      const projectId = parts[0];

      if (!/^[a-z0-9-]{1,50}$/.test(projectId)) {
        notify('❌ 프로젝트 ID는 영문 소문자/숫자/하이픈만 허용됩니다');
        return;
      }

      let maxRounds;
      let promptStartIdx = 1;
      if (parts.length > 1 && /^rounds:\d+$/i.test(parts[1])) {
        const n = parseInt(parts[1].split(':')[1], 10);
        if (!isNaN(n) && n >= 1 && n <= 20) {
          maxRounds = n;
        }
        promptStartIdx = 2;
      }

      const prompt = parts.slice(promptStartIdx).join(' ');

      if (!prompt || prompt.length > 1000) {
        notify('사용법: /run &lt;projectId&gt; [rounds:N] &lt;작업내용(1000자 이하)&gt;\n예: /run palmoni 기도 목록 페이지 추가\n예: /run facepick rounds:15 얼굴 인식 개선');
        return;
      }

      const project = await projectQueries.get(projectId);
      if (!project) {
        notify(`❌ 프로젝트 없음: <code>${projectId}</code>\n/projects 로 목록 확인`);
        return;
      }

      try {
        const taskId = await agentRunner.run({ projectId, prompt, maxRounds });
        notify(
          `📋 <b>파이프라인 시작</b>\n\n` +
          `ID: <code>${taskId}</code>\n` +
          `프로젝트: ${project.name}\n` +
          `작업: ${prompt.substring(0, 100)}`
        );
      } catch (err) {
        notify(`❌ 시작 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // /resume <taskId>
    onCommand(/\/resume (.+)/, async (msg, match) => {
      const taskId = match[1].trim();
      if (!/^task_[0-9]+_[a-z0-9]+$/.test(taskId)) {
        notify('❌ 잘못된 taskId 형식');
        return;
      }
      try {
        // 성공 알림은 task:resuming 핸들러가 보낸다 (자동 재개와 문구를 통일).
        await agentRunner.resume(taskId);
      } catch (err) {
        notify(`❌ 재개 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // /stop <taskId>
    onCommand(/\/stop (.+)/, (msg, match) => {
      const taskId = match[1].trim();
      if (!/^task_[0-9]+_[a-z0-9]+$/.test(taskId)) {
        notify('❌ 잘못된 taskId 형식');
        return;
      }
      try {
        agentRunner.stop(taskId);
        notify(`⏹ 중지: <code>${taskId}</code>`);
      } catch (err) {
        notify(`❌ 중지 실패: ${err.message.substring(0, 200)}`);
      }
    });

    onCommand(/\/tasks/, async () => {
      const list = await taskQueries.list(10);
      if (!list.length) { notify('최근 작업 없음'); return; }

      const msg = '<b>📋 최근 작업</b>\n\n' +
        list.map(t =>
          `${PHASE_EMOJI[t.status] || '❓'} <code>${t.id}</code>\n` +
          `   ${t.project_name} | ${t.prompt.substring(0, 40)}...`
        ).join('\n\n');
      notify(msg);
    });

    // /restart — 하네스 프로세스 재시작 (분리 프로세스를 통해 self-kill 방지)
    onCommand(/\/restart/, async () => {
      notify('🔄 <b>하네스 재시작 중...</b>\n\n잠시 후 다시 연결됩니다.');

      const scriptPath = path.join(HARNESS_ROOT, 'scripts', 'deploy_detached.sh');
      if (!fs.existsSync(scriptPath)) {
        // deploy_detached.sh가 없으면 start.sh를 통해 재시작
        try {
          const logPath = await spawnDetached();
          notify(
            `✅ <b>재시작 프로세스 시작됨</b>\n\n` +
            `로그: <code>${logPath}</code>\n` +
            `약 10초 후 하네스가 재시작됩니다.`
          );
        } catch (err) {
          notify(`❌ 재시작 실패: ${err.message.substring(0, 200)}`);
        }
        return;
      }

      try {
        const logPath = await spawnDetached();
        notify(
          `✅ <b>재시작 프로세스 시작됨</b>\n\n` +
          `로그: <code>${logPath}</code>\n` +
          `약 10초 후 하네스가 재시작됩니다.`
        );
      } catch (err) {
        notify(`❌ 재시작 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // /deploy — 별도 자식 프로세스로 git push + 하네스 재시작
    onCommand(/\/deploy(?:\s+(.+))?/, async (msg, match) => {
      const targetArg = match[1]?.trim() || '';

      if (targetArg && !/^[a-z0-9-]{0,30}$/.test(targetArg)) {
        notify('❌ 잘못된 인자. 예: /deploy 또는 /deploy harness');
        return;
      }

      notify('🔄 <b>배포 시작</b>\n\ngit push + harness 재시작 중...');

      try {
        const logPath = await spawnDetached();
        notify(
          `✅ <b>배포 프로세스 시작됨</b>\n\n` +
          `로그: <code>${logPath}</code>\n` +
          `약 10초 후 하네스가 재시작됩니다.`
        );
      } catch (err) {
        notify(`❌ 배포 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // ── /clone — 등록된 프로젝트 저장소를 PROJECTS_ROOT 아래에 내려받는다 ──
    //
    // 왜 필요한가: projects.js의 프로젝트는 하네스 기동 시 DB에 자동 등록되지만,
    // 실제 저장소가 project.path에 없으면 작업이 그 자리에서 실패한다. 지금까지는
    // 서버에 직접 접속해 git clone 하는 수밖에 없었는데, 폰만 들고 있을 때는 불가능하다.
    //
    // 저장소 주소는 DB의 project.github, 없으면 디렉티브 파일의 "**GitHub**: owner/repo"
    // 에서 읽는다(스캔 신호와 같은 출처라 한쪽만 고치면 되는 상황을 피한다).

    // 셸을 거치지 않는 비동기 실행 — clone은 수 분이 걸릴 수 있어 봇을 막으면 안 된다.
    function execAsync(cmd, args, { cwd, timeoutMs = 600_000 } = {}) {
      return new Promise((resolve) => {
        let stdout = '', stderr = '', settled = false;
        const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
          if (settled) return;
          try { proc.kill('SIGKILL'); } catch { /* 무시 */ }
          stderr += `\n[timeout] ${Math.round(timeoutMs / 1000)}초 초과`;
        }, timeoutMs);
        proc.stdout.on('data', d => { stdout += d.toString().slice(0, 4000); });
        proc.stderr.on('data', d => { stderr += d.toString().slice(0, 4000); });
        proc.on('close', code => { settled = true; clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
        proc.on('error', err => { settled = true; clearTimeout(timer); resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}` }); });
      });
    }

    // DB에 github 슬러그가 없으면 디렉티브 파일에서 읽는다.
    function resolveRepoSlug(project) {
      if (project.github) return project.github.trim();
      const file = path.join(HARNESS_ROOT, '..', 'directives', 'projects', `${project.id}.md`);
      if (!fs.existsSync(file)) return null;
      try { return parseDirective(fs.readFileSync(file, 'utf8')).github; } catch { return null; }
    }

    function isCloned(p) {
      try { return fs.existsSync(path.join(p, '.git')); } catch { return false; }
    }

    // /clone            → 아직 내려받지 않은 프로젝트 목록
    // /clone <id>       → 해당 프로젝트 clone
    onCommand(/\/clone(?:\s+(\S+))?\s*$/, async (msg, match) => {
      const projectId = (match[1] || '').trim();

      if (!projectId) {
        const projects = await projectQueries.list();
        const missing = projects.filter(p => !isCloned(p.path));
        if (!missing.length) {
          notify('✅ 등록된 프로젝트가 모두 준비돼 있습니다.');
          return;
        }
        notify(
          '<b>📥 아직 없는 프로젝트</b>\n\n' +
          missing.map(p => {
            const slug = resolveRepoSlug(p);
            return `• <code>${p.id}</code> — ${slug ? slug : '⚠️ GitHub 주소 미등록'}`;
          }).join('\n') +
          '\n\n<code>/clone &lt;id&gt;</code> 로 내려받으세요.'
        );
        return;
      }

      if (!/^[a-z0-9-]{1,50}$/.test(projectId)) { notify('❌ 프로젝트 ID는 영문 소문자/숫자/하이픈만 허용됩니다'); return; }

      const project = await projectQueries.get(projectId);
      if (!project) { notify(`❌ 등록되지 않은 프로젝트: <code>${projectId}</code>\n/projects 로 목록을 확인하세요.`); return; }

      if (isCloned(project.path)) { notify(`✅ 이미 있습니다: <code>${project.path}</code>`); return; }

      // 폴더가 있는데 .git이 없으면 덮어쓰지 않는다 — 사용자가 뭔가 넣어둔 상태일 수 있다.
      if (fs.existsSync(project.path) && fs.readdirSync(project.path).length > 0) {
        notify(`❌ 경로에 이미 파일이 있는데 git 저장소가 아닙니다:\n<code>${project.path}</code>\n직접 정리한 뒤 다시 시도하세요.`);
        return;
      }

      const slug = resolveRepoSlug(project);
      if (!slug) {
        notify(
          `❌ <code>${projectId}</code> 의 GitHub 주소를 찾지 못했습니다.\n\n` +
          `<code>directives/projects/${projectId}.md</code> 의\n` +
          `<code>- **GitHub**: owner/repo</code> 줄을 채워주세요.`
        );
        return;
      }
      if (!/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(slug)) {
        notify(`❌ GitHub 주소 형식이 올바르지 않습니다: <code>${slug}</code> (owner/repo 형식이어야 합니다)`);
        return;
      }

      notify(`📥 <b>내려받는 중</b>\n${slug} → <code>${project.path}</code>\n(저장소가 크면 몇 분 걸립니다)`);

      try {
        fs.mkdirSync(path.dirname(project.path), { recursive: true });
        // gh auth 가 설정한 credential helper 를 쓰도록 HTTPS 로 받는다(무인 실행에 프롬프트 없음).
        const res = await execAsync('git', ['clone', `https://github.com/${slug}.git`, project.path], { timeoutMs: 600_000 });
        if (res.code !== 0) {
          const err = (res.stderr || res.stdout || 'git clone 실패').trim().slice(-500);
          notify(`❌ <b>clone 실패</b>\n<code>${slug}</code>\n\n${err}`);
          return;
        }

        // package.json 이 있으면 의존성까지 받아둔다 — 없으면 첫 검증 게이트가 바로 깨진다.
        let depNote = '';
        if (fs.existsSync(path.join(project.path, 'package.json'))) {
          notify('📦 의존성 설치 중... (npm install)');
          const npmRes = await execAsync('npm', ['install', '--no-audit', '--no-fund'], { cwd: project.path, timeoutMs: 900_000 });
          depNote = npmRes.code === 0
            ? '\n📦 의존성 설치 완료'
            : `\n⚠️ npm install 실패 — 수동 확인 필요:\n<code>${(npmRes.stderr || '').trim().slice(-300)}</code>`;
        }

        notify(
          `✅ <b>준비 완료</b>\n<code>${project.name}</code>\n${project.path}${depNote}\n\n` +
          `이제 <code>/scan</code> 대상에 포함됩니다.`
        );
      } catch (err) {
        notify(`❌ clone 중 오류: ${err.message.substring(0, 300)}`);
      }
    });

    // ── 매니저 루프 (백로그 제안→승인→실행) — MANAGER_LOOP=true 일 때만 동작 ──
    function requireManagerLoop() {
      if (!MANAGER_LOOP) {
        notify('⚠️ 매니저 루프가 비활성화되어 있습니다. .env에 MANAGER_LOOP=true 설정 후 재시작하세요.');
        return false;
      }
      return true;
    }

    // /scan — 등록된 프로젝트를 신호 스캔하고 새 제안을 백로그에 저장
    onCommand(/\/scan/, async () => {
      if (!requireManagerLoop()) return;
      notify('🔍 스캔 시작... (프로젝트별 LLM 호출 — 다소 시간이 걸릴 수 있습니다)');
      try {
        const scanResult = await runManagerScan();
        await notify(formatScanDigest(scanResult));
        // 제안이 나왔으면 곧바로 누를 수 있게 버튼 메시지를 이어 보낸다 —
        // id를 복사해 /approve 를 치는 단계를 없애려는 것이 목적이다.
        if (scanResult.proposed?.length) {
          await sendProposals(await backlogQueries.listPending());
        }
      } catch (err) {
        notify(`❌ 스캔 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // /backlog — 대기 중(proposed)인 제안 목록
    // /backlog — directives의 "원문 백로그"를 프로젝트별로 보여주고 항목마다 실행 버튼을 단다.
    // (LLM 제안 목록은 /proposals 로 옮겼다. 둘을 한 이름으로 부르니 매번 헷갈렸다.)
    onCommand(/\/backlog/, async () => {
      const projects = await projectQueries.list();
      const withItems = projects.map(p => {
        const r = listBacklog(p.id);
        return { id: p.id, name: p.name, exists: r.exists, items: r.items };
      });

      const { sections, total } = buildBacklogSections(withItems);
      if (total === 0) { notify(buildBacklogEmptyMessage(withItems)); return; }

      for (const sec of sections) {
        await notify(sec.text, { reply_markup: sec.reply_markup });
      }
    });

    // /proposals — 매니저 루프가 LLM으로 만든 작업 후보(DB backlog_items). 예전 /backlog.
    onCommand(/\/proposals/, async () => {
      if (!requireManagerLoop()) return;
      await sendProposals(await backlogQueries.listPending());
    });

    // /add <projectId> <내용> — directives 파일의 "## Backlog"에 한 줄 추가.
    // 지금까지 백로그는 파일 편집이나 GitHub 이슈로만 넣을 수 있어서, 폰에서는 사실상 불가능했다.
    onCommand(/\/add\s+(\S+)\s+([\s\S]+)/, async (msg, match) => {
      const projectId = match[1].trim();
      const text = match[2].trim();

      const project = await projectQueries.get(projectId);
      if (!project) {
        notify(`❌ 프로젝트 없음: <code>${escapeHtml(projectId)}</code>\n/projects 로 id를 확인하세요.`);
        return;
      }
      try {
        const added = addBacklogItem(projectId, text);
        if (added.duplicate) {
          notify(`ℹ️ 이미 같은 항목이 있습니다.\n[${escapeHtml(projectId)}] ${escapeHtml(added.text)}`);
          return;
        }
        const count = listBacklog(projectId).items.length;
        notify(
          `📝 <b>백로그 추가</b>\n[${escapeHtml(projectId)}] ${escapeHtml(added.text)}\n\n` +
          `현재 ${count}건. /backlog 에서 버튼으로 바로 실행할 수 있습니다.`
        );
      } catch (err) {
        notify(`❌ 추가 실패: ${escapeHtml(err.message)}\n\n최대 ${MAX_ITEM_LENGTH}자입니다.`);
      }
    });

    // /approve <backlogId> — 상한 체크 후 branchMode:true로 파이프라인 시작
    onCommand(/\/approve (\S+)/, async (msg, match) => {
      if (!requireManagerLoop()) return;
      const id = match[1].trim();
      if (!/^backlog_[0-9]+_[a-z0-9]+$/.test(id)) { notify('❌ 잘못된 백로그 ID 형식'); return; }

      try {
        const res = await approveProposal(id);
        if (!res.ok) { notify(`❌ ${escapeHtml(res.reason)}`); return; }
        notify(
          `✅ <b>승인됨</b>\n${escapeHtml(res.item.title)}\n` +
          `<code>${id}</code> → <code>${res.taskId}</code>\n\n` +
          `브랜치+PR 모드로 실행됩니다. 완료 시 PR 링크를 알려드립니다(자동 병합 없음).`
        );
      } catch (err) {
        notify(`❌ 실행 시작 실패: ${escapeHtml(String(err.message).substring(0, 200))}`);
      }
    });

    // /reject <backlogId>
    onCommand(/\/reject (\S+)/, async (msg, match) => {
      if (!requireManagerLoop()) return;
      const id = match[1].trim();
      if (!/^backlog_[0-9]+_[a-z0-9]+$/.test(id)) { notify('❌ 잘못된 백로그 ID 형식'); return; }
      const res = await rejectProposal(id);
      if (!res.ok) { notify(`❌ ${escapeHtml(res.reason)}`); return; }
      notify(`🚫 <b>거부됨</b>\n${escapeHtml(res.item.title)}\n<code>${id}</code>`);
    });

    // /rollback <projectId> — 가장 최근 완료(done) 작업의 커밋을 git revert + push (break-glass, 직접 실행)
    onCommand(/\/rollback (.+)/, async (msg, match) => {
      if (!requireManagerLoop()) return;
      const projectId = match[1].trim();
      if (!/^[a-z0-9-]{1,50}$/.test(projectId)) { notify('❌ 프로젝트 ID는 영문 소문자/숫자/하이픈만 허용됩니다'); return; }

      const project = await projectQueries.get(projectId);
      if (!project) { notify(`❌ 프로젝트 없음: <code>${projectId}</code>`); return; }

      // branch_mode(매니저 승인) 작업은 제외 — 그 커밋은 미병합 task 브랜치에만 있어서
      // 기본 브랜치에서 revert할 수 없다. 취소하려면 PR을 닫으면 된다.
      const lastDone = await taskQueries.getLastDoneWithCommit(projectId);
      if (!lastDone?.commit_sha) {
        notify(`❌ 롤백할 커밋을 찾지 못했습니다 (direct push로 완료된 작업 없음): <code>${projectId}</code>\n매니저 승인 작업은 PR을 닫아서 취소하세요.`);
        return;
      }

      // 진행 중인 작업이 있으면 롤백 금지 — 에이전트가 쓰고 있는 워킹트리를 건드리게 된다.
      const activeTask = await taskQueries.getActiveForProject(projectId);
      if (activeTask) {
        notify(`❌ 실행 중인 작업이 있어 롤백할 수 없습니다: <code>${activeTask.id}</code> (${activeTask.status})`);
        return;
      }

      notify(`⏪ <b>롤백 시작</b>\n프로젝트: ${project.name}\n대상 커밋: <code>${lastDone.commit_sha.slice(0, 10)}</code> (task=<code>${lastDone.id}</code>)`);
      try {
        const rootRes = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: project.path, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
        if (rootRes.error || rootRes.status !== 0) throw new Error('git 저장소를 찾을 수 없습니다');
        const gitRoot = rootRes.stdout.trim();

        // 사전 체크 1: 워킹트리가 clean해야 한다. dirty면 revert가 사용자의 미커밋 변경과
        // 섞이거나 중간 상태로 멈춘다.
        const dirtyRes = spawnSync('git', ['status', '--porcelain'], { cwd: gitRoot, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
        const dirty = (dirtyRes.stdout || '').trim();
        if (dirty) {
          throw new Error(`워킹트리에 커밋되지 않은 변경이 있습니다. 정리 후 재시도하세요:\n${dirty.split('\n').slice(0, 8).join('\n')}`);
        }

        // 사전 체크 2: 현재 브랜치가 task/* 면 중단 — 롤백은 기본 브랜치에서만.
        const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: gitRoot, encoding: 'utf8', timeout: 5_000, stdio: 'pipe' });
        const currentBranch = (branchRes.stdout || '').trim();
        if (currentBranch.startsWith('task/')) {
          throw new Error(`현재 브랜치가 <code>${currentBranch}</code> 입니다. 기본 브랜치로 전환 후 재시도하세요.`);
        }

        // 사전 체크 3: 대상 커밋이 현재 HEAD의 조상이어야 revert가 의미를 갖는다.
        const ancestorRes = spawnSync('git', ['merge-base', '--is-ancestor', lastDone.commit_sha, 'HEAD'], { cwd: gitRoot, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
        if (ancestorRes.status !== 0) {
          throw new Error(`대상 커밋이 현재 브랜치(${currentBranch}) 히스토리에 없습니다. 이미 되돌렸거나 다른 브랜치의 커밋입니다.`);
        }

        const revertRes = spawnSync('git', ['revert', '--no-edit', lastDone.commit_sha], { cwd: gitRoot, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' });
        if (revertRes.error || revertRes.status !== 0) {
          // 충돌 등으로 중간 상태에 멈췄으면 되돌려서 저장소를 원상 복구한다.
          spawnSync('git', ['revert', '--abort'], { cwd: gitRoot, encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
          throw new Error((revertRes.stderr || revertRes.stdout || 'git revert 실패').trim().slice(0, 300));
        }

        const pushRes = spawnSync('git', ['push'], { cwd: gitRoot, encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
        if (pushRes.error || pushRes.status !== 0) {
          const pushErr = (pushRes.stderr || pushRes.stdout || 'git push 실패').trim().slice(0, 300);
          throw new Error(`revert 커밋은 로컬에 생성됐지만 push에 실패했습니다 (${currentBranch}):\n${pushErr}`);
        }

        notify(`✅ <b>롤백 완료</b>\n${project.name} (${currentBranch})에서 <code>${lastDone.commit_sha.slice(0, 10)}</code>를 되돌리고 push했습니다.`);
      } catch (err) {
        notify(`❌ 롤백 실패: ${err.message.substring(0, 400)}`);
      }
    });

    registerCallbacks();
  }

  // 한 항목이 처리되는 동안 같은 버튼이 다시 들어오는 걸 막는다.
  // 텔레그램은 탭 한 번에 콜백이 두 번 도착하는 경우가 있고, 그러면 작업이 두 개 생긴다.
  const _runningCallbacks = new Set();

  // ── 인라인 버튼(콜백) 처리 ────────────────────────────────
  // 명령어(onCommand)와 동일한 chat id 화이트리스트를 적용한다. 버튼은 메시지를 전달받은
  // 누구나 누를 수 있으므로, 인가 검증을 빼먹으면 명령어 화이트리스트가 무의미해진다.
  function registerCallbacks() {
    bot.on('callback_query', async (query) => {
      const fromChat = query.message?.chat?.id;
      if (String(fromChat) !== String(chatId)) {
        console.warn(`[Telegram] 미인가 콜백: chat_id=${fromChat}`);
        try { await bot.answerCallbackQuery(query.id, { text: '권한이 없습니다' }); } catch { /* 무시 */ }
        return;
      }

      let answered = false;
      const answer = async (text, alert = false) => {
        if (answered) return;
        answered = true;
        // 응답하지 않으면 사용자 화면에 로딩 스피너가 계속 돈다.
        try { await bot.answerCallbackQuery(query.id, { text: String(text).slice(0, 190), show_alert: alert }); }
        catch (err) { console.warn('[Telegram] answerCallbackQuery 실패:', err.message); }
      };

      // 버튼은 두 종류다: 원문 백로그 실행(blrun)과 제안 승인/거부(bldec).
      const run = decodeRunCallback(query.data);
      const decision = run ? null : decodeDecisionCallback(query.data);
      if (!run && !decision) { await answer('알 수 없는 버튼입니다'); return; }

      // 연타 방지 키는 콜백 데이터 자체 — 같은 버튼이 두 번 들어와도 한 번만 처리된다.
      const key = String(query.data);
      if (_runningCallbacks.has(key)) { await answer('이미 처리 중입니다'); return; }
      _runningCallbacks.add(key);

      // 처리한 항목의 버튼은 걷어낸다. 눌러도 반응 없는 버튼을 남기면 고장으로 보인다.
      const clearKeyboard = async () => {
        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: query.message.chat.id, message_id: query.message.message_id }
          );
        } catch (err) { console.warn('[Telegram] 버튼 제거 실패:', err.message); }
      };

      try {
        if (run) {
          const { projectId, ref } = run;
          // 해시로 다시 찾는다 — 그 사이 항목이 지워졌거나 문장이 바뀌었으면 여기서 걸린다.
          const item = findBacklogItem(projectId, ref);
          if (!item) {
            await answer('백로그에서 항목을 찾지 못했습니다. 파일이 바뀌었을 수 있습니다 — /backlog 로 다시 불러오세요', true);
            return;
          }

          const gate = await checkBranchRunGate();
          if (gate) { await answer(gate, true); notify(`❌ 백로그 실행 거부\n${escapeHtml(gate)}`); return; }

          await answer('실행을 시작합니다…');
          const taskId = await agentRunner.run({ projectId, prompt: item.text, branchMode: true });

          // 버튼으로 이미 실행한 항목을 /scan이 "아직 안 한 요구사항"으로 보고 다시 제안하면
          // 같은 일이 두 번 돈다. 매니저가 쓰는 소진 기록에 같은 형식으로 남겨 둔다.
          // 파일은 건드리지 않는다 — 사람이 편집 중일 수 있다.
          try {
            await backlogQueries.markSignalsSeen(projectId, [{ source: 'backlog_file', source_ref: ref }]);
          } catch (err) {
            console.warn(`[Telegram] 백로그 신호 소진 기록 실패 (${projectId}/${ref}): ${err.message}`);
          }

          notify(
            `✅ <b>백로그 실행</b>\n[${escapeHtml(projectId)}] ${escapeHtml(item.text)}\n` +
            `<code>${taskId}</code>\n\n브랜치+PR 모드입니다. 완료되면 PR 링크를 보냅니다(자동 병합 없음).\n` +
            `이 항목은 /scan 재제안 대상에서 제외됩니다 (파일의 <code>- [ ]</code>는 그대로).`
          );
          await clearKeyboard();
          return;
        }

        // ── 제안 승인 / 거부 ──
        const { action, id } = decision;
        if (action === 'rej') {
          const res = await rejectProposal(id);
          if (!res.ok) { await answer(res.reason, true); return; }
          await answer('거부했습니다');
          notify(`🚫 <b>거부됨</b>\n${escapeHtml(res.item.title)}\n<code>${escapeHtml(id)}</code>`);
          await clearKeyboard();
          return;
        }

        await answer('승인 처리 중…');
        const res = await approveProposal(id);
        if (!res.ok) {
          // 상한 초과나 중복 승인은 흔한 경우다 — 알림으로도 남겨 원인을 알 수 있게 한다.
          await answer(res.reason, true);
          notify(`❌ <b>승인 거부</b>\n<code>${escapeHtml(id)}</code>\n${escapeHtml(res.reason)}`);
          return;
        }
        notify(
          `✅ <b>승인됨</b>\n${escapeHtml(res.item.title)}\n` +
          `<code>${escapeHtml(id)}</code> → <code>${res.taskId}</code>\n\n` +
          `브랜치+PR 모드로 실행됩니다. 완료 시 PR 링크를 알려드립니다(자동 병합 없음).`
        );
        await clearKeyboard();
      } catch (err) {
        console.error('[Telegram] 콜백 처리 실패:', err?.stack || err?.message || err);
        await answer('처리 실패 — 메시지를 확인하세요', true);
        notify(`❌ <b>버튼 처리 실패</b>\n${escapeHtml(String(err?.message || err).slice(0, 300))}`);
      } finally {
        _runningCallbacks.delete(key);
      }
    });
  }

  // ── 에이전트 이벤트 → 텔레그램 알림 ───────────────────────
  // 프로젝트별 마지막 실패 알림 시간 (알림 쿨다운 추적용)
  // 파일에서 로드하여 하네스 재시작 시에도 쿨다운 유지
  const _lastFailNotify = loadCooldownData(); // projectId → { lastNotify, failCount }
  const FAIL_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000; // 10분 쿨다운
  // 연속 실패 횟수가 이 이상이면 알림 완전 억제 (빌드 실패 반복 방지)
  const MAX_CONSECUTIVE_FAIL_NOTIFY = 3;

  function registerAgentEvents() {
    agentRunner.on('phase:start', ({ taskId, phase, round }) => {
      // planning 시작만 알림 (building/evaluating은 중간 단계라 생략)
      if (phase === 'planning') {
        notify(`${PHASE_EMOJI[phase] || '▶'} <b>${phase}</b>\n<code>${taskId}</code>`);
      }
    });

    agentRunner.on('task:complete', ({ taskId, round, evalResult, maxRoundsReached, projectId, reportInfo, prUrl }) => {
      const flag = maxRoundsReached ? ' (최대 라운드 도달)' : '';
      // 작업 완료 시 해당 프로젝트의 연속 실패 카운터 리셋
      const pid = projectId || taskId;
      if (_lastFailNotify.has(pid)) {
        const entry = _lastFailNotify.get(pid);
        entry.failCount = 0;
        saveCooldownData(_lastFailNotify);
      }
      const prNote = prUrl ? `\n\n🔀 <b>PR:</b> ${prUrl}\n(자동 병합 없음 — 확인 후 직접 병합하세요)` : '';
      if (reportInfo?.telegramSummary) {
        notify(`✅ <b>완료</b>${flag}\n\n${reportInfo.telegramSummary}${prNote}`);
      } else {
        notify(
          `✅ <b>완료</b>${flag}\n\n` +
          `ID: <code>${taskId}</code>\n` +
          `총 라운드: ${round}\n` +
          `평가 점수: ${evalResult?.score ?? '-'}/100` +
          prNote
        );
      }
    });

    agentRunner.on('task:needs_review', ({ taskId, round, evalResult, unresolvedIssues, reportInfo, projectId }) => {
      // 완료가 아니므로 실패 카운터는 건드리지 않음 (알림 억제 대상도 아님 — 검토는 사용자 액션 필요)
      const issuePreview = Array.isArray(evalResult?.issues)
        ? evalResult.issues.slice(0, 3).map(x => `• ${String(x).substring(0, 80)}`).join('\n')
        : '';
      if (reportInfo?.telegramSummary) {
        notify(`⚠️ <b>검토 필요</b> — 최대 라운드 도달, 기준 미충족\n\n${reportInfo.telegramSummary}\n\n커밋·배포는 보류됨. 대시보드에서 리포트 확인 후 새 작업으로 재시도하세요.`);
      } else {
        notify(
          `⚠️ <b>검토 필요</b> — 최대 라운드 도달, 기준 미충족\n\n` +
          `ID: <code>${taskId}</code>\n` +
          `라운드: ${round} | 점수: ${evalResult?.score ?? '-'}/100 | 미해결: ${unresolvedIssues ?? '-'}개\n` +
          (issuePreview ? `\n<b>미해결 항목:</b>\n${issuePreview}\n` : '') +
          `\n커밋·배포는 보류됨. 대시보드에서 리포트 확인 후 새 작업으로 재시도하세요.`
        );
      }
    });

    // 쿨다운/리미트 진입 — 두 경로 모두 여기서 알린다.
    //   · resumeAt 있음  = 프로바이더 전부 대기 → 예약 재개 (index.js 타이머가 처리)
    //   · resumeAt 없음  = 토큰 리미트 → 수동 재개. 예전엔 이 경로가 완전 무음이었다.
    agentRunner.on('task:rate_limited', ({ taskId, resumeAt }) => {
      notify(buildRateLimitedMessage({ taskId, resumeAt }));
    });

    // 실제로 파이프라인이 다시 시작된 시점에만 발생한다 (예고 알림 아님).
    agentRunner.on('task:resuming', ({ taskId, auto, round }) => {
      notify(buildResumingMessage({ taskId, auto, round }));
    });

    agentRunner.on('task:paused', ({ taskId, reason }) => {
      // 'rate_limit'는 아무도 emit하지 않던 죽은 분기였다. 실제로 오는 사유만 라벨링한다.
      const LABEL = {
        manual_stop:       '수동 중지',
        fallback_running:  'Codex 폴백으로 계속 진행 중',
        codex_eval_failed: 'Codex 폴백 평가 기준 미달',
        codex_failed:      'Codex 폴백 실패',
      };
      const label = LABEL[reason] || reason || '알 수 없음';
      const resumable = reason !== 'fallback_running';
      notify(
        `⏸ <b>일시정지</b>\n\n` +
        `ID: <code>${taskId}</code>\n` +
        `사유: ${label}\n` +
        (resumable ? `\n재개: <code>/resume ${taskId}</code>` : '')
      );
    });

    // 커밋 실패는 실패 알림 쿨다운을 타지 않는다.
    // 드물게 일어나고, 일어나면 산출물이 dirty로 남아 다음 작업까지 막는다.
    // 억제했다가 늦게 알면 8/18처럼 연쇄가 다 진행된 뒤에야 발견하게 된다.
    agentRunner.on('task:commit_failed', ({ taskId, projectId, gitRoot, reason, identity }) => {
      notify(
        `🚨 <b>커밋 실패</b>\n` +
        `<code>${escapeHtml(taskId)}</code>\n` +
        `프로젝트: ${escapeHtml(projectId || '?')}\n\n` +
        `${escapeHtml(String(reason || '').slice(0, 300))}\n\n` +
        `작업 산출물이 커밋되지 못하고 워킹트리에 남아 있습니다.\n` +
        `이 상태를 두면 다음 작업의 브랜치 생성이 막힙니다.\n\n` +
        `확인: <code>cd ${escapeHtml(gitRoot || '')} && git status</code>\n` +
        `커밋 신원: ${escapeHtml(identity || '')}`
      );
    });

    agentRunner.on('task:failed', ({ taskId, error, projectId }) => {
      const now = Date.now();
      const pid = projectId || taskId;

      // 기존 쿨다운 항목 읽기
      const entry = _lastFailNotify.get(pid) || { lastNotify: 0, failCount: 0 };
      const lastNotify = entry.lastNotify || 0;
      const failCount = (entry.failCount || 0) + 1;

      // 연속 실패 횟수가 MAX_CONSECUTIVE_FAIL_NOTIFY 초과 시 알림 완전 억제
      if (failCount > MAX_CONSECUTIVE_FAIL_NOTIFY) {
        console.log(`[Telegram] task:failed 연속 실패 ${failCount}회 — 알림 완전 억제 (${pid})`);
        // 카운트만 업데이트, lastNotify는 갱신 안 함
        _lastFailNotify.set(pid, { lastNotify, failCount });
        saveCooldownData(_lastFailNotify);
        return;
      }

      // 10분 쿨다운: 같은 프로젝트 실패 알림이 10분 내 반복되면 생략
      if (now - lastNotify < FAIL_NOTIFY_COOLDOWN_MS) {
        console.log(`[Telegram] task:failed 알림 쿨다운 중 (${pid}, failCount=${failCount}) — 생략`);
        _lastFailNotify.set(pid, { lastNotify, failCount });
        saveCooldownData(_lastFailNotify);
        return;
      }

      // 알림 발송
      _lastFailNotify.set(pid, { lastNotify: now, failCount });
      saveCooldownData(_lastFailNotify);

      const suppressNote = failCount >= MAX_CONSECUTIVE_FAIL_NOTIFY
        ? `\n⚠️ 연속 ${failCount}회 실패. 이후 알림이 억제됩니다.`
        : '';

      // 재실행 방법을 메시지 안에 넣는다.
      // 8/18: 전용 /retry가 없고 그 사실이 어디에도 안내되지 않아, 실패한 #2 대신
      // #3을 실행하는 우회가 발생했다. 복구 경로는 실패를 알리는 자리에 있어야 한다.
      backlogQueries.findByTaskId(taskId)
        .then(item => {
          const retry = item?.id
            ? `\n\n재실행: <code>/approve ${item.id}</code>`
            : '\n\n(이 작업은 백로그 경로가 아니라 재실행 명령이 없습니다. 목표 항목이면 대시보드에서 재시도하세요.)';
          notify(
            `❌ <b>실패</b>\n\n` +
            `ID: <code>${taskId}</code>\n` +
            `오류: ${(error || '').substring(0, 200)}` +
            retry +
            suppressNote
          );
        })
        .catch(() => {
          // 조회가 실패해도 알림 자체는 나가야 한다 — 알림을 잃는 게 더 나쁘다.
          notify(
            `❌ <b>실패</b>\n\n` +
            `ID: <code>${taskId}</code>\n` +
            `오류: ${(error || '').substring(0, 200)}` +
            suppressNote
          );
        });
    });
  }

  // ── 봇 인스턴스 생성 함수 ─────────────────────────────────
  function initBot() {
    if (bot) {
      try { bot.stopPolling(); } catch { /* 무시 */ }
    }

    bot = new TelegramBot(token, {
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 },
      },
    });

    // 텔레그램 API가 거절한 이유(409/401 등)는 err.response.body 에만 들어 있다.
    // err.code는 API 오류면 전부 'ETELEGRAM'이라, 그것만 찍으면 "다른 인스턴스가 폴링 중"인지
    // "토큰이 틀렸는지" 구분이 안 된다 — 무인 운영에서 원인 파악이 불가능해진다.
    function describeTelegramError(err) {
      const code = err?.code || 'unknown';
      const apiCode = err?.response?.body?.error_code;
      const desc = err?.response?.body?.description || err?.message || '';
      if (!apiCode && !desc) return code;
      return `${code}${apiCode ? ` ${apiCode}` : ''}${desc ? `: ${desc}` : ''}`;
    }

    // 같은 원인으로 폴링(7초)마다 로그가 쌓이면 journal이 금방 못 쓰게 된다.
    // 동일 오류는 처음 한 번, 이후 5분 간격으로만 남기고 생략 횟수를 함께 표시한다.
    let lastPollErrKey = null;
    let lastPollErrAt = 0;
    let pollErrRepeat = 0;
    const POLL_ERR_LOG_INTERVAL_MS = 5 * 60 * 1000;

    // 네트워크 에러 자동 재연결
    bot.on('polling_error', (err) => {
      const errStr = err.code || err.message || String(err);
      const isNetworkError = /ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network/i.test(errStr);

      if (!isNetworkError) {
        const detail = describeTelegramError(err);
        const now = Date.now();
        if (detail === lastPollErrKey && now - lastPollErrAt < POLL_ERR_LOG_INTERVAL_MS) {
          pollErrRepeat++;
          return;
        }
        const repeated = pollErrRepeat > 0 ? ` (동일 오류 ${pollErrRepeat}회 생략됨)` : '';
        lastPollErrKey = detail; lastPollErrAt = now; pollErrRepeat = 0;

        console.error(`[Telegram] 폴링 오류: ${detail}${repeated}`);
        const apiCode = err?.response?.body?.error_code;
        if (apiCode === 409) {
          console.error('[Telegram] → 같은 봇 토큰을 다른 인스턴스가 폴링 중입니다.');
          console.error('[Telegram]   맥/VPS 등 다른 하네스를 정지하세요 — 한 번에 한 대만 가능합니다.');
        } else if (apiCode === 401) {
          console.error('[Telegram] → 토큰이 유효하지 않습니다. .env의 TELEGRAM_BOT_TOKEN을 확인하세요.');
          console.error('[Telegram]   (.env를 옮기는 과정에서 값이 잘렸을 수 있습니다.)');
        }
        return;
      }

      if (isNetworkError) {
        reconnectAttempt++;
        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt - 1),
          MAX_RECONNECT_DELAY_MS
        );
        console.warn(`[Telegram] 네트워크 오류 (${errStr}) — ${delay}ms 후 재연결 (시도 #${reconnectAttempt})`);

        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          console.log('[Telegram] 재연결 중...');
          initBot();
        }, delay);
      } else {
        console.error('[Telegram] 폴링 오류:', errStr);
      }
    });

    // 메시지 수신 시 재연결 카운터 리셋
    bot.on('message', () => {
      if (reconnectAttempt > 0) {
        console.log('[Telegram] 연결 복구됨');
        reconnectAttempt = 0;
      }
    });

    registerCommands();
    console.log('[Telegram] 봇 시작됨');
  }

  // agentRunner 이벤트 핸들러는 initBot() 밖에서 한 번만 등록
  // (initBot은 재연결 시에도 호출되므로 중복 등록 방지)
  registerAgentEvents();

  initBot();

  return { get bot() { return bot; }, notify };
}
