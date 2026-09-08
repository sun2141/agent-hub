// src/api/goalRoutes.js
// 목표 계층 REST 라우트. server.js의 /api 인증 미들웨어 뒤에 등록된다.
//
// 여기 있는 라우트는 전부 "사람의 의도"를 다룬다. 실행 자체는 건드리지 않는다 —
// 실행은 goalExecutor가 승인된 계획을 보고 스스로 돌린다.

import {
  goalQueries, planQueries, goalItemQueries, goalEventQueries,
} from '../db/goals.js';
import {
  createGoal, answerClarify, requestReplan, approvePlan, rejectPlan,
} from '../agent/goalActions.js';
import { computePace, describePace } from '../agent/pace.js';

const GOAL_ID = /^goal_[0-9]+_[a-z0-9]+$/;
const PLAN_ID = /^plan_[0-9]+_[a-z0-9]+$/;
const ITEM_ID = /^gi_[0-9]+_[a-z0-9]+$/;

function bad(res, msg) { return res.status(400).json({ error: msg }); }

// goalActions는 HTTP를 모른다 — 여기서만 상태코드로 옮긴다.
const CODE_STATUS = { bad_request: 400, not_found: 404, conflict: 409, server_error: 500 };
function sendResult(res, result, okBody) {
  if (!result.ok) {
    const status = CODE_STATUS[result.code] || 400;
    const body = { error: result.error };
    if (result.conflict) body.conflict = result.conflict;
    return res.status(status).json(body);
  }
  return res.json(okBody ? okBody(result) : { ok: true });
}

// 목표 카드 한 장에 필요한 것 — 진행률 + pace를 함께 실어 보낸다.
// 대시보드가 목표마다 두 번 더 호출하지 않게 하려는 것이다(Neon 컴퓨트 시간 절약).
async function decorate(goal) {
  const progress = await goalQueries.progress(goal.id);
  const pace = await computePace({
    dueDate: goal.due_date,
    remainingRuns: progress.remaining_runs,
  });
  return { ...goal, progress, pace, paceText: describePace(pace) };
}

