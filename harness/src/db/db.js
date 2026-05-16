// src/db/db.js
// SQLite 스키마 정의 및 쿼리 모음 (sqlite3 기반 - 동기 래퍼)

import sqlite3pkg from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const sqlite3 = sqlite3pkg.verbose();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'harness.db');

let _db = null;

// sqlite3는 비동기 기반이므로 동기처럼 쓸 수 있는 래퍼 제공
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    _db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    _db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    _db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function dbExec(sql) {
  return new Promise((resolve, reject) => {
    _db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function initDb() {
  if (_db) return _db;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  _db = new sqlite3.Database(DB_PATH);

  await dbRun('PRAGMA journal_mode = WAL');
  await dbRun('PRAGMA foreign_keys = ON');

  // 기존 DB의 max_rounds 컬럼 DEFAULT가 3인 경우 대응:
  // SQLite는 ALTER COLUMN DEFAULT를 지원하지 않으므로
  // 잘못 저장된 기존 task의 max_rounds=3을 10으로 마이그레이션
  const tableInfo = await dbAll("PRAGMA table_info(tasks)");
  if (tableInfo.length > 0) {
    const maxRoundsCol = tableInfo.find(col => col.name === 'max_rounds');
    // DEFAULT가 '3'인 경우에만 마이그레이션 (최초 1회)
    if (maxRoundsCol && String(maxRoundsCol.dflt_value) === '3') {
      const staleCount = await dbAll("SELECT COUNT(*) AS cnt FROM tasks WHERE max_rounds = 3 AND status NOT IN ('done','failed')");
      const cnt = staleCount[0]?.cnt ?? 0;
      if (cnt > 0) {
        console.log(`[DB] max_rounds 마이그레이션: ${cnt}개 task의 max_rounds 3→10`);
        await dbRun("UPDATE tasks SET max_rounds = 10 WHERE max_rounds = 3 AND status NOT IN ('done','failed')");
      }
    }
    // commit_sha, deploy_status 컬럼 마이그레이션 (기존 DB 대응)
    const hasCommitSha = tableInfo.some(col => col.name === 'commit_sha');
    const hasDeployStatus = tableInfo.some(col => col.name === 'deploy_status');
    if (!hasCommitSha) {
      console.log('[DB] commit_sha 컬럼 추가');
      await dbRun("ALTER TABLE tasks ADD COLUMN commit_sha TEXT");
    }
    if (!hasDeployStatus) {
      console.log('[DB] deploy_status 컬럼 추가');
      await dbRun("ALTER TABLE tasks ADD COLUMN deploy_status TEXT");
    }
    const hasProvider = tableInfo.some(col => col.name === 'provider');
    if (!hasProvider) {
      console.log('[DB] provider 컬럼 추가 (claude|codex)');
      await dbRun("ALTER TABLE tasks ADD COLUMN provider TEXT DEFAULT 'claude'");
    }
    const hasScheduledResumeAt = tableInfo.some(col => col.name === 'scheduled_resume_at');
    if (!hasScheduledResumeAt) {
      console.log('[DB] scheduled_resume_at 컬럼 추가 (리미트 해제 예정 시각)');
      await dbRun("ALTER TABLE tasks ADD COLUMN scheduled_resume_at TEXT");
    }
  }

  // projects 테이블 마이그레이션 (hidden, updated_at, github, deploy 컬럼)
  const projectTableInfo = await dbAll("PRAGMA table_info(projects)");
  if (projectTableInfo.length > 0) {
    const hasHidden = projectTableInfo.some(col => col.name === 'hidden');
    const hasUpdatedAt = projectTableInfo.some(col => col.name === 'updated_at');
    const hasGithub = projectTableInfo.some(col => col.name === 'github');
    const hasDeploy = projectTableInfo.some(col => col.name === 'deploy');
    if (!hasHidden) {
      console.log('[DB] projects.hidden 컬럼 추가');
      await dbRun("ALTER TABLE projects ADD COLUMN hidden INTEGER DEFAULT 0");
    }
    if (!hasUpdatedAt) {
      console.log('[DB] projects.updated_at 컬럼 추가');
      await dbRun("ALTER TABLE projects ADD COLUMN updated_at TEXT");
    }
    if (!hasGithub) {
      console.log('[DB] projects.github 컬럼 추가');
      await dbRun("ALTER TABLE projects ADD COLUMN github TEXT");
    }
    if (!hasDeploy) {
      console.log('[DB] projects.deploy 컬럼 추가');
      await dbRun("ALTER TABLE projects ADD COLUMN deploy TEXT");
    }
  }

  // limit_events 테이블 마이그레이션
  const limitEventsInfo = await dbAll("PRAGMA table_info(limit_events)");
  if (limitEventsInfo.length === 0) {
    console.log('[DB] limit_events 테이블 생성');
  }

  await dbExec(`
    CREATE TABLE IF NOT EXISTS limit_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id             TEXT,
      project_id          TEXT,
      detected_at         TEXT DEFAULT (datetime('now')),
      resume_available_at TEXT,
      checkpoint_path     TEXT,
      checkpoint_summary  TEXT,
      notified            INTEGER DEFAULT 0,
      resumed_at          TEXT,
      created_at          TEXT DEFAULT (datetime('now'))
    );
  `);

  await dbExec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      stack       TEXT,
      description TEXT,
      github      TEXT,
      deploy      TEXT,
      active      INTEGER DEFAULT 1,
      hidden      INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id),
      prompt        TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      plan          TEXT,
      eval_result   TEXT,
      round         INTEGER DEFAULT 0,
      max_rounds    INTEGER DEFAULT 10,
      error         TEXT,
      commit_sha           TEXT,
      deploy_status        TEXT,
      provider             TEXT DEFAULT 'claude',
      scheduled_resume_at  TEXT,
      created_at           TEXT DEFAULT (datetime('now')),
      updated_at           TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      phase       TEXT NOT NULL,
      round       INTEGER DEFAULT 0,
      level       TEXT DEFAULT 'info',
      content     TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TRIGGER IF NOT EXISTS tasks_updated_at
    AFTER UPDATE ON tasks
    BEGIN
      UPDATE tasks SET updated_at = datetime('now') WHERE id = NEW.id;
    END;
  `);

  return _db;
}

export function getDb() {
  if (!_db) throw new Error('DB 미초기화. initDb()를 먼저 호출하세요.');
  return _db;
}

// ── projects ──────────────────────────────────────────────────
export const projectQueries = {
  async seed(projects) {
    for (const p of projects) {
      await dbRun(`
        INSERT INTO projects (id, name, path, stack, description)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          path = excluded.path,
          stack = excluded.stack,
          description = excluded.description
      `, [p.id, p.name, p.path, p.stack, p.description]);
    }
  },

  async list({ includeHidden = false } = {}) {
    const hiddenFilter = includeHidden ? '' : 'AND (p.hidden IS NULL OR p.hidden = 0)';
    return dbAll(`
      SELECT p.*,
        (SELECT status FROM tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_status,
        (SELECT created_at FROM tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_at
      FROM projects p WHERE p.active = 1 ${hiddenFilter}
      ORDER BY p.created_at DESC
    `);
  },

  async listHidden() {
    return dbAll(`
      SELECT p.*,
        (SELECT status FROM tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_status,
        (SELECT created_at FROM tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_at
      FROM projects p WHERE p.active = 1 AND p.hidden = 1
      ORDER BY p.updated_at DESC
    `);
  },

  async get(id) {
    return dbGet('SELECT * FROM projects WHERE id = ?', [id]);
  },

  async insert({ id, name, path, stack, description, github, deploy }) {
    await dbRun(
      'INSERT INTO projects (id, name, path, stack, description, github, deploy) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, path, stack || null, description || null, github || null, deploy || null]
    );
    return dbGet('SELECT * FROM projects WHERE id = ?', [id]);
  },

  async update(id, { name, path, stack, description, github, deploy }) {
    const fields = [];
    const values = [];
    if (name       !== undefined) { fields.push('name = ?');        values.push(name); }
    if (path       !== undefined) { fields.push('path = ?');        values.push(path); }
    if (stack      !== undefined) { fields.push('stack = ?');       values.push(stack || null); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description || null); }
    if (github     !== undefined) { fields.push('github = ?');      values.push(github || null); }
    if (deploy     !== undefined) { fields.push('deploy = ?');      values.push(deploy || null); }
    if (fields.length === 0) return dbGet('SELECT * FROM projects WHERE id = ?', [id]);
    fields.push("updated_at = datetime('now')");
    values.push(id);
    await dbRun(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, values);
    return dbGet('SELECT * FROM projects WHERE id = ?', [id]);
  },

  async setVisibility(id, hidden) {
    await dbRun(
      "UPDATE projects SET hidden = ?, updated_at = datetime('now') WHERE id = ?",
      [hidden ? 1 : 0, id]
    );
    return dbGet('SELECT * FROM projects WHERE id = ?', [id]);
  },

  async remove(id) {
    await dbRun('DELETE FROM projects WHERE id = ?', [id]);
  },

  async countTasks(id) {
    const row = await dbGet('SELECT COUNT(*) AS cnt FROM tasks WHERE project_id = ?', [id]);
    return row ? row.cnt : 0;
  },

  // logs → tasks → project 순서로 삭제 (FK 제약 준수)
  async removeWithTasks(id) {
    const tasks = await dbAll('SELECT id FROM tasks WHERE project_id = ?', [id]);
    for (const t of tasks) {
      await dbRun('DELETE FROM logs WHERE task_id = ?', [t.id]);
    }
    await dbRun('DELETE FROM tasks WHERE project_id = ?', [id]);
    await dbRun('DELETE FROM projects WHERE id = ?', [id]);
  },
};

// ── tasks ─────────────────────────────────────────────────────
export const taskQueries = {
  async create({ id, project_id, prompt, max_rounds = 10 }) {
    await dbRun(
      'INSERT INTO tasks (id, project_id, prompt, max_rounds) VALUES (?, ?, ?, ?)',
      [id, project_id, prompt, max_rounds]
    );
  },

  async get(id) {
    return dbGet('SELECT * FROM tasks WHERE id = ?', [id]);
  },

  async list(limit = 20) {
    return dbAll(`
      SELECT t.*, p.name AS project_name
      FROM tasks t JOIN projects p ON t.project_id = p.id
      ORDER BY t.created_at DESC LIMIT ?
    `, [limit]);
  },

  async updateStatus(id, status, extra = {}) {
    const keys = Object.keys(extra);
    if (keys.length === 0) {
      await dbRun('UPDATE tasks SET status = ? WHERE id = ?', [status, id]);
    } else {
      const fields = keys.map(k => `${k} = ?`).join(', ');
      const values = keys.map(k => extra[k]);
      await dbRun(
        `UPDATE tasks SET status = ?, ${fields} WHERE id = ?`,
        [status, ...values, id]
      );
    }
  },

  async incrementRound(id) {
    await dbRun('UPDATE tasks SET round = round + 1 WHERE id = ?', [id]);
  },

  async updateCommit(id, commitSha) {
    await dbRun('UPDATE tasks SET commit_sha = ? WHERE id = ?', [commitSha, id]);
  },

  async updateDeploy(id, deployStatus) {
    await dbRun('UPDATE tasks SET deploy_status = ? WHERE id = ?', [deployStatus, id]);
  },

  async updateProvider(id, provider) {
    await dbRun("UPDATE tasks SET provider = ? WHERE id = ?", [provider, id]);
  },

  async updateScheduledResumeAt(id, scheduledResumeAt) {
    await dbRun("UPDATE tasks SET scheduled_resume_at = ? WHERE id = ?", [scheduledResumeAt, id]);
  },

  // 특정 프로젝트에 현재 활성 중인 task가 있는지 확인
  async getActiveForProject(projectId) {
    return dbGet(
      "SELECT id, status FROM tasks WHERE project_id = ? AND status NOT IN ('done','failed','paused','rate_limited') ORDER BY created_at DESC LIMIT 1",
      [projectId]
    );
  },

  // 재개 예정 시각이 지난 rate_limited 작업 목록 조회
  async getPendingRateLimitedTasks() {
    return dbAll(
      "SELECT * FROM tasks WHERE status = 'rate_limited' AND scheduled_resume_at IS NOT NULL AND scheduled_resume_at <= datetime('now') ORDER BY scheduled_resume_at ASC"
    );
  },

  // rate_limited 상태의 모든 작업 조회 (대시보드 표시용)
  async getRateLimitedTasks() {
    return dbAll(
      "SELECT * FROM tasks WHERE status = 'rate_limited' ORDER BY created_at DESC"
    );
  },
};

// ── logs ──────────────────────────────────────────────────────
export const logQueries = {
  async append({ task_id, phase, round = 0, level = 'info', content }) {
    await dbRun(
      'INSERT INTO logs (task_id, phase, round, level, content) VALUES (?, ?, ?, ?, ?)',
      [task_id, phase, round, level, content]
    );
  },

  async forTask(task_id, limit = 200) {
    return dbAll(
      'SELECT * FROM logs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?',
      [task_id, limit]
    );
  },

  async deleteForTask(task_id) {
    await dbRun('DELETE FROM logs WHERE task_id = ?', [task_id]);
  },
};

// ── limit_events ───────────────────────────────────────────────
export const limitEventQueries = {
  async insert({ task_id, project_id, resume_available_at, checkpoint_path, checkpoint_summary }) {
    const res = await dbRun(
      `INSERT INTO limit_events (task_id, project_id, resume_available_at, checkpoint_path, checkpoint_summary)
       VALUES (?, ?, ?, ?, ?)`,
      [task_id || null, project_id || null, resume_available_at || null, checkpoint_path || null, checkpoint_summary || null]
    );
    return dbGet('SELECT * FROM limit_events WHERE id = ?', [res.lastID]);
  },

  async list(limit = 20) {
    return dbAll(
      'SELECT * FROM limit_events ORDER BY created_at DESC LIMIT ?',
      [limit]
    );
  },

  async getLatestActive() {
    // resumed_at이 없는 (아직 재개되지 않은) 가장 최근 이벤트
    return dbGet(
      "SELECT * FROM limit_events WHERE resumed_at IS NULL ORDER BY created_at DESC LIMIT 1"
    );
  },

  async markNotified(id) {
    await dbRun('UPDATE limit_events SET notified = 1 WHERE id = ?', [id]);
  },

  async markResumed(id) {
    await dbRun("UPDATE limit_events SET resumed_at = datetime('now') WHERE id = ?", [id]);
  },

  // resume_available_at이 지났고 아직 알림 미발송된 이벤트 조회
  async getPendingNotifications() {
    return dbAll(
      "SELECT * FROM limit_events WHERE notified = 0 AND resumed_at IS NULL AND resume_available_at IS NOT NULL AND resume_available_at <= datetime('now') ORDER BY created_at ASC"
    );
  },
};

// ── 작업 삭제 (logs → tasks 순서로 삭제하여 FK 제약 준수) ──────
export async function deleteTask(task_id) {
  await logQueries.deleteForTask(task_id);
  await dbRun('DELETE FROM tasks WHERE id = ?', [task_id]);
}
