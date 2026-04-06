// src/db/db.js
// SQLite 스키마 정의 및 쿼리 모음

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'harness.db');

let _db = null;

export function getDb() {
  if (_db) return _db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    -- 프로젝트 목록
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,   -- 예: palmoni, facepick
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,      -- 로컬 절대 경로
      stack       TEXT,               -- react-vite, nextjs, nodejs ...
      description TEXT,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- 파이프라인 작업 (Planner → Generator → Evaluator)
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id),
      prompt      TEXT NOT NULL,      -- 사용자 최초 지시
      status      TEXT DEFAULT 'pending',
      -- pending | planning | building | evaluating | done | failed | paused
      plan        TEXT,               -- Planner 결과 (JSON)
      eval_result TEXT,               -- 최근 Evaluator 결과 (JSON)
      round       INTEGER DEFAULT 0,  -- 현재 피드백 라운드
      max_rounds  INTEGER DEFAULT 3,
      error       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    -- 각 단계별 실행 로그
    CREATE TABLE IF NOT EXISTS logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      phase       TEXT NOT NULL,      -- plan | build | eval
      round       INTEGER DEFAULT 0,
      level       TEXT DEFAULT 'info',-- info | tool | error | result
      content     TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- 트리거: tasks.updated_at 자동 갱신
    CREATE TRIGGER IF NOT EXISTS tasks_updated_at
    AFTER UPDATE ON tasks
    BEGIN
      UPDATE tasks SET updated_at = datetime('now') WHERE id = NEW.id;
    END;
  `);

  return _db;
}

// ── projects ──────────────────────────────────────────────────
export const projectQueries = {
  seed(projects) {
    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO projects (id, name, path, stack, description)
      VALUES (@id, @name, @path, @stack, @description)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        stack = excluded.stack,
        description = excluded.description
    `);
    const seedAll = db.transaction((list) => list.forEach(p => upsert.run(p)));
    seedAll(projects);
  },

  list() {
    return getDb().prepare(`
      SELECT p.*,
        (SELECT status FROM tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_status,
        (SELECT created_at FROM tasks WHERE project_id = p.id
         ORDER BY created_at DESC LIMIT 1) AS last_task_at
      FROM projects p WHERE p.active = 1
    `).all();
  },

  get(id) {
    return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id);
  }
};

// ── tasks ─────────────────────────────────────────────────────
export const taskQueries = {
  create({ id, project_id, prompt, max_rounds = 3 }) {
    getDb().prepare(`
      INSERT INTO tasks (id, project_id, prompt, max_rounds)
      VALUES (@id, @project_id, @prompt, @max_rounds)
    `).run({ id, project_id, prompt, max_rounds });
  },

  get(id) {
    return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  },

  list(limit = 20) {
    return getDb().prepare(`
      SELECT t.*, p.name AS project_name
      FROM tasks t JOIN projects p ON t.project_id = p.id
      ORDER BY t.created_at DESC LIMIT ?
    `).all(limit);
  },

  updateStatus(id, status, extra = {}) {
    const fields = Object.keys(extra).map(k => `${k} = @${k}`).join(', ');
    const sql = fields
      ? `UPDATE tasks SET status = @status, ${fields} WHERE id = @id`
      : `UPDATE tasks SET status = @status WHERE id = @id`;
    getDb().prepare(sql).run({ id, status, ...extra });
  },

  incrementRound(id) {
    getDb().prepare('UPDATE tasks SET round = round + 1 WHERE id = ?').run(id);
  },

  getActive() {
    return getDb().prepare(`
      SELECT * FROM tasks
      WHERE status NOT IN ('done', 'failed')
      ORDER BY created_at DESC
    `).all();
  }
};

// ── logs ──────────────────────────────────────────────────────
export const logQueries = {
  append({ task_id, phase, round = 0, level = 'info', content }) {
    getDb().prepare(`
      INSERT INTO logs (task_id, phase, round, level, content)
      VALUES (@task_id, @phase, @round, @level, @content)
    `).run({ task_id, phase, round, level, content });
  },

  forTask(task_id, limit = 200) {
    return getDb().prepare(`
      SELECT * FROM logs WHERE task_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(task_id, limit);
  }
};
