// src/db/db.js
// Neon DB (PostgreSQL) 스키마 정의 및 쿼리 모음
// harness 전용 스키마(harness)를 사용하여 기존 public 스키마와 분리

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
  const s = getSql();
  const rows = await s.query(query, params);
  return rows;
}

async function dbGet(query, params = []) {
  const s = getSql();
  const rows = await s.query(query, params);
  return rows[0] || null;
}

async function dbAll(query, params = []) {
  const s = getSql();
  const rows = await s.query(query, params);
  return rows || [];
}

async function ensureOperationalIndexes() {
  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_harness_projects_active_hidden_created_at
    ON harness.projects (active, hidden, created_at DESC)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_harness_tasks_project_created_at
    ON harness.tasks (project_id, created_at DESC)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_harness_tasks_status_resume
    ON harness.tasks (status, scheduled_resume_at)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_harness_tasks_status_created_at
    ON harness.tasks (status, created_at DESC)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_harness_logs_task_created_at
    ON harness.logs (task_id, created_at DESC)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_harness_limit_events_notification
    ON harness.limit_events (notified, resumed_at, resume_available_at)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_harness_limit_events_task_created_at
    ON harness.limit_events (task_id, created_at DESC)
  `);
}

// ── DB 초기화 (harness 스키마 생성 + 테이블) ──────────────────
export async function initDb() {
  // harness 전용 스키마 생성
  await dbRun(`CREATE SCHEMA IF NOT EXISTS harness`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS harness.projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      stack       TEXT,
      description TEXT,
      github      TEXT,
      deploy      TEXT,
      active      INTEGER DEFAULT 1,
      hidden      INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
      updated_at  TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS harness.tasks (
      id                   TEXT PRIMARY KEY,
      project_id           TEXT NOT NULL REFERENCES harness.projects(id),
      prompt               TEXT NOT NULL,
      status               TEXT DEFAULT 'pending',
      plan                 TEXT,
      eval_result          TEXT,
      round                INTEGER DEFAULT 0,
      max_rounds           INTEGER DEFAULT 10,
      error                TEXT,
      commit_sha           TEXT,
      deploy_status        TEXT,
      provider             TEXT DEFAULT 'claude',
      model                TEXT,
      session_id           TEXT,
      scheduled_resume_at  TEXT,
      created_at           TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
      updated_at           TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    )
  `);

  // 기존 테이블 마이그레이션 (CREATE TABLE IF NOT EXISTS는 컬럼 추가를 못 하므로)
  await dbRun(`ALTER TABLE harness.tasks ADD COLUMN IF NOT EXISTS model TEXT`);
  await dbRun(`ALTER TABLE harness.tasks ADD COLUMN IF NOT EXISTS session_id TEXT`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS harness.logs (
      id         SERIAL PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES harness.tasks(id),
      phase      TEXT NOT NULL,
      round      INTEGER DEFAULT 0,
      level      TEXT DEFAULT 'info',
      content    TEXT NOT NULL,
      created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS harness.limit_events (
      id                  SERIAL PRIMARY KEY,
      task_id             TEXT,
      project_id          TEXT,
      detected_at         TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
      resume_available_at TEXT,
      checkpoint_path     TEXT,
      checkpoint_summary  TEXT,
      notified            INTEGER DEFAULT 0,
      resumed_at          TEXT,
      created_at          TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    )
  `);

  // updated_at 자동 갱신 트리거
  await dbRun(`
    CREATE OR REPLACE FUNCTION harness.update_tasks_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await dbRun(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'harness_tasks_updated_at'
      ) THEN
        CREATE TRIGGER harness_tasks_updated_at
        BEFORE UPDATE ON harness.tasks
        FOR EACH ROW EXECUTE FUNCTION harness.update_tasks_updated_at();
      END IF;
    END;
    $$
  `);

  await ensureOperationalIndexes();

  console.log('[DB] Neon DB (harness 스키마) 초기화 완료');
  return true;
}

export function getDb() {
  return getSql();
}

// ── projects ──────────────────────────────────────────────────
export const projectQueries = {
  async seed(projects) {
    for (const p of projects) {
      await dbRun(`
        INSERT INTO harness.projects (id, name, path, stack, description)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name,
          path = EXCLUDED.path,
          stack = EXCLUDED.stack,
          description = EXCLUDED.description
      `, [p.id, p.name, p.path, p.stack, p.description]);
    }
  },

  async list({ includeHidden = false } = {}) {
    const hiddenFilter = includeHidden ? '' : 'AND (p.hidden IS NULL OR p.hidden = 0)';
    return dbAll(`
      SELECT p.*,
        (SELECT status FROM harness.tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_status,
        (SELECT created_at FROM harness.tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_at
      FROM harness.projects p WHERE p.active = 1 ${hiddenFilter}
      ORDER BY p.created_at DESC
    `);
  },

  async listHidden() {
    return dbAll(`
      SELECT p.*,
        (SELECT status FROM harness.tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_status,
        (SELECT created_at FROM harness.tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_at
      FROM harness.projects p WHERE p.active = 1 AND p.hidden = 1
      ORDER BY p.updated_at DESC
    `);
  },

  async get(id) {
    return dbGet('SELECT * FROM harness.projects WHERE id = $1', [id]);
  },

  async insert({ id, name, path, stack, description, github, deploy }) {
    await dbRun(
      'INSERT INTO harness.projects (id, name, path, stack, description, github, deploy) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, name, path, stack || null, description || null, github || null, deploy || null]
    );
    return dbGet('SELECT * FROM harness.projects WHERE id = $1', [id]);
  },

  async update(id, { name, path, stack, description, github, deploy }) {
    const fields = [];
    const values = [];
    let idx = 1;
    if (name        !== undefined) { fields.push(`name = $${idx++}`);        values.push(name); }
    if (path        !== undefined) { fields.push(`path = $${idx++}`);        values.push(path); }
    if (stack       !== undefined) { fields.push(`stack = $${idx++}`);       values.push(stack || null); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description || null); }
    if (github      !== undefined) { fields.push(`github = $${idx++}`);      values.push(github || null); }
    if (deploy      !== undefined) { fields.push(`deploy = $${idx++}`);      values.push(deploy || null); }
    if (fields.length === 0) return dbGet('SELECT * FROM harness.projects WHERE id = $1', [id]);
    fields.push(`updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
    values.push(id);
    await dbRun(`UPDATE harness.projects SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    return dbGet('SELECT * FROM harness.projects WHERE id = $1', [id]);
  },

  async setVisibility(id, hidden) {
    await dbRun(
      `UPDATE harness.projects SET hidden = $1, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2`,
      [hidden ? 1 : 0, id]
    );
    return dbGet('SELECT * FROM harness.projects WHERE id = $1', [id]);
  },

  async remove(id) {
    await dbRun('DELETE FROM harness.projects WHERE id = $1', [id]);
  },

  async countTasks(id) {
    const row = await dbGet('SELECT COUNT(*) AS cnt FROM harness.tasks WHERE project_id = $1', [id]);
    return row ? Number(row.cnt) : 0;
  },

  async removeWithTasks(id) {
    const tasks = await dbAll('SELECT id FROM harness.tasks WHERE project_id = $1', [id]);
    for (const t of tasks) {
      await dbRun('DELETE FROM harness.logs WHERE task_id = $1', [t.id]);
    }
    await dbRun('DELETE FROM harness.tasks WHERE project_id = $1', [id]);
    await dbRun('DELETE FROM harness.projects WHERE id = $1', [id]);
  },
};

// ── tasks ─────────────────────────────────────────────────────
export const taskQueries = {
  async create({ id, project_id, prompt, max_rounds = 10 }) {
    await dbRun(
      'INSERT INTO harness.tasks (id, project_id, prompt, max_rounds) VALUES ($1, $2, $3, $4)',
      [id, project_id, prompt, max_rounds]
    );
  },

  async get(id) {
    return dbGet('SELECT * FROM harness.tasks WHERE id = $1', [id]);
  },

  async list(limit = 20) {
    return dbAll(`
      SELECT t.*, p.name AS project_name
      FROM harness.tasks t JOIN harness.projects p ON t.project_id = p.id
      ORDER BY t.created_at DESC LIMIT $1
    `, [limit]);
  },

  async updateStatus(id, status, extra = {}) {
    const keys = Object.keys(extra);
    if (keys.length === 0) {
      await dbRun('UPDATE harness.tasks SET status = $1 WHERE id = $2', [status, id]);
    } else {
      let idx = 2;
      const fields = keys.map(k => `${k} = $${idx++}`).join(', ');
      const values = keys.map(k => extra[k]);
      await dbRun(
        `UPDATE harness.tasks SET status = $1, ${fields} WHERE id = $${idx}`,
        [status, ...values, id]
      );
    }
  },

  async incrementRound(id) {
    await dbRun('UPDATE harness.tasks SET round = round + 1 WHERE id = $1', [id]);
  },

  async updateCommit(id, commitSha) {
    await dbRun('UPDATE harness.tasks SET commit_sha = $1 WHERE id = $2', [commitSha, id]);
  },

  async updateDeploy(id, deployStatus) {
    await dbRun('UPDATE harness.tasks SET deploy_status = $1 WHERE id = $2', [deployStatus, id]);
  },

  async updateProvider(id, provider) {
    await dbRun('UPDATE harness.tasks SET provider = $1 WHERE id = $2', [provider, id]);
  },
  async updateModel(id, model) {
    await dbRun('UPDATE harness.tasks SET model = $1 WHERE id = $2', [model, id]);
  },

  async updateSessionId(id, sessionId) {
    await dbRun('UPDATE harness.tasks SET session_id = $1 WHERE id = $2', [sessionId, id]);
  },

  async updateScheduledResumeAt(id, scheduledResumeAt) {
    await dbRun('UPDATE harness.tasks SET scheduled_resume_at = $1 WHERE id = $2', [scheduledResumeAt, id]);
  },

  async getActiveForProject(projectId) {
    return dbGet(
      "SELECT id, status FROM harness.tasks WHERE project_id = $1 AND status NOT IN ('done','failed','paused','rate_limited') ORDER BY created_at DESC LIMIT 1",
      [projectId]
    );
  },

  async getPendingRateLimitedTasks() {
    return dbAll(
      `SELECT * FROM harness.tasks WHERE status = 'rate_limited' AND scheduled_resume_at IS NOT NULL AND scheduled_resume_at <= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') ORDER BY scheduled_resume_at ASC`
    );
  },

  async getRateLimitedTasks() {
    return dbAll(
      "SELECT * FROM harness.tasks WHERE status = 'rate_limited' ORDER BY created_at DESC"
    );
  },
};

// ── logs ──────────────────────────────────────────────────────
export const logQueries = {
  async append({ task_id, phase, round = 0, level = 'info', content }) {
    await dbRun(
      'INSERT INTO harness.logs (task_id, phase, round, level, content) VALUES ($1, $2, $3, $4, $5)',
      [task_id, phase, round, level, content]
    );
  },

  async forTask(task_id, limit = 200) {
    return dbAll(
      'SELECT * FROM harness.logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2',
      [task_id, limit]
    );
  },

  async deleteForTask(task_id) {
    await dbRun('DELETE FROM harness.logs WHERE task_id = $1', [task_id]);
  },
};

// ── limit_events ───────────────────────────────────────────────
export const limitEventQueries = {
  async insert({ task_id, project_id, resume_available_at, checkpoint_path, checkpoint_summary }) {
    const rows = await dbRun(
      `INSERT INTO harness.limit_events (task_id, project_id, resume_available_at, checkpoint_path, checkpoint_summary)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [task_id || null, project_id || null, resume_available_at || null, checkpoint_path || null, checkpoint_summary || null]
    );
    const id = rows[0]?.id;
    return dbGet('SELECT * FROM harness.limit_events WHERE id = $1', [id]);
  },

  async list(limit = 20) {
    return dbAll(
      'SELECT * FROM harness.limit_events ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
  },

  async getLatestActive() {
    // task가 여전히 rate_limited 상태인 이벤트만 반환
    return dbGet(
      `SELECT le.* FROM harness.limit_events le
       LEFT JOIN harness.tasks t ON le.task_id = t.id
       WHERE le.resumed_at IS NULL
         AND (le.task_id IS NULL OR t.status = 'rate_limited')
       ORDER BY le.created_at DESC LIMIT 1`
    );
  },

  async markNotified(id) {
    await dbRun('UPDATE harness.limit_events SET notified = 1 WHERE id = $1', [id]);
  },

  async markResumed(id) {
    await dbRun(
      `UPDATE harness.limit_events SET resumed_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1`,
      [id]
    );
  },

  async getPendingNotifications() {
    return dbAll(
      `SELECT * FROM harness.limit_events WHERE notified = 0 AND resumed_at IS NULL AND resume_available_at IS NOT NULL AND resume_available_at <= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') ORDER BY created_at ASC`
    );
  },
};

// ── 작업 삭제 (logs → tasks 순서로 삭제하여 FK 제약 준수) ──────
export async function deleteTask(task_id) {
  await logQueries.deleteForTask(task_id);
  await dbRun('DELETE FROM harness.tasks WHERE id = $1', [task_id]);
}
