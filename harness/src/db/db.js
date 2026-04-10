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
    if (maxRoundsCol && String(maxRoundsCol.dflt_value) === '3') {
      console.log('[DB] max_rounds DEFAULT 마이그레이션: 3→10 (기존 task 중 max_rounds=3인 것 수정)');
      await dbRun("UPDATE tasks SET max_rounds = 10 WHERE max_rounds = 3 AND status NOT IN ('done','failed')");
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
  }

  await dbExec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      stack       TEXT,
      description TEXT,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
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
      commit_sha    TEXT,
      deploy_status TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
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

  async list() {
    return dbAll(`
      SELECT p.*,
        (SELECT status FROM tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_status,
        (SELECT created_at FROM tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_at
      FROM projects p WHERE p.active = 1
    `);
  },

  async get(id) {
    return dbGet('SELECT * FROM projects WHERE id = ?', [id]);
  },

  async insert({ id, name, path, stack, description }) {
    await dbRun(
      'INSERT INTO projects (id, name, path, stack, description) VALUES (?, ?, ?, ?, ?)',
      [id, name, path, stack || null, description || null]
    );
    return dbGet('SELECT * FROM projects WHERE id = ?', [id]);
  }
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
  }
};
