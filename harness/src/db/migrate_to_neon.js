#!/usr/bin/env node
// src/db/migrate_to_neon.js
// SQLite → Neon DB (PostgreSQL) 마이그레이션 스크립트
// harness 전용 스키마(harness)를 사용하여 public 스키마와 분리
//
// 사용법:
//   node src/db/migrate_to_neon.js               # 마이그레이션 실행 (스키마 생성 + 데이터 이전)
//   node src/db/migrate_to_neon.js --schema-only  # 스키마만 생성 (데이터 이전 없음)
//   node src/db/migrate_to_neon.js --verify       # 이전 후 데이터 수 검증

import { neon } from '@neondatabase/serverless';
import sqlite3pkg from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const sqlite3 = sqlite3pkg.verbose();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_PATH = path.join(__dirname, '../../data/harness.db');

const args = process.argv.slice(2);
const SCHEMA_ONLY = args.includes('--schema-only');
const VERIFY = args.includes('--verify');

// ── Neon DB 연결 ──────────────────────────────────────────────
const dbUrl = process.env.NEON_DATABASE_URL;
if (!dbUrl) {
  console.error('❌ NEON_DATABASE_URL 환경변수가 없습니다. harness/.env를 확인하세요.');
  process.exit(1);
}
const sql = neon(dbUrl);

