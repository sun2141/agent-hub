// src/db/goals.js
// 목표(goal) 계층 — 스키마 정의 및 쿼리 모음
//
// 기존 계층:  project → backlog_item(한 줄) → task
// 추가 계층:  project → goal(목표+기한) → plan(계획서, 승인 단위)
//                       → workstream/milestone → goal_item → task
//
// 설계 원칙
//  - 사람이 넣는 최소 단위를 "목표 + 완료조건 + 기한"으로 올리고 분해는 하네스가 한다.
//  - 승인은 계획서(plan)에 1회. 승인 후 goal_item은 자동 실행 큐로 들어간다.
//  - 실행 상태의 원본은 여전히 harness.tasks다. goal_item.task_id가 유일한 연결 고리이며
//    goal_item.status는 tasks를 복제한 게 아니라 "계획 관점의 진행 상태"다.
//  - 배열은 TEXT(JSON 문자열)로 저장한다. 이 코드베이스는 어디서도 PG 배열을 쓰지 않으므로
//    드라이버 배열 직렬화 차이에 노출되지 않는 쪽을 택했다. 파싱은 이 파일 안에서만 한다.

import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

let _sql = null;

function getSql() {
  if (!_sql) {
    const dbUrl = process.env.NEON_DATABASE_URL;
    if (!dbUrl) throw new Error('NEON_DATABASE_URL 환경변수가 설정되지 않았습니다.');
    _sql = neon(dbUrl);
  }
  return _sql;
}

async function dbRun(query, params = []) {
  return getSql().query(query, params);
}
async function dbGet(query, params = []) {
  const rows = await getSql().query(query, params);
  return rows[0] || null;
}
async function dbAll(query, params = []) {
  const rows = await getSql().query(query, params);
  return rows || [];
}

const NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

// pace.js 등 같은 스키마를 읽는 모듈이 커넥션을 새로 만들지 않게 공개한다.
export { dbRun, dbGet, dbAll, NOW };

export function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// JSON 컬럼 안전 파싱 — 깨진 값이 목록 조회 전체를 죽이지 않게 한다.
function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ── 상태 정의 ──────────────────────────────────────────────────
export const GOAL_STATUS = [
  'draft',       // 저장만 됨
  'clarify',     // 하네스가 되물음 — 답이 와야 계획 생성
  'planning',    // 계획 생성 중
  'plan_review', // 계획서 승인 대기
  'active',      // 승인됨, 항목 자동 실행 중
  'paused',      // 사람 개입 필요 (차단기 발동 포함)
  'done',
  'abandoned',
];

export const ITEM_STATUS = [
  'pending', 'queued', 'running', 'needs_review',
  'done', 'failed', 'blocked', 'skipped',
];

// 실행이 끝난 것으로 보는 상태 — 진행률/용량 계산에서 "남은 작업"에서 빠진다.
export const ITEM_TERMINAL = ['done', 'skipped'];

