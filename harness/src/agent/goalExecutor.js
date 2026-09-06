// src/agent/goalExecutor.js
// 승인된 계획서의 항목을 자동으로 실행한다.
//
// 계획 1회 승인 후 자동 실행이므로, 사람이 안 보는 구간이 길어진다.
// 그래서 이 파일의 절반은 "실행"이 아니라 **조용히 실패하지 않게 만드는 장치**다:
//   - 같은 항목 2회 연속 실패 → 항목 차단, 재시도 중단
//   - 한 목표에서 24시간 내 3회 실패 → 목표 자동 일시정지
//   - 에이전트가 프로젝트 설정 파일을 바꿨으면 자동 진행 중단 (8/18 vite 오염 사고 대응)
//   - 조용 시간에는 실행을 멈추는 게 아니라 알림만 미룬다

import { spawnSync } from 'child_process';
import fs from 'fs';

import { projectQueries } from '../db/db.js';
import { goalQueries, goalItemQueries, goalEventQueries, planQueries } from '../db/goals.js';
import { checkBranchRunGate, GOAL_MAX_RUNS_PER_DAY } from './runGate.js';
import { computePace, describePace } from './pace.js';

const TICK_MS = parseInt(process.env.GOAL_EXECUTOR_INTERVAL_MIN || '5', 10) * 60_000;
const MAX_ATTEMPTS_PER_ITEM = parseInt(process.env.GOAL_MAX_ATTEMPTS_PER_ITEM || '2', 10);
const MAX_FAILURES_PER_GOAL_24H = parseInt(process.env.GOAL_MAX_FAILURES_24H || '3', 10);

// 조용 시간의 의미: 실행 금지가 아니라 **알림 보류**.
// 밤은 사람이 안 보고 구독 한도가 리셋되는 시간이라, 실행을 멈추면 가용 시간이 절반이 된다.
const QUIET_HOURS = process.env.GOAL_QUIET_HOURS || '23-8';
const KST_OFFSET_MIN = 9 * 60;

// 에이전트가 건드리면 자동 진행을 멈춰야 하는 파일들.
// 8/18에 에이전트가 EROFS를 오진하고 그 추측에 근거해 vite 설정을 영구 변경했다.
// 그때는 사람이 PR을 보다 발견했지만, 자동 실행에는 그 눈이 없다.
const PROTECTED_PATTERNS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /(^|\/)vite\.config\.[cm]?[jt]s$/,
  /(^|\/)next\.config\.[cm]?[jt]s$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)jest\.config\.[cm]?[jt]s$/,
  /(^|\/)tailwind\.config\.[cm]?[jt]s$/,
  /(^|\/)\.eslintrc/,
  /(^|\/)eslint\.config\.[cm]?[jt]s$/,
  /^\.github\/workflows\//,
  /^Dockerfile$/,
];

// ── 조용 시간 ──────────────────────────────────────────────────
export function parseQuietHours(spec = QUIET_HOURS) {
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(spec).trim());
  if (!m) return null;
  const from = parseInt(m[1], 10);
  const to = parseInt(m[2], 10);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return { from, to };
}

export function kstHour(date = new Date()) {
  return new Date(date.getTime() + KST_OFFSET_MIN * 60_000).getUTCHours();
}

export function isQuietNow(spec = QUIET_HOURS, date = new Date()) {
  const q = parseQuietHours(spec);
  if (!q) return false;
  const h = kstHour(date);
  // 23-8처럼 자정을 넘는 구간을 지원한다.
  return q.from <= q.to ? (h >= q.from && h < q.to) : (h >= q.from || h < q.to);
}

// ── 설정 파일 변경 감지 ────────────────────────────────────────
export function matchProtected(paths) {
  return paths.filter(p => PROTECTED_PATTERNS.some(re => re.test(p)));
}

