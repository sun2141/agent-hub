// src/api/goalRoutes.js
// 목표 계층 REST 라우트. server.js의 /api 인증 미들웨어 뒤에 등록된다.
//
// 여기 있는 라우트는 전부 "사람의 의도"를 다룬다. 실행 자체는 건드리지 않는다 —
// 실행은 goalExecutor가 승인된 계획을 보고 스스로 돌린다.

import { projectQueries } from '../db/db.js';
import {
  goalQueries, planQueries, goalItemQueries, goalEventQueries,
} from '../db/goals.js';
import { planGoal } from '../agent/goalPlanner.js';
import { computePace, describePace } from '../agent/pace.js';

const GOAL_ID = /^goal_[0-9]+_[a-z0-9]+$/;
const PLAN_ID = /^plan_[0-9]+_[a-z0-9]+$/;
const ITEM_ID = /^gi_[0-9]+_[a-z0-9]+$/;

function bad(res, msg) { return res.status(400).json({ error: msg }); }

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
    const { project_id, title, outcome, due_date, kind = 'build', autoplan = true } = req.body || {};

    if (!project_id || !String(project_id).trim()) return bad(res, 'project_id가 필요합니다.');
    if (!title || !String(title).trim())         return bad(res, '목표 제목이 필요합니다.');
    if (!outcome || !String(outcome).trim())     return bad(res, '완료 조건이 필요합니다. 이게 없으면 하네스가 완료를 판정할 수 없습니다.');
    if (!['build', 'research'].includes(kind))   return bad(res, "kind는 'build' 또는 'research'여야 합니다.");
    if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return bad(res, '기한은 YYYY-MM-DD 형식이어야 합니다.');

    try {
      const project = await projectQueries.get(project_id);
      if (!project) return res.status(404).json({ error: `프로젝트 ${project_id}를 찾을 수 없습니다.` });

      // 프로젝트당 활성 목표 1개 — 막지 않으면 둘 다 굶고, 이유를 알 수 없게 된다.
      const busy = await goalQueries.findActiveInProject(project_id);
      if (busy) {
        return res.status(409).json({
          error: `이 프로젝트에는 이미 진행 중인 목표가 있습니다: "${busy.title}" (${busy.status}). `
               + '프로젝트당 동시 1작업 제약 때문에 두 목표를 동시에 열면 서로 굶습니다. '
               + '기존 목표를 끝내거나 일시정지한 뒤 다시 시도하세요.',
          conflict: busy,
        });
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
        setImmediate(() => {
          planGoal(id, { projectResolver: (pid) => projectQueries.get(pid) })
            .then(async (result) => {
              if (!notify) return;
              if (result.kind === 'clarify') {
                await notify(
                  `❓ <b>결정이 필요합니다</b>\n${String(title).slice(0, 80)}\n\n`
                  + result.questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')
                  + '\n\n대시보드에서 답하면 계획을 만듭니다.'
                );
              } else if (result.kind === 'plan') {
                await notify(
                  `📋 <b>계획서 준비됨</b> v${result.version}\n${String(title).slice(0, 80)}\n`
                  + `항목 ${result.itemCount}개 · 승인 대기\n\n대시보드에서 검토하세요.`
                );
              } else {
                await notify(
                  `⚠️ <b>계획 생성 실패</b>\n${String(title).slice(0, 80)}\n`
                  + (result.errors ? result.errors.slice(0, 3).join('\n') : result.message || '')
                );
              }
            })
            .catch(() => { /* planGoal 내부에서 이미 이벤트로 기록한다 */ });
        });
      }

      res.status(201).json({ id, status: autoplan ? 'planning' : 'draft' });
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
    const { answers } = req.body || {};
    if (!answers || typeof answers !== 'object') return bad(res, 'answers 객체가 필요합니다.');

    try {
      const goal = await goalQueries.get(id);
      if (!goal) return res.status(404).json({ error: '목표 없음' });

      // 답변을 완료 조건에 합친다 — 계획 생성기가 별도 필드를 또 읽게 만들지 않는다.
      const appended = Object.entries(answers)
        .map(([q, a]) => `- ${q}: ${a}`)
        .join('\n');
      await goalQueries.setClarifyAnswers(id, answers);
      await goalQueries.update(id, {
        outcome: `${goal.outcome}\n\n[결정 사항]\n${appended}`.slice(0, 4000),
      });

      await goalEventQueries.add({
        goal_id: id, kind: 'clarify_answered',
        message: `결정 사항 ${Object.keys(answers).length}건 반영 — 계획 재생성`,
      });

      setImmediate(() => {
        planGoal(id, { projectResolver: (pid) => projectQueries.get(pid) }).catch(() => {});
      });

      res.json({ ok: true, status: 'planning' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 계획 재생성 (코멘트 달아 다시) ──────────────────────────
  app.post('/api/goals/:id/replan', async (req, res) => {
    const { id } = req.params;
    if (!GOAL_ID.test(id)) return bad(res, '잘못된 goal ID 형식');
    const { comment } = req.body || {};
    try {
      const goal = await goalQueries.get(id);
      if (!goal) return res.status(404).json({ error: '목표 없음' });

      const latest = await planQueries.latest(id);
      if (latest && latest.status === 'proposed') {
        await planQueries.reject(latest.id, comment || null);
      }
      if (comment) {
        await goalQueries.update(id, {
          outcome: `${goal.outcome}\n\n[수정 요청]\n${String(comment).slice(0, 1000)}`.slice(0, 4000),
        });
      }
      await goalEventQueries.add({
        goal_id: id, kind: 'replan_requested',
        message: `계획 재생성 요청${comment ? ` — ${String(comment).slice(0, 200)}` : ''}`,
      });

      setImmediate(() => {
        planGoal(id, { projectResolver: (pid) => projectQueries.get(pid) }).catch(() => {});
      });
      res.json({ ok: true, status: 'planning' });
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
      const plan = await planQueries.get(planId);
      if (!plan) return res.status(404).json({ error: '계획서 없음' });
      if (plan.status === 'approved') return res.json({ ok: true, already: true });
      if (plan.status !== 'proposed') {
        return bad(res, `이 계획서는 ${plan.status} 상태라 승인할 수 없습니다.`);
      }

      const ok = await planQueries.approve(planId);
      if (!ok) return res.status(500).json({ error: '승인 처리 실패' });

      const full = await planQueries.full(planId);
      await goalEventQueries.add({
        goal_id: plan.goal_id, kind: 'plan_approved',
        message: `계획서 v${plan.version} 승인 — 항목 ${full.items.length}개 자동 실행 시작`,
        payload: { planId, version: plan.version },
      });
      if (notify) {
        const goal = await goalQueries.get(plan.goal_id);
        await notify(
          `✅ <b>계획 승인됨</b> v${plan.version}\n${(goal?.title || '').slice(0, 80)}\n`
          + `항목 ${full.items.length}개를 순서대로 자동 실행합니다.`
        ).catch(() => {});
      }
      res.json({ ok: true, itemCount: full.items.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/plans/:planId/reject', async (req, res) => {
    const { planId } = req.params;
    if (!PLAN_ID.test(planId)) return bad(res, '잘못된 plan ID 형식');
    try {
      const plan = await planQueries.get(planId);
      if (!plan) return res.status(404).json({ error: '계획서 없음' });
      await planQueries.reject(planId, req.body?.comment || null);
      await goalQueries.setStatus(plan.goal_id, 'draft');
      await goalEventQueries.add({
        goal_id: plan.goal_id, kind: 'plan_rejected_by_user',
        message: `계획서 v${plan.version} 폐기`,
      });
      res.json({ ok: true });
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
