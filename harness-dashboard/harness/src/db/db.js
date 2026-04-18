// src/db/db.js
// SQLite 데이터베이스 (sqlite + sqlite3 async)

import sqlite3pkg from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const sqlite3 = sqlite3pkg.verbose();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// harness-dashboard/harness/data/harness.db
const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_PATH  = path.join(DATA_DIR, 'harness.db');

let _db = null;

export async function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  _db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await _db.exec(`PRAGMA journal_mode = WAL;`);
  await _db.exec(`PRAGMA foreign_keys = ON;`);

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      stack       TEXT,
      description TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id),
      prompt       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      phase        TEXT,
      round        INTEGER NOT NULL DEFAULT 0,
      max_rounds   INTEGER NOT NULL DEFAULT 3,
      plan         TEXT,
      eval_result  TEXT,
      commit_sha   TEXT,
      deploy_status TEXT,
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      phase      TEXT,
      round      INTEGER,
      level      TEXT NOT NULL DEFAULT 'info',
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_logs_task_id  ON logs(task_id);
  `);

  console.log(`[DB] 초기화 완료: ${DB_PATH}`);
  return _db;
}

export function getDb() {
  if (!_db) throw new Error('DB 미초기화. initDb()를 먼저 호출하세요.');
  return _db;
}

// ── 프로젝트 쿼리 ──────────────────────────────────────────
export const projectQueries = {
  async seed(projects) {
    const db = getDb();
    for (const p of projects) {
      await db.run(`
        INSERT INTO projects (id, name, path, stack, description)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name        = excluded.name,
          path        = excluded.path,
          stack       = excluded.stack,
          description = excluded.description
      `, [p.id, p.name, p.path, p.stack || null, p.description || null]);
    }
  },

  async list() {
    const db = getDb();
    const projects = await db.all(`SELECT * FROM projects ORDER BY created_at ASC`);
    for (const p of projects) {
      p.latestTask = await db.get(
        `SELECT id, status, phase, round, prompt, created_at, updated_at
         FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
        [p.id]
      ) || null;
    }
    return projects;
  },

  async get(id) {
    const db = getDb();
    const project = await db.get(`SELECT * FROM projects WHERE id = ?`, [id]);
    if (!project) return null;
    project.tasks = await db.all(
      `SELECT id, status, phase, round, prompt, created_at, updated_at
       FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 10`,
      [id]
    );
    return project;
  },

  async insert({ id, name, path: projectPath, stack, description }) {
    const db = getDb();
    await db.run(`
      INSERT INTO projects (id, name, path, stack, description)
      VALUES (?, ?, ?, ?, ?)
    `, [id, name, projectPath, stack || null, description || null]);
    return db.get(`SELECT * FROM projects WHERE id = ?`, [id]);
  },
};

// ── 작업 쿼리 ──────────────────────────────────────────────
export const taskQueries = {
  async create({ id, project_id, prompt, max_rounds = 3 }) {
    const db = getDb();
    await db.run(`
      INSERT INTO tasks (id, project_id, prompt, status, max_rounds)
      VALUES (?, ?, ?, 'pending', ?)
    `, [id, project_id, prompt, max_rounds]);
    return db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
  },

  async get(id) {
    return getDb().get(`SELECT * FROM tasks WHERE id = ?`, [id]);
  },

  async list(limit = 20) {
    return getDb().all(`
      SELECT t.*, p.name as project_name
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      ORDER BY t.created_at DESC LIMIT ?
    `, [limit]);
  },

  async getActiveForProject(projectId) {
    return getDb().get(`
      SELECT * FROM tasks
      WHERE project_id = ?
        AND status NOT IN ('done', 'failed', 'paused')
      ORDER BY created_at DESC LIMIT 1
    `, [projectId]);
  },

  async updateStatus(id, status, extra = {}) {
    const db = getDb();
    const { error, plan, eval_result } = extra;
    await db.run(`
      UPDATE tasks SET
        status      = ?,
        error       = COALESCE(?, error),
        plan        = COALESCE(?, plan),
        eval_result = COALESCE(?, eval_result),
        updated_at  = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `, [status, error ?? null, plan ?? null, eval_result ?? null, id]);
  },

  async incrementRound(id) {
    await getDb().run(`
      UPDATE tasks SET round = round + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `, [id]);
  },

  async updateCommit(id, commitSha) {
    await getDb().run(`
      UPDATE tasks SET commit_sha = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `, [commitSha, id]);
  },

  async updateDeploy(id, deployStatus) {
    await getDb().run(`
      UPDATE tasks SET deploy_status = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `, [deployStatus, id]);
  },

  async listPaused() {
    return getDb().all(
      `SELECT * FROM tasks WHERE status = 'paused' ORDER BY updated_at DESC`
    );
  },
};

// ── 로그 쿼리 ──────────────────────────────────────────────
export const logQueries = {
  async append({ task_id, phase, round, level = 'info', content }) {
    await getDb().run(`
      INSERT INTO logs (task_id, phase, round, level, content)
      VALUES (?, ?, ?, ?, ?)
    `, [task_id, phase || null, round ?? null, level, content]);
  },

  async forTask(taskId, limit = 200) {
    return getDb().all(
      `SELECT * FROM logs WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
      [taskId, limit]
    );
  },
};

// ── 단독 함수: task 완전 삭제 ──────────────────────────────
export async function deleteTask(id) {
  const db = getDb();
  await db.run(`DELETE FROM logs  WHERE task_id = ?`, [id]);
  await db.run(`DELETE FROM tasks WHERE id = ?`,      [id]);
}