export function registerGoalRoutes(app, { notify } = {}) {
  // ── 목록 ────────────────────────────────────────────────────
  app.get('/api/goals', async (req, res) => {
    try {
      const goals = await goalQueries.list({
        projectId: req.query.project || null,
        status: req.query.status || null,
      });
      res.json(await Promise.all(goals.map(decorate)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 인박스: 사람이 처리해야 할 것만 ─────────────────────────
  app.get('/api/goals/inbox', async (req, res) => {
    try {
      const items = await goalItemQueries.inbox();
      const reviewGoals = await goalQueries.list({ status: 'plan_review' });
      const clarifyGoals = await goalQueries.list({ status: 'clarify' });
      const pausedGoals = await goalQueries.list({ status: 'paused' });
      res.json({
        items,
        awaitingApproval: reviewGoals,
        awaitingAnswers: clarifyGoals,
        paused: pausedGoals,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/goals/events', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
      res.json(await goalEventQueries.recent(limit));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 목표 생성 ───────────────────────────────────────────────
  app.post('/api/goals', async (req, res) => {
    try {
      const result = await createGoal(req.body || {}, { notify });
      if (!result.ok) return sendResult(res, result);
      res.status(201).json({ id: result.id, status: result.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 목표 단건 ───────────────────────────────────────────────
  app.get('/api/goals/:id', async (req, res) => {
    const { id } = req.params;
    if (!GOAL_ID.test(id)) return bad(res, '잘못된 goal ID 형식');
    try {
      const goal = await goalQueries.get(id);
      if (!goal) return res.status(404).json({ error: '목표 없음' });

      const latest = await planQueries.latest(id);
      const approved = await planQueries.approved(id);
      const planFull = latest ? await planQueries.full(latest.id) : null;
      const events = await goalEventQueries.listByGoal(id, 100);
      const items = approved ? await goalItemQueries.listByGoal(id) : [];

      res.json({ ...(await decorate(goal)), plan: planFull, items, events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/goals/:id', async (req, res) => {
    const { id } = req.params;
    if (!GOAL_ID.test(id)) return bad(res, '잘못된 goal ID 형식');
    const { title, outcome, due_date } = req.body || {};
    if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return bad(res, '기한은 YYYY-MM-DD 형식이어야 합니다.');
    try {
      await goalQueries.update(id, { title, outcome, due_date });
      res.json(await goalQueries.get(id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/goals/:id', async (req, res) => {
    const { id } = req.params;
    if (!GOAL_ID.test(id)) return bad(res, '잘못된 goal ID 형식');
    try {
      await goalQueries.remove(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 상태 전환: 일시정지 / 재개 / 포기 ───────────────────────
  app.post('/api/goals/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, reason } = req.body || {};
    if (!GOAL_ID.test(id)) return bad(res, '잘못된 goal ID 형식');
    if (!['active', 'paused', 'done', 'abandoned'].includes(status)) {
      return bad(res, "status는 active|paused|done|abandoned 중 하나여야 합니다.");
    }
    try {
      const goal = await goalQueries.get(id);
      if (!goal) return res.status(404).json({ error: '목표 없음' });

      // 재개할 때도 프로젝트당 1개 규칙을 다시 확인한다 —
      // 일시정지 사이에 다른 목표가 활성화됐을 수 있다.
      if (status === 'active') {
        const busy = await goalQueries.findActiveInProject(goal.project_id, id);
        if (busy) {
          return res.status(409).json({
            error: `"${busy.title}"이(가) 진행 중이라 재개할 수 없습니다.`,
            conflict: busy,
          });
        }
        const approved = await planQueries.approved(id);
        if (!approved) return bad(res, '승인된 계획서가 없어 활성화할 수 없습니다.');
      }

      await goalQueries.setStatus(id, status, reason || null);
      await goalEventQueries.add({
        goal_id: id, kind: `goal_${status}`,
        message: `목표 상태 변경 → ${status}${reason ? ` (${reason})` : ''}`,
      });
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 되물음 답변 → 계획 재생성 ───────────────────────────────
  app.post('/api/goals/:id/clarify', async (req, res) => {
    const { id } = req.params;
    if (!GOAL_ID.test(id)) return bad(res, '잘못된 goal ID 형식');
    try {
      const result = await answerClarify(id, req.body?.answers, { notify });
      sendResult(res, result, () => ({ ok: true, status: 'planning' }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 계획 재생성 (코멘트 달아 다시) ──────────────────────────
  app.post('/api/goals/:id/replan', async (req, res) => {
    const { id } = req.params;
    if (!GOAL_ID.test(id)) return bad(res, '잘못된 goal ID 형식');
    try {
      const result = await requestReplan(id, req.body?.comment, { notify });
      sendResult(res, result, () => ({ ok: true, status: 'planning' }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 계획서 조회 / 승인 / 거부 ───────────────────────────────
  app.get('/api/plans/:planId', async (req, res) => {
    const { planId } = req.params;
    if (!PLAN_ID.test(planId)) return bad(res, '잘못된 plan ID 형식');
    try {
      const full = await planQueries.full(planId);
      if (!full) return res.status(404).json({ error: '계획서 없음' });
      res.json(full);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/plans/:planId/approve', async (req, res) => {
    const { planId } = req.params;
    if (!PLAN_ID.test(planId)) return bad(res, '잘못된 plan ID 형식');
    try {
      const result = await approvePlan(planId, { notify });
      sendResult(res, result, (r) => (r.already
        ? { ok: true, already: true }
        : { ok: true, itemCount: r.itemCount }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/plans/:planId/reject', async (req, res) => {
    const { planId } = req.params;
    if (!PLAN_ID.test(planId)) return bad(res, '잘못된 plan ID 형식');
    try {
      sendResult(res, await rejectPlan(planId, req.body?.comment));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 항목 조작 ───────────────────────────────────────────────
  app.post('/api/goal-items/:itemId/status', async (req, res) => {
    const { itemId } = req.params;
    const { status, reason } = req.body || {};
    if (!ITEM_ID.test(itemId)) return bad(res, '잘못된 item ID 형식');
    if (!['pending', 'skipped', 'blocked', 'done'].includes(status)) {
      return bad(res, 'status는 pending|skipped|blocked|done 중 하나여야 합니다.');
    }
    try {
      const item = await goalItemQueries.get(itemId);
      if (!item) return res.status(404).json({ error: '항목 없음' });
      await goalItemQueries.setStatus(itemId, status, { blocked_reason: reason || null });
      await goalEventQueries.add({
        goal_id: item.goal_id, item_id: itemId, kind: 'item_status_manual',
        message: `항목 상태 수동 변경 → ${status}: ${item.title}`.slice(0, 300),
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
