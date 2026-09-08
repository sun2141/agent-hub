// src/agent/goalActions.js
// 목표 계층의 상태 변경 로직 — REST 라우트와 텔레그램 버튼이 함께 쓴다.
//
// 왜 분리했나: 같은 동작을 라우트와 봇에 두 벌로 두면 한쪽만 고쳐져서 갈라진다.
// 8/18 백로그 버튼에서 일일 상한이 새던 것과 같은 계열의 실패다.
// 여기 함수들은 HTTP를 모른다 — { ok, code, ... }만 돌려주고,
// 라우트는 code를 상태코드로, 봇은 텍스트로 옮긴다.

import { projectQueries } from '../db/db.js';
import { goalQueries, planQueries, goalEventQueries } from '../db/goals.js';
import { planGoal } from './goalPlanner.js';
import { buildPlanReadyMessage, buildClarifyMessage } from '../telegram/goalMessages.js';

const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

// 계획 생성 + 결과 알림. 알림에 버튼을 실어야 폰에서 그대로 승인할 수 있다.
// 예전에는 모든 알림이 "대시보드에서 검토하세요"로 끝나서 거기서 흐름이 끊겼다.
export async function runPlanning(goalId, { notify } = {}) {
  let result;
  try {
    result = await planGoal(goalId, { projectResolver: (pid) => projectQueries.get(pid) });
  } catch (err) {
    // planGoal 내부에서 이미 이벤트로 기록한다.
    return { ok: false, kind: 'error', message: err.message };
  }
  if (!notify) return result;

  try {
    const goal = await goalQueries.get(goalId);
    const title = goal?.title || '';

    if (result.kind === 'clarify') {
      const m = buildClarifyMessage({ goalId, goalTitle: title, questions: result.questions });
      await notify(m.text);
    } else if (result.kind === 'plan') {
      const m = buildPlanReadyMessage({
        goalTitle: title,
        version: result.version,
        itemCount: result.itemCount,
        planId: result.planId,
        goalId,
        dueDate: goal?.due_date || null,
      });
      await notify(m.text, m.reply_markup ? { reply_markup: m.reply_markup } : {});
    } else {
      const detail = result.errors ? result.errors.slice(0, 3).join('\n') : (result.message || '');
      await notify(`⚠️ <b>계획 생성 실패</b>\n${String(title).slice(0, 80)}\n${detail}`);
    }
  } catch (err) {
    console.warn(`[goal] 계획 결과 알림 실패 (${goalId}): ${err.message}`);
  }
  return result;
}

export async function createGoal(input, { notify } = {}) {
  const {
    project_id, title, outcome,
    due_date = null, kind = 'build', autoplan = true,
  } = input || {};

  if (!project_id || !String(project_id).trim()) return fail('bad_request', 'project_id가 필요합니다.');
  if (!title || !String(title).trim())           return fail('bad_request', '목표 제목이 필요합니다.');
  if (!outcome || !String(outcome).trim())       return fail('bad_request', '완료 조건이 필요합니다. 이게 없으면 하네스가 완료를 판정할 수 없습니다.');
  if (!['build', 'research'].includes(kind))     return fail('bad_request', "kind는 'build' 또는 'research'여야 합니다.");
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return fail('bad_request', '기한은 YYYY-MM-DD 형식이어야 합니다.');

  const project = await projectQueries.get(project_id);
  if (!project) return fail('not_found', `프로젝트 ${project_id}를 찾을 수 없습니다.`);

  // 프로젝트당 활성 목표 1개 — 막지 않으면 둘 다 굶고, 이유를 알 수 없게 된다.
  const busy = await goalQueries.findActiveInProject(project_id);
  if (busy) {
    return fail('conflict',
      `이 프로젝트에는 이미 진행 중인 목표가 있습니다: "${busy.title}" (${busy.status}). `
      + '프로젝트당 동시 1작업 제약 때문에 두 목표를 동시에 열면 서로 굶습니다. '
      + '기존 목표를 끝내거나 일시정지한 뒤 다시 시도하세요.',
      { conflict: busy });
  }

  const id = await goalQueries.create({
    project_id,
    title: String(title).trim().slice(0, 300),
    outcome: String(outcome).trim().slice(0, 2000),
    due_date: due_date || null,
    kind,
  });

  await goalEventQueries.add({
    goal_id: id, kind: 'goal_created',
    message: `목표 생성 — ${String(title).trim().slice(0, 200)}`,
  });

  // 계획 생성은 LLM 호출이라 수십 초 걸린다. 응답을 붙잡지 않고 뒤에서 돌린다.
  if (autoplan) {
    setImmediate(() => { runPlanning(id, { notify }).catch(() => {}); });
  }

  return { ok: true, id, status: autoplan ? 'planning' : 'draft' };
}