// ── SQLite 헬퍼 ───────────────────────────────────────────────
function openSqlite() {
  if (!fs.existsSync(SQLITE_PATH)) return null;
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(SQLITE_PATH, sqlite3.OPEN_READONLY, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function sqliteAll(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function closeSqlite(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ── PostgreSQL harness 스키마 생성 ────────────────────────────
async function createSchema() {
  console.log('\n📋 Neon DB harness 스키마 생성 중...');

  await sql`CREATE SCHEMA IF NOT EXISTS harness`;
  console.log('  ✓ harness 스키마');

  await sql`
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
  `;
  console.log('  ✓ harness.projects 테이블');

  await sql`
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
      scheduled_resume_at  TEXT,
      created_at           TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
      updated_at           TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    )
  `;
  console.log('  ✓ harness.tasks 테이블');

  await sql`
    CREATE TABLE IF NOT EXISTS harness.logs (
      id         SERIAL PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES harness.tasks(id),
      phase      TEXT NOT NULL,
      round      INTEGER DEFAULT 0,
      level      TEXT DEFAULT 'info',
      content    TEXT NOT NULL,
      created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    )
  `;
  console.log('  ✓ harness.logs 테이블');

  await sql`
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
  `;
  console.log('  ✓ harness.limit_events 테이블');

  await sql`
    CREATE OR REPLACE FUNCTION harness.update_tasks_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `;

  await sql`
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
  `;
  console.log('  ✓ harness_tasks_updated_at 트리거');

  console.log('✅ 스키마 생성 완료\n');
}

// ── 데이터 이전 ───────────────────────────────────────────────
async function migrateData(sqliteDb) {
  console.log('📦 SQLite → Neon DB (harness 스키마) 데이터 이전 중...\n');

  // 멱등성 보장: logs, limit_events 초기화 후 재삽입
  await sql.query('TRUNCATE harness.limit_events RESTART IDENTITY');
  await sql.query('TRUNCATE harness.logs RESTART IDENTITY');
  console.log('  ✓ logs, limit_events 초기화 완료 (멱등 재삽입 준비)\n');

  // 1. projects
  const projects = await sqliteAll(sqliteDb, 'SELECT * FROM projects');
  console.log(`  projects: ${projects.length}건`);
  for (const p of projects) {
    await sql.query(
      `INSERT INTO harness.projects (id, name, path, stack, description, github, deploy, active, hidden, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT(id) DO UPDATE SET
         name = EXCLUDED.name,
         path = EXCLUDED.path,
         stack = EXCLUDED.stack,
         description = EXCLUDED.description,
         github = EXCLUDED.github,
         deploy = EXCLUDED.deploy,
         active = EXCLUDED.active,
         hidden = EXCLUDED.hidden,
         updated_at = EXCLUDED.updated_at`,
      [p.id, p.name, p.path, p.stack || null, p.description || null,
       p.github || null, p.deploy || null, p.active ?? 1, p.hidden ?? 0,
       p.created_at || null, p.updated_at || null]
    );
  }
  console.log(`  ✓ projects ${projects.length}건 이전 완료`);

  // 2. tasks
  const tasks = await sqliteAll(sqliteDb, 'SELECT * FROM tasks');
  console.log(`  tasks: ${tasks.length}건`);
  for (const t of tasks) {
    await sql.query(
      `INSERT INTO harness.tasks (id, project_id, prompt, status, plan, eval_result, round, max_rounds,
         error, commit_sha, deploy_status, provider, scheduled_resume_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT(id) DO UPDATE SET
         status = EXCLUDED.status,
         round = EXCLUDED.round,
         error = EXCLUDED.error,
         updated_at = EXCLUDED.updated_at`,
      [t.id, t.project_id, t.prompt, t.status || 'pending',
       t.plan || null, t.eval_result || null, t.round || 0, t.max_rounds || 10,
       t.error || null, t.commit_sha || null, t.deploy_status || null,
       t.provider || 'claude', t.scheduled_resume_at || null,
       t.created_at || null, t.updated_at || null]
    );
  }
  console.log(`  ✓ tasks ${tasks.length}건 이전 완료`);

  // 3. logs (배치 삽입 - 100건씩)
  const logs = await sqliteAll(sqliteDb, 'SELECT * FROM logs');
  console.log(`  logs: ${logs.length}건 (배치 삽입 중...)`);
  const BATCH_SIZE = 100;
  let logCount = 0;
  for (let i = 0; i < logs.length; i += BATCH_SIZE) {
    const batch = logs.slice(i, i + BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((l, j) => {
      const base = j * 6;
      values.push(l.task_id, l.phase, l.round || 0, l.level || 'info', l.content, l.created_at || null);
      return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6})`;
    });
    await sql.query(
      `INSERT INTO harness.logs (task_id, phase, round, level, content, created_at) VALUES ${placeholders.join(', ')}`,
      values
    );
    logCount += batch.length;
    if (logCount % 1000 === 0 || logCount === logs.length) {
      process.stdout.write(`\r  진행: ${logCount}/${logs.length}건`);
    }
  }
  console.log(`\n  ✓ logs ${logCount}건 이전 완료`);

  // 4. limit_events
  const limitEvents = await sqliteAll(sqliteDb, 'SELECT * FROM limit_events');
  console.log(`  limit_events: ${limitEvents.length}건`);
  for (const e of limitEvents) {
    await sql.query(
      `INSERT INTO harness.limit_events (task_id, project_id, detected_at, resume_available_at,
         checkpoint_path, checkpoint_summary, notified, resumed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.task_id || null, e.project_id || null, e.detected_at || null,
       e.resume_available_at || null, e.checkpoint_path || null,
       e.checkpoint_summary || null, e.notified || 0, e.resumed_at || null,
       e.created_at || null]
    );
  }
  console.log(`  ✓ limit_events ${limitEvents.length}건 이전 완료`);

  console.log('\n✅ 데이터 이전 완료\n');
}

// ── 검증 ──────────────────────────────────────────────────────
async function verify(sqliteDb) {
  console.log('🔍 데이터 검증 중...\n');

  const tables = ['projects', 'tasks', 'logs', 'limit_events'];
  for (const table of tables) {
    let sqliteCount = 0;
    if (sqliteDb) {
      const rows = await sqliteAll(sqliteDb, `SELECT COUNT(*) AS cnt FROM ${table}`);
      sqliteCount = rows[0]?.cnt ?? 0;
    }
    const neonRows = await sql.query(`SELECT COUNT(*) AS cnt FROM harness.${table}`);
    const neonCount = Number(neonRows[0]?.cnt ?? 0);
    const match = sqliteDb ? (sqliteCount === neonCount ? '✓' : '⚠') : '✓';
    console.log(`  ${match} ${table}: SQLite ${sqliteCount}건 → Neon ${neonCount}건`);
  }
  console.log('\n✅ 검증 완료\n');
}

// ── 메인 ──────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Neon DB 마이그레이션 시작');
  console.log(`   SQLite 경로: ${SQLITE_PATH}`);
  const host = dbUrl.split('@')[1]?.split('/')[0] ?? '(host)';
  console.log(`   Neon DB: ${host} (harness 스키마)\n`);

  await createSchema();

  if (SCHEMA_ONLY) {
    console.log('ℹ️  --schema-only 모드: 데이터 이전 건너뜀');
    if (VERIFY) await verify(null);
    return;
  }

  if (!fs.existsSync(SQLITE_PATH)) {
    console.log('ℹ️  SQLite DB 파일이 없습니다. 스키마만 생성됩니다.');
    if (VERIFY) await verify(null);
    return;
  }

  const sqliteDb = await openSqlite();
  try {
    await migrateData(sqliteDb);
    if (VERIFY) await verify(sqliteDb);
  } finally {
    await closeSqlite(sqliteDb);
  }

  console.log('🎉 Neon DB 마이그레이션 성공!');
  console.log('   harness가 이제 Neon DB (harness 스키마)를 사용합니다.');
}

main().catch((err) => {
  console.error('❌ 마이그레이션 실패:', err.message || err);
  process.exit(1);
});
