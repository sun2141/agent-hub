#!/usr/bin/env node
// Harness Neon DB healthcheck for local and VPS operations.

import { neon } from '@neondatabase/serverless';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const REQUIRED_TABLES = ['projects', 'tasks', 'logs', 'limit_events'];
const REQUIRED_INDEXES = [
  'idx_harness_projects_active_hidden_created_at',
  'idx_harness_tasks_project_created_at',
  'idx_harness_tasks_status_resume',
  'idx_harness_tasks_status_created_at',
  'idx_harness_logs_task_created_at',
  'idx_harness_limit_events_notification',
  'idx_harness_limit_events_task_created_at',
];
const ACTIVE_STATUSES = ['pending', 'planning', 'building', 'evaluating', 'fallback_running'];
const STALE_ACTIVE_HOURS = Number(process.env.DB_HEALTH_STALE_ACTIVE_HOURS || 6);

function fail(message, details = []) {
  console.error(`FAIL ${message}`);
  for (const detail of details) console.error(`  - ${detail}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`WARN ${message}`);
}

function ok(message) {
  console.log(`OK ${message}`);
}

const dbUrl = process.env.NEON_DATABASE_URL;
if (!dbUrl?.trim()) fail('NEON_DATABASE_URL is missing');
if (!dbUrl.includes('-pooler.')) {
  warn('NEON_DATABASE_URL does not use a pooled Neon host; serverless/VPS bursts can exhaust connections');
}

const sql = neon(dbUrl);

const ping = await sql`SELECT current_database() AS db, current_user AS usr`;
ok(`connected to ${ping[0].db} as ${ping[0].usr}`);

const tables = await sql`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'harness'
`;
const tableSet = new Set(tables.map((row) => row.table_name));
const missingTables = REQUIRED_TABLES.filter((name) => !tableSet.has(name));
if (missingTables.length > 0) fail('missing harness tables', missingTables);
ok(`required tables present (${REQUIRED_TABLES.join(', ')})`);

const indexes = await sql`
  SELECT indexname
  FROM pg_indexes
  WHERE schemaname = 'harness'
`;
const indexSet = new Set(indexes.map((row) => row.indexname));
const missingIndexes = REQUIRED_INDEXES.filter((name) => !indexSet.has(name));
if (missingIndexes.length > 0) fail('missing operational indexes', missingIndexes);
ok('operational indexes present');

const countRows = await sql.query(`
  SELECT 'projects' AS name, COUNT(*)::int AS count FROM harness.projects
  UNION ALL SELECT 'tasks', COUNT(*)::int FROM harness.tasks
  UNION ALL SELECT 'logs', COUNT(*)::int FROM harness.logs
  UNION ALL SELECT 'limit_events', COUNT(*)::int FROM harness.limit_events
  ORDER BY name
`);
for (const row of countRows) ok(`${row.name}: ${row.count}`);

const projectRows = await sql`
  SELECT id, path
  FROM harness.projects
  WHERE active = 1
  ORDER BY id
`;
const missingPaths = projectRows
  .filter((project) => !fs.existsSync(project.path))
  .map((project) => `${project.id}: ${project.path}`);
if (missingPaths.length > 0) fail('active project paths missing', missingPaths);
ok(`active project paths exist (${projectRows.length})`);

const cutoff = new Date(Date.now() - STALE_ACTIVE_HOURS * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 19)
  .replace('T', ' ');
const staleTasks = await sql.query(
  `
    SELECT id, project_id, status, created_at, updated_at
    FROM harness.tasks
    WHERE status = ANY($1)
      AND created_at < $2
    ORDER BY created_at ASC
  `,
  [ACTIVE_STATUSES, cutoff]
);
if (staleTasks.length > 0) {
  fail(
    `stale active tasks older than ${STALE_ACTIVE_HOURS}h`,
    staleTasks.map((task) => `${task.id} ${task.project_id} ${task.status} ${task.created_at}`)
  );
}
ok(`no stale active tasks older than ${STALE_ACTIVE_HOURS}h`);

const orphanLogs = await sql`
  SELECT COUNT(*)::int AS count
  FROM harness.logs l
  LEFT JOIN harness.tasks t ON t.id = l.task_id
  WHERE t.id IS NULL
`;
if (orphanLogs[0].count > 0) fail('orphan logs found', [`${orphanLogs[0].count} log rows without tasks`]);
ok('no orphan logs');

console.log('HEALTHCHECK PASS');