export async function answerClarify(goalId, answers, { notify } = {}) {
  if (!answers || typeof answers !== 'object' || !Object.keys(answers).length) {
    return fail('bad_request', 'answers 객체가 필요합니다.');
  }
  const goal = await goalQueries.get(goalId);
  if (!goal) return fail('not_found', '목표 없음');

  // 답변을 완료 조건에 합친다 — 계획 생성기가 별도 필드를 또 읽게 만들지 않는다.
  const appended = Object.entries(answers).map(([q, a]) => `- ${q}: ${a}`).join('\n');
  await goalQueries.setClarifyAnswers(goalId, answers);
  await goalQueries.update(goalId, {
    outcome: `${goal.outcome}\n\n[결정 사항]\n${appended}`.slice(0, 4000),
  });
  await goalEventQueries.add({
    goal_id: goalId, kind: 'clarify_answered',
    message: `결정 사항 ${Object.keys(answers).length}건 반영 — 계획 재생성`,
  });

  setImmediate(() => { runPlanning(goalId, { notify }).catch(() => {}); });
  return { ok: true, status: 'planning', count: Object.keys(answers).length };
}

export async function requestReplan(goalId, comment, { notify } = {}) {
  const goal = await goalQueries.get(goalId);
  if (!goal) return fail('not_found', '목표 없음');

  const latest = await planQueries.latest(goalId);
  if (latest && latest.status === 'proposed') {
    await planQueries.reject(latest.id, comment || null);
  }
  if (comment) {
    await goalQueries.update(goalId, {
      outcome: `${goal.outcome}\n\n[수정 요청]\n${String(comment).slice(0, 1000)}`.slice(0, 4000),
    });
  }
  await goalEventQueries.add({
    goal_id: goalId, kind: 'replan_requested',
    message: `계획 재생성 요청${comment ? ` — ${String(comment).slice(0, 200)}` : ''}`,
  });

  setImmediate(() => { runPlanning(goalId, { notify }).catch(() => {}); });
  return { ok: true, status: 'planning', title: goal.title };
}

export async function approvePlan(planId, { notify } = {}) {
  const plan = await planQueries.get(planId);
  if (!plan) return fail('not_found', '계획서 없음');
  if (plan.status === 'approved') return { ok: true, already: true, goalId: plan.goal_id };
  if (plan.status !== 'proposed') {
    return fail('bad_request', `이 계획서는 ${plan.status} 상태라 승인할 수 없습니다.`);
  }

  const done = await planQueries.approve(planId);
  if (!done) return fail('server_error', '승인 처리 실패');

  const full = await planQueries.full(planId);
  const itemCount = full.items.length;
  await goalEventQueries.add({
    goal_id: plan.goal_id, kind: 'plan_approved',
    message: `계획서 v${plan.version} 승인 — 항목 ${itemCount}개 자동 실행 시작`,
    payload: { planId, version: plan.version },
  });

  const goal = await goalQueries.get(plan.goal_id);
  if (notify) {
    await notify(
      `✅ <b>계획 승인됨</b> v${plan.version}\n${String(goal?.title || '').slice(0, 80)}\n`
      + `항목 ${itemCount}개를 순서대로 자동 실행합니다.`
    ).catch(() => {});
  }
  return { ok: true, itemCount, version: plan.version, goalId: plan.goal_id, title: goal?.title || '' };
}

export async function rejectPlan(planId, comment) {
  const plan = await planQueries.get(planId);
  if (!plan) return fail('not_found', '계획서 없음');
  await planQueries.reject(planId, comment || null);
  await goalQueries.setStatus(plan.goal_id, 'draft');
  await goalEventQueries.add({
    goal_id: plan.goal_id, kind: 'plan_rejected_by_user',
    message: `계획서 v${plan.version} 폐기`,
  });
  const goal = await goalQueries.get(plan.goal_id);
  return { ok: true, version: plan.version, goalId: plan.goal_id, title: goal?.title || '' };
}