// ── 스키마 ─────────────────────────────────────────────────────
export async function initGoalSchema() {
  await dbRun(`CREATE SCHEMA IF NOT EXISTS harness`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS harness.goals (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES harness.projects(id),
      kind              TEXT DEFAULT 'build',
      title             TEXT NOT NULL,
      outcome           TEXT NOT NULL,
      due_date          TEXT,
      status            TEXT DEFAULT 'draft',
      clarify_questions TEXT,
      clarify_answers   TEXT,
      paused_reason     TEXT,
      created_at        TEXT DEFAULT (${NOW}),
      updated_at        TEXT DEFAULT (${NOW})
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS harness.goal_plans (
      id               TEXT PRIMARY KEY,
      goal_id          TEXT NOT NULL REFERENCES harness.goals(id) ON DELETE CASCADE,
      version          INTEGER NOT NULL DEFAULT 1,
      status           TEXT DEFAULT 'proposed',
      rationale        TEXT,
      risk_notes       TEXT,
      scope_cut        TEXT,
      planner_provider TEXT,
      planner_model    TEXT,
      review_comment   TEXT,
      approved_at      TEXT,
      created_at       TEXT DEFAULT (${NOW}),
      UNIQUE (goal_id, version)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS harness.goal_workstreams (
      id          TEXT PRIMARY KEY,
      plan_id     TEXT NOT NULL REFERENCES harness.goal_plans(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      file_scope  TEXT,
      depends_on  TEXT,
      order_index INTEGER DEFAULT 0
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS harness.goal_milestones (
      id            TEXT PRIMARY KEY,
      plan_id       TEXT NOT NULL REFERENCES harness.goal_plans(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      target_date   TEXT,
      exit_criteria TEXT,
      order_index   INTEGER DEFAULT 0
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS harness.goal_items (
      id                  TEXT PRIMARY KEY,
      goal_id             TEXT NOT NULL REFERENCES harness.goals(id) ON DELETE CASCADE,
      plan_id             TEXT NOT NULL REFERENCES harness.goal_plans(id) ON DELETE CASCADE,
      workstream_id       TEXT,
      milestone_id        TEXT,
      title               TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      verify_cmd          TEXT,
      target_paths        TEXT,
      report_path         TEXT,
      est_runs            INTEGER DEFAULT 1,
      order_index         INTEGER DEFAULT 0,
      status              TEXT DEFAULT 'pending',
      attempts            INTEGER DEFAULT 0,
      task_id             TEXT,
      pr_url              TEXT,
      blocked_reason      TEXT,
      created_at          TEXT DEFAULT (${NOW}),
      updated_at          TEXT DEFAULT (${NOW})
    )
  `);

  // 진행 이벤트 — 대시보드 타임라인의 원본.
  // payload에 CLI 원문 로그를 넣지 않는다(스토리지 방어). 요약만.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS harness.goal_events (
      id         SERIAL PRIMARY KEY,
      goal_id    TEXT,
      item_id    TEXT,
      kind       TEXT NOT NULL,
      message    TEXT NOT NULL,
      payload    TEXT,
      created_at TEXT DEFAULT (${NOW})
    )
  `);

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_harness_goals_project_status
               ON harness.goals (project_id, status)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_harness_goal_items_goal_status
               ON harness.goal_items (goal_id, status)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_harness_goal_items_plan_order
               ON harness.goal_items (plan_id, order_index)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_harness_goal_events_goal_created
               ON harness.goal_events (goal_id, created_at DESC)`);

  console.log('[DB] 목표 계층 스키마 초기화 완료');
  return true;
}

// ── goals ──────────────────────────────────────────────────────
export const goalQueries = {
  async create({ project_id, title, outcome, due_date = null, kind = 'build' }) {
    const id = newId('goal');
    await dbRun(
      `INSERT INTO harness.goals (id, project_id, kind, title, outcome, due_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')`,
      [id, project_id, kind, title, outcome, due_date]
    );
    return id;
  },

  async get(id) {
    const row = await dbGet(
      `SELECT g.*, p.name AS project_name
       FROM harness.goals g
       JOIN harness.projects p ON g.project_id = p.id
       WHERE g.id = $1`,
      [id]
    );
    if (!row) return null;
    row.clarify_questions = parseJson(row.clarify_questions, []);
    row.clarify_answers = parseJson(row.clarify_answers, {});
    return row;
  },

  async list({ projectId = null, status = null } = {}) {
    const where = [];
    const params = [];
    if (projectId) { params.push(projectId); where.push(`g.project_id = $${params.length}`); }
    if (status)    { params.push(status);    where.push(`g.status = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return dbAll(
      `SELECT g.*, p.name AS project_name
       FROM harness.goals g
       JOIN harness.projects p ON g.project_id = p.id
       ${clause}
       ORDER BY g.created_at DESC`,
      params
    );
  },

  // 프로젝트당 활성 목표는 1개로 제한한다.
  // 프로젝트당 동시 1작업이라 둘을 동시에 열면 서로 굶기 때문 —
  // 막지 않으면 "진행이 안 되는데 이유를 모르는" 상태가 된다.
  async findActiveInProject(projectId, excludeGoalId = null) {
    const params = [projectId];
    let extra = '';
    if (excludeGoalId) { params.push(excludeGoalId); extra = ` AND id <> $${params.length}`; }
    return dbGet(
      `SELECT id, title, status FROM harness.goals
       WHERE project_id = $1 AND status IN ('planning','plan_review','active')${extra}
       ORDER BY created_at ASC LIMIT 1`,
      params
    );
  },

  async setStatus(id, status, reason = null) {
    await dbRun(
      `UPDATE harness.goals
       SET status = $2, paused_reason = $3, updated_at = ${NOW}
       WHERE id = $1`,
      [id, status, reason]
    );
  },

  async setClarify(id, questions) {
    await dbRun(
      `UPDATE harness.goals
       SET status = 'clarify', clarify_questions = $2, updated_at = ${NOW}
       WHERE id = $1`,
      [id, JSON.stringify(questions || [])]
    );
  },

  async setClarifyAnswers(id, answers) {
    await dbRun(
      `UPDATE harness.goals
       SET clarify_answers = $2, updated_at = ${NOW}
       WHERE id = $1`,
      [id, JSON.stringify(answers || {})]
    );
  },

  async update(id, { title, outcome, due_date }) {
    await dbRun(
      `UPDATE harness.goals
       SET title = COALESCE($2, title),
           outcome = COALESCE($3, outcome),
           due_date = COALESCE($4, due_date),
           updated_at = ${NOW}
       WHERE id = $1`,
      [id, title ?? null, outcome ?? null, due_date ?? null]
    );
  },

  async remove(id) {
    await dbRun(`DELETE FROM harness.goals WHERE id = $1`, [id]);
  },

  // 진행률 롤업 — 대시보드 카드와 pace 계산의 입력
  async progress(goalId) {
    const row = await dbGet(
      `SELECT
         COUNT(*)                                                   AS total,
         COUNT(*) FILTER (WHERE status IN ('done','skipped'))        AS finished,
         COUNT(*) FILTER (WHERE status = 'failed')                   AS failed,
         COUNT(*) FILTER (WHERE status = 'blocked')                  AS blocked,
         COUNT(*) FILTER (WHERE status IN ('queued','running'))      AS in_flight,
         COALESCE(SUM(est_runs) FILTER
           (WHERE status NOT IN ('done','skipped')), 0)              AS remaining_runs
       FROM harness.goal_items
       WHERE goal_id = $1
         AND plan_id = (SELECT id FROM harness.goal_plans
                        WHERE goal_id = $1 AND status = 'approved'
                        ORDER BY version DESC LIMIT 1)`,
      [goalId]
    );
    if (!row) return { total: 0, finished: 0, failed: 0, blocked: 0, in_flight: 0, remaining_runs: 0 };
    return {
      total: Number(row.total),
      finished: Number(row.finished),
      failed: Number(row.failed),
      blocked: Number(row.blocked),
      in_flight: Number(row.in_flight),
      remaining_runs: Number(row.remaining_runs),
    };
  },
};

// ── plans ──────────────────────────────────────────────────────
export const planQueries = {
  // 계획서 한 벌을 통째로 저장한다.
  // 실패 시 절반만 남으면 승인 화면이 깨지므로, 실패하면 plan을 지워 흔적을 남기지 않는다
  // (neon HTTP 드라이버는 트랜잭션을 걸 수 없어 보상 삭제로 대신한다).
  async createFull({ goal_id, rationale, risk_notes, scope_cut, planner_provider, planner_model, workstreams = [], milestones = [], items = [] }) {
    const prev = await dbGet(
      `SELECT COALESCE(MAX(version), 0) AS v FROM harness.goal_plans WHERE goal_id = $1`,
      [goal_id]
    );
    const version = Number(prev?.v || 0) + 1;
    const planId = newId('plan');

    await dbRun(
      `INSERT INTO harness.goal_plans
         (id, goal_id, version, status, rationale, risk_notes, scope_cut, planner_provider, planner_model)
       VALUES ($1, $2, $3, 'proposed', $4, $5, $6, $7, $8)`,
      [planId, goal_id, version, rationale || null, risk_notes || null,
       scope_cut ? JSON.stringify(scope_cut) : null, planner_provider || null, planner_model || null]
    );

    try {
      const wsIdByKey = {};
      for (let i = 0; i < workstreams.length; i++) {
        const ws = workstreams[i];
        const id = newId('ws');
        wsIdByKey[ws.key || ws.name] = id;
        await dbRun(
          `INSERT INTO harness.goal_workstreams (id, plan_id, name, file_scope, depends_on, order_index)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, planId, ws.name, JSON.stringify(ws.file_scope || []),
           JSON.stringify(ws.depends_on || []), i]
        );
      }

      const msIdByKey = {};
      for (let i = 0; i < milestones.length; i++) {
        const ms = milestones[i];
        const id = newId('ms');
        msIdByKey[ms.key || ms.title] = id;
        await dbRun(
          `INSERT INTO harness.goal_milestones (id, plan_id, title, target_date, exit_criteria, order_index)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, planId, ms.title, ms.target_date || null, ms.exit_criteria || null, i]
        );
      }

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        await dbRun(
          `INSERT INTO harness.goal_items
             (id, goal_id, plan_id, workstream_id, milestone_id, title, acceptance_criteria,
              verify_cmd, target_paths, report_path, est_runs, order_index, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')`,
          [newId('gi'), goal_id, planId,
           wsIdByKey[it.workstream] || null,
           msIdByKey[it.milestone] || null,
           it.title, it.acceptance_criteria,
           it.verify_cmd || null,
           JSON.stringify(it.target_paths || []),
           it.report_path || null,
           Number(it.est_runs) || 1, i]
        );
      }
    } catch (err) {
      await dbRun(`DELETE FROM harness.goal_plans WHERE id = $1`, [planId]).catch(() => {});
      throw err;
    }

    return { planId, version };
  },

  async get(planId) {
    return dbGet(`SELECT * FROM harness.goal_plans WHERE id = $1`, [planId]);
  },

  async latest(goalId) {
    return dbGet(
      `SELECT * FROM harness.goal_plans WHERE goal_id = $1 ORDER BY version DESC LIMIT 1`,
      [goalId]
    );
  },

  async approved(goalId) {
    return dbGet(
      `SELECT * FROM harness.goal_plans
       WHERE goal_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1`,
      [goalId]
    );
  },

  // 계획서 전문 — 승인 화면이 쓰는 형태
  async full(planId) {
    const plan = await dbGet(`SELECT * FROM harness.goal_plans WHERE id = $1`, [planId]);
    if (!plan) return null;
    plan.scope_cut = parseJson(plan.scope_cut, null);

    const workstreams = await dbAll(
      `SELECT * FROM harness.goal_workstreams WHERE plan_id = $1 ORDER BY order_index`, [planId]);
    for (const w of workstreams) {
      w.file_scope = parseJson(w.file_scope, []);
      w.depends_on = parseJson(w.depends_on, []);
    }

    const milestones = await dbAll(
      `SELECT * FROM harness.goal_milestones WHERE plan_id = $1 ORDER BY order_index`, [planId]);

    const items = await dbAll(
      `SELECT * FROM harness.goal_items WHERE plan_id = $1 ORDER BY order_index`, [planId]);
    for (const it of items) it.target_paths = parseJson(it.target_paths, []);

    return { plan, workstreams, milestones, items };
  },

  async approve(planId) {
    const plan = await dbGet(`SELECT goal_id, version FROM harness.goal_plans WHERE id = $1`, [planId]);
    if (!plan) return false;
    // 이전 승인본은 superseded로 내린다 — 승인본이 둘이면 실행 큐가 두 계획을 섞는다.
    await dbRun(
      `UPDATE harness.goal_plans SET status = 'superseded'
       WHERE goal_id = $1 AND status = 'approved' AND id <> $2`,
      [plan.goal_id, planId]
    );
    await dbRun(
      `UPDATE harness.goal_plans SET status = 'approved', approved_at = ${NOW} WHERE id = $1`,
      [planId]
    );
    await dbRun(
      `UPDATE harness.goals SET status = 'active', updated_at = ${NOW} WHERE id = $1`,
      [plan.goal_id]
    );
    return true;
  },

  async reject(planId, comment = null) {
    await dbRun(
      `UPDATE harness.goal_plans SET status = 'rejected', review_comment = $2 WHERE id = $1`,
      [planId, comment]
    );
  },
};

// ── goal_items ─────────────────────────────────────────────────
export const goalItemQueries = {
  async get(id) {
    const row = await dbGet(
      `SELECT i.*, g.project_id, g.kind AS goal_kind, g.title AS goal_title
       FROM harness.goal_items i
       JOIN harness.goals g ON i.goal_id = g.id
       WHERE i.id = $1`,
      [id]
    );
    if (row) row.target_paths = parseJson(row.target_paths, []);
    return row;
  },

  // 지금 실행해도 되는 다음 항목 하나.
  // 조건: 승인된 계획 + 활성 목표 + 앞선 워크스트림 의존성이 끝났을 것.
  // 의존성은 order_index로 근사한다 — 같은 워크스트림 안에서는 순서가 곧 의존이고,
  // 워크스트림 간 의존은 계획 생성 시 order_index에 이미 반영된다.
  async nextRunnable(projectId = null) {
    const params = [];
    let projClause = '';
    if (projectId) { params.push(projectId); projClause = ` AND g.project_id = $${params.length}`; }
    return dbGet(
      `SELECT i.*, g.project_id, g.kind AS goal_kind, g.title AS goal_title
       FROM harness.goal_items i
       JOIN harness.goals g       ON i.goal_id = g.id
       JOIN harness.goal_plans pl ON i.plan_id = pl.id
       WHERE i.status = 'pending'
         AND g.status = 'active'
         AND pl.status = 'approved'${projClause}
         AND NOT EXISTS (
           SELECT 1 FROM harness.goal_items b
           WHERE b.plan_id = i.plan_id
             AND b.order_index < i.order_index
             AND b.status NOT IN ('done','skipped')
         )
       ORDER BY i.order_index ASC
       LIMIT 1`,
      params
    );
  },

  // task_id로 역참조 — 실행기가 runner 이벤트를 받아 항목을 찾을 때 쓴다.
  async findByTask(taskId) {
    const row = await dbGet(
      `SELECT i.*, g.project_id, g.kind AS goal_kind, g.title AS goal_title, g.due_date
       FROM harness.goal_items i
       JOIN harness.goals g ON i.goal_id = g.id
       WHERE i.task_id = $1
       ORDER BY i.updated_at DESC LIMIT 1`,
      [taskId]
    );
    if (row) row.target_paths = parseJson(row.target_paths, []);
    return row;
  },

  async listByGoal(goalId) {
    const rows = await dbAll(
      `SELECT i.* FROM harness.goal_items i
       JOIN harness.goal_plans pl ON i.plan_id = pl.id
       WHERE i.goal_id = $1 AND pl.status = 'approved'
       ORDER BY i.order_index`,
      [goalId]
    );
    for (const r of rows) r.target_paths = parseJson(r.target_paths, []);
    return rows;
  },

  async setStatus(id, status, extra = {}) {
    await dbRun(
      `UPDATE harness.goal_items
       SET status = $2,
           task_id        = COALESCE($3, task_id),
           pr_url         = COALESCE($4, pr_url),
           report_path    = COALESCE($5, report_path),
           blocked_reason = $6,
           updated_at     = ${NOW}
       WHERE id = $1`,
      [id, status, extra.task_id ?? null, extra.pr_url ?? null,
       extra.report_path ?? null, extra.blocked_reason ?? null]
    );
  },

  async incrementAttempts(id) {
    const row = await dbGet(
      `UPDATE harness.goal_items SET attempts = attempts + 1, updated_at = ${NOW}
       WHERE id = $1 RETURNING attempts`,
      [id]
    );
    return Number(row?.attempts || 0);
  },

  // 사람 개입이 필요한 항목만 — 대시보드 인박스
  async inbox() {
    const rows = await dbAll(
      `SELECT i.*, g.title AS goal_title, g.project_id, p.name AS project_name
       FROM harness.goal_items i
       JOIN harness.goals g    ON i.goal_id = g.id
       JOIN harness.projects p ON g.project_id = p.id
       WHERE i.status IN ('blocked','needs_review','failed')
       ORDER BY i.updated_at DESC`
    );
    for (const r of rows) r.target_paths = parseJson(r.target_paths, []);
    return rows;
  },

  // 24시간 내 이 목표의 실패 건수 — 차단기(circuit breaker) 입력
  async recentFailures(goalId, hours = 24) {
    const row = await dbGet(
      `SELECT COUNT(*) AS cnt FROM harness.goal_items
       WHERE goal_id = $1 AND status = 'failed'
         AND updated_at >= to_char((now() AT TIME ZONE 'UTC') - ($2 || ' hours')::interval,
                                   'YYYY-MM-DD HH24:MI:SS')`,
      [goalId, String(hours)]
    );
    return row ? Number(row.cnt) : 0;
  },

  // 오늘(UTC) 목표 경로로 시작된 실행 수 — 일일 상한 계산용.
  // 백로그 버튼 경로의 상한과 합산해서 봐야 하므로 여기서는 목표 몫만 센다.
  async countStartedToday() {
    const row = await dbGet(
      `SELECT COUNT(*) AS cnt FROM harness.goal_items
       WHERE task_id IS NOT NULL
         AND updated_at >= to_char(date_trunc('day', now() AT TIME ZONE 'UTC'),
                                   'YYYY-MM-DD HH24:MI:SS')`
    );
    return row ? Number(row.cnt) : 0;
  },
};

// ── goal_events ────────────────────────────────────────────────
const EVENT_MESSAGE_MAX = 500;

export const goalEventQueries = {
  async add({ goal_id = null, item_id = null, kind, message, payload = null }) {
    const msg = String(message || '').slice(0, EVENT_MESSAGE_MAX);
    await dbRun(
      `INSERT INTO harness.goal_events (goal_id, item_id, kind, message, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [goal_id, item_id, kind, msg, payload ? JSON.stringify(payload) : null]
    );
  },

  async listByGoal(goalId, limit = 100) {
    const rows = await dbAll(
      `SELECT * FROM harness.goal_events WHERE goal_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [goalId, limit]
    );
    for (const r of rows) r.payload = parseJson(r.payload, null);
    return rows;
  },

  async recent(limit = 50) {
    const rows = await dbAll(
      `SELECT e.*, g.title AS goal_title FROM harness.goal_events e
       LEFT JOIN harness.goals g ON e.goal_id = g.id
       ORDER BY e.created_at DESC, e.id DESC LIMIT $1`,
      [limit]
    );
    for (const r of rows) r.payload = parseJson(r.payload, null);
    return rows;
  },

  // Neon Free는 0.5GB 상한이고 스케줄러가 없다 — 청소도 하네스 몫이다.
  async prune(days = 90) {
    const rows = await dbRun(
      `DELETE FROM harness.goal_events
       WHERE created_at < to_char((now() AT TIME ZONE 'UTC') - ($1 || ' days')::interval,
                                  'YYYY-MM-DD HH24:MI:SS')
       RETURNING id`,
      [String(days)]
    );
    return rows.length;
  },
};