export function changedFiles(projectPath, baseBranch, branchName) {
  if (!projectPath || !fs.existsSync(projectPath) || !branchName) return [];
  const res = spawnSync('git', ['diff', '--name-only', `${baseBranch}...${branchName}`], {
    cwd: projectPath, encoding: 'utf8', timeout: 20_000,
  });
  if (res.status !== 0) return [];
  return (res.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
}

export function detectBaseBranch(projectPath) {
  for (const b of ['main', 'master']) {
    const res = spawnSync('git', ['rev-parse', '--verify', b], {
      cwd: projectPath, encoding: 'utf8', timeout: 10_000,
    });
    if (res.status === 0) return b;
  }
  return 'main';
}

// ── 항목 → 에이전트 프롬프트 ───────────────────────────────────
export function buildItemPrompt(item, goal) {
  const parts = [item.title, ''];

  parts.push('[완료 조건 — 이 조건으로 채점된다]', item.acceptance_criteria, '');

  if (item.verify_cmd) {
    parts.push('[검증 명령 — 반드시 통과시켜라]', item.verify_cmd, '');
  }
  if (item.target_paths?.length) {
    parts.push('[대상 경로]', item.target_paths.join(', '), '');
  }

  parts.push(`[상위 목표] ${goal.title}`);
  parts.push(`[목표의 완료 조건] ${goal.outcome}`);

  if (item.goal_kind === 'research' || goal.kind === 'research') {
    parts.push(
      '',
      '[중요] 이것은 조사 작업이다. **코드를 변경하지 마라.**',
      `산출물은 리포트 파일 하나다: ${item.report_path || 'REPORT.md'}`,
      '리포트의 모든 주장에는 근거가 되는 파일 경로와 줄 번호를 달아라.',
      '근거를 찾지 못한 항목은 "확인 불가"로 적어라 — 추측으로 채우지 마라.',
    );
  } else {
    parts.push(
      '',
      '[중요] 요구되지 않은 리팩터링·설정 변경을 하지 마라.',
      'package.json, vite/next/tsconfig, CI 워크플로를 바꿔야만 한다고 판단되면,',
      '바꾸지 말고 그 이유를 작업 요약에 적어라. 사람이 판단한다.',
    );
  }

  return parts.join('\n');
}

// ── 실행기 ─────────────────────────────────────────────────────
export function startGoalExecutor(agentRunner, { notify } = {}) {
  const enabled = process.env.GOAL_EXECUTOR !== 'false';
  if (!enabled) {
    console.log('[goal] 목표 자동 실행 비활성 (GOAL_EXECUTOR=false)');
    return { stop: () => {} };
  }

  // 조용 시간에 밀린 알림. 해제 시각에 한 번에 보낸다.
  const deferred = [];

  async function send(message, { urgent = false } = {}) {
    if (!notify) return;
    if (!urgent && isQuietNow()) {
      deferred.push(message);
      return;
    }
    await notify(message).catch(() => {});
  }

  async function flushDeferred() {
    if (!deferred.length || !notify) return;
    const body = deferred.splice(0, deferred.length);
    await notify(
      `🌙 <b>밤 사이 진행 ${body.length}건</b>\n\n${body.join('\n\n')}`.slice(0, 3800)
    ).catch(() => {});
  }

  // ── 항목 하나 시작 ──────────────────────────────────────────
  async function startNext() {
    const item = await goalItemQueries.nextRunnable();
    if (!item) return false;

    const gate = await checkBranchRunGate({ dailyLimit: GOAL_MAX_RUNS_PER_DAY });
    if (gate) return false;   // 상한은 정상 동작이다 — 알림으로 시끄럽게 하지 않는다

    const goal = await goalQueries.get(item.goal_id);
    if (!goal || goal.status !== 'active') return false;

    try {
      const prompt = buildItemPrompt(item, goal);
      const taskId = await agentRunner.run({
        projectId: item.project_id,
        prompt,
        branchMode: goal.kind !== 'research',   // 조사 작업은 브랜치를 만들 필요가 없다
      });

      await goalItemQueries.setStatus(item.id, 'running', { task_id: taskId });
      await goalItemQueries.incrementAttempts(item.id);
      await goalEventQueries.add({
        goal_id: goal.id, item_id: item.id, kind: 'item_started',
        message: `실행 시작 — ${item.title}`,
        payload: { taskId },
      });
      await send(`▶️ <b>${escapeHtml(item.title)}</b>\n${escapeHtml(goal.title)}`);
      return true;
    } catch (err) {
      // 프로젝트에 다른 작업이 돌고 있는 등 정상적인 거절도 여기로 온다.
      // 항목을 실패로 만들지 않고 pending으로 되돌려 다음 틱에 다시 시도한다.
      await goalItemQueries.setStatus(item.id, 'pending');
      return false;
    }
  }

  // ── 완료 처리 ───────────────────────────────────────────────
  async function onTaskComplete({ taskId, prUrl }) {
    const item = await goalItemQueries.findByTask(taskId);
    if (!item) return;

    const goal = await goalQueries.get(item.goal_id);

    // 설정 파일이 바뀌었으면 자동 진행을 멈춘다.
    let flagged = [];
    try {
      const project = await projectQueries.get(item.project_id);
      const branchName = await branchNameOf(taskId);
      if (project?.path && branchName) {
        const base = detectBaseBranch(project.path);
        flagged = matchProtected(changedFiles(project.path, base, branchName));
      }
    } catch { /* 감지 실패가 완료 처리를 막으면 안 된다 */ }

    if (flagged.length) {
      await goalItemQueries.setStatus(item.id, 'needs_review', {
        pr_url: prUrl || null,
        blocked_reason: `설정 파일 변경 감지: ${flagged.join(', ')}`.slice(0, 300),
      });
      await goalEventQueries.add({
        goal_id: item.goal_id, item_id: item.id, kind: 'item_flagged',
        message: `⚠️ 설정 파일이 변경되어 자동 진행을 멈췄습니다 — ${flagged.join(', ')}`.slice(0, 500),
        payload: { files: flagged, prUrl },
      });
      await send(
        `⚠️ <b>확인 필요</b>\n${escapeHtml(item.title)}\n`
        + `설정 파일이 변경되었습니다: ${escapeHtml(flagged.join(', '))}\n`
        + (prUrl ? `${prUrl}\n` : '')
        + '요구되지 않은 설정 변경일 수 있어 자동 진행을 멈췄습니다.',
        { urgent: true }
      );
      return;
    }

    await goalItemQueries.setStatus(item.id, 'done', { pr_url: prUrl || null });
    await goalEventQueries.add({
      goal_id: item.goal_id, item_id: item.id, kind: 'item_done',
      message: `완료 — ${item.title}`,
      payload: { prUrl },
    });
    await send(`✅ <b>${escapeHtml(item.title)}</b>\n${prUrl ? prUrl : '(PR 없음)'}`);

    // 모든 항목이 끝났으면 목표를 done으로
    const progress = await goalQueries.progress(item.goal_id);
    if (progress.total > 0 && progress.finished >= progress.total) {
      await goalQueries.setStatus(item.goal_id, 'done');
      await goalEventQueries.add({
        goal_id: item.goal_id, kind: 'goal_done',
        message: `목표 완료 — 항목 ${progress.total}개`,
      });
      await send(`🎉 <b>목표 완료</b>\n${escapeHtml(goal?.title || '')}\n항목 ${progress.total}개 전부 처리됨`, { urgent: true });
    }
  }

  // ── 실패 처리 + 차단기 ──────────────────────────────────────
  async function onTaskFailed({ taskId, error, reason }) {
    const item = await goalItemQueries.findByTask(taskId);
    if (!item) return;

    const detail = String(error || reason || '알 수 없는 오류').slice(0, 300);
    const attempts = item.attempts || 0;

    if (attempts >= MAX_ATTEMPTS_PER_ITEM) {
      await goalItemQueries.setStatus(item.id, 'blocked', {
        blocked_reason: `${attempts}회 실패: ${detail}`.slice(0, 300),
      });
      await goalEventQueries.add({
        goal_id: item.goal_id, item_id: item.id, kind: 'item_blocked',
        message: `${attempts}회 연속 실패로 차단 — ${item.title}: ${detail}`.slice(0, 500),
      });
      await send(
        `🚫 <b>항목 차단</b>\n${escapeHtml(item.title)}\n`
        + `${attempts}회 실패했습니다: ${escapeHtml(detail)}\n`
        + '재시도를 멈췄습니다. 대시보드에서 확인하세요.',
        { urgent: true }
      );
    } else {
      // 다시 시도할 여지가 있으면 pending으로 되돌린다.
      await goalItemQueries.setStatus(item.id, 'pending', {
        blocked_reason: detail,
      });
      await goalEventQueries.add({
        goal_id: item.goal_id, item_id: item.id, kind: 'item_failed',
        message: `실패 (${attempts}/${MAX_ATTEMPTS_PER_ITEM}) — ${item.title}: ${detail}`.slice(0, 500),
      });
      await send(`❌ <b>${escapeHtml(item.title)}</b>\n실패 ${attempts}/${MAX_ATTEMPTS_PER_ITEM} — ${escapeHtml(detail)}`);
    }

    // 목표 단위 차단기
    const failures = await goalItemQueries.recentFailures(item.goal_id, 24);
    if (failures >= MAX_FAILURES_PER_GOAL_24H) {
      await goalQueries.setStatus(item.goal_id, 'paused',
        `24시간 내 실패 ${failures}건 — 자동 일시정지`);
      await goalEventQueries.add({
        goal_id: item.goal_id, kind: 'goal_paused_auto',
        message: `24시간 내 실패 ${failures}건으로 목표를 자동 일시정지했습니다.`,
      });
      await send(
        `⏸ <b>목표 자동 일시정지</b>\n${escapeHtml(item.goal_title || '')}\n`
        + `24시간 내 실패 ${failures}건. 원인을 확인한 뒤 재개하세요.`,
        { urgent: true }
      );
    }
  }

  // ── 일일 브리핑 ─────────────────────────────────────────────
  let lastBriefDay = null;

  async function maybeDailyBrief() {
    const now = new Date();
    const h = kstHour(now);
    const day = new Date(now.getTime() + KST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
    if (h !== 9 || lastBriefDay === day) return;
    lastBriefDay = day;

    await flushDeferred();

    const goals = await goalQueries.list({});
    const live = goals.filter(g => ['active', 'plan_review', 'clarify', 'paused'].includes(g.status));
    if (!live.length) return;

    const lines = [];
    for (const g of live) {
      const progress = await goalQueries.progress(g.id);
      const pace = await computePace({ dueDate: g.due_date, remainingRuns: progress.remaining_runs });
      const icon = { green: '🟢', yellow: '🟡', red: '🔴', none: '⚪' }[pace.signal.level];
      lines.push(
        `${icon} <b>${escapeHtml(g.title)}</b> (${g.status})\n`
        + `   ${progress.finished}/${progress.total} 완료`
        + (progress.blocked ? ` · 차단 ${progress.blocked}` : '')
        + `\n   ${escapeHtml(describePace(pace))}`
      );
    }

    const inbox = await goalItemQueries.inbox();
    if (inbox.length) {
      lines.push(`\n📥 <b>확인 필요 ${inbox.length}건</b>\n`
        + inbox.slice(0, 5).map(i => `   · ${escapeHtml(i.title)}`).join('\n'));
    }

    if (notify) {
      await notify(`📊 <b>일일 브리핑</b>\n\n${lines.join('\n\n')}`.slice(0, 3800)).catch(() => {});
    }

    // Neon Free는 0.5GB 상한이고 스케줄러가 없다 — 청소도 하네스 몫이다.
    await goalEventQueries.prune(90).catch(() => {});
  }

  // ── 틱 ──────────────────────────────────────────────────────
  let ticking = false;

  async function tick() {
    if (ticking) return;   // 느린 틱이 겹치면 같은 항목을 두 번 시작한다
    ticking = true;
    try {
      await maybeDailyBrief();
      if (!isQuietNow()) await flushDeferred();
      await startNext();
    } catch (err) {
      console.error('[goal] 실행기 틱 오류:', err.message);
    } finally {
      ticking = false;
    }
  }

  agentRunner.on('task:complete', (d) => { onTaskComplete(d).catch(e => console.error('[goal] 완료 처리 오류:', e.message)); });
  agentRunner.on('task:failed',   (d) => { onTaskFailed(d).catch(e => console.error('[goal] 실패 처리 오류:', e.message)); });
  agentRunner.on('task:paused',   (d) => { onTaskFailed(d).catch(e => console.error('[goal] 일시정지 처리 오류:', e.message)); });

  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  setTimeout(tick, 15_000);   // 부팅 직후 한 번 — 재시작 후 멈춰 있지 않게

  console.log(`[goal] 목표 자동 실행 활성 — ${TICK_MS / 60000}분 주기, 일일 상한 ${GOAL_MAX_RUNS_PER_DAY}건, 조용시간 ${QUIET_HOURS}(알림만 보류)`);
  return { stop: () => clearInterval(timer), tick };
}

// tasks 테이블에서 브랜치명을 읽는다 — runner가 이벤트에 싣지 않기 때문.
async function branchNameOf(taskId) {
  const { taskQueries } = await import('../db/db.js');
  const task = await taskQueries.get(taskId);
  return task?.branch_name || null;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
