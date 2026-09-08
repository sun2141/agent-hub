// src/api/readRoutes.js
// 읽기 전용 토큰 라우트 (GET only)
//
// 왜 있는가:
//   기존 /api/* 는 x-api-key "헤더"로만 인증한다. 그런데 원격 에이전트/자동화
//   클라이언트 중에는 커스텀 헤더를 붙이지 못하는 것이 있다(URL만 가져올 수 있음).
//   그런 클라이언트도 하네스 상태·리포트·워킹트리를 읽을 수 있도록,
//   토큰을 URL 경로에 담는 별도의 "읽기 전용" 표면을 둔다.
//
// 원칙:
//   · GET 만. 어떤 상태도 변경하지 않는다.
//   · API_KEY 와 분리된 READ_API_KEY 를 쓴다. 유출 시 이것만 갈아끼우면 된다.
//   · READ_API_KEY 미설정이면 라우트 전체가 503 으로 닫힌다(기본 비활성).
//   · 비밀 파일(.env, 키, node_modules, .git 내부)은 경로 검사로 차단한다.

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { projectQueries, taskQueries, logQueries } from '../db/db.js';

const READ_API_KEY = process.env.READ_API_KEY || '';
const MIN_TOKEN_LEN = 24;

const MAX_FILE_BYTES = 512 * 1024;   // 파일 본문 상한
const MAX_LS_ENTRIES = 500;
const GIT_TIMEOUT_MS = 15_000;

const TASK_ID_RE    = /^task_[0-9]+_[a-z0-9]+$/;
const PROJECT_ID_RE = /^[a-z0-9-]{1,50}$/;

// 경로 어디에든 들어가면 거부되는 세그먼트
const DENY_SEGMENTS = new Set(['node_modules', '.git', '.secrets', '.ssh', 'venv', '.venv']);
// 파일명 기준 거부 패턴
const DENY_FILE_RE = /(^\.env)|(\.pem$)|(\.key$)|(^id_rsa)|(\.p12$)|(\.pfx$)|(credentials?\.json$)|(^\.npmrc$)|(^\.session_secret$)/i;

function tokenOk(candidate) {
  if (!READ_API_KEY || READ_API_KEY.length < MIN_TOKEN_LEN) return false;
  if (typeof candidate !== 'string' || candidate.length !== READ_API_KEY.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(READ_API_KEY));
  } catch {
    return false;
  }
}

// 토큰 검사 + 캐시/색인 차단
function readAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!READ_API_KEY) {
    return res.status(503).json({ error: 'READ_API_KEY not configured' });
  }
  if (READ_API_KEY.length < MIN_TOKEN_LEN) {
    return res.status(503).json({ error: `READ_API_KEY too short (min ${MIN_TOKEN_LEN})` });
  }
  if (!tokenOk(req.params.token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// rel 을 root 안쪽 실제 경로로 해석. 벗어나거나 금지 대상이면 null.
function safeResolve(root, rel) {
  const rootReal = fs.realpathSync(root);
  const target = path.resolve(rootReal, rel || '.');
  const relFromRoot = path.relative(rootReal, target);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;

  const segments = relFromRoot.split(path.sep).filter(Boolean);
  for (const seg of segments) {
    if (DENY_SEGMENTS.has(seg)) return null;
  }
  if (segments.length && DENY_FILE_RE.test(segments[segments.length - 1])) return null;

  // 심볼릭 링크로 루트 밖을 가리키는 경우 차단
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch {
    return null; // 존재하지 않음
  }
  const relReal = path.relative(rootReal, real);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) return null;
  return real;
}

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: 'pipe' });
  if (res.error) return { ok: false, out: res.error.message };
  if (res.status !== 0) return { ok: false, out: (res.stderr || res.stdout || '').trim() };
  return { ok: true, out: (res.stdout || '').trim() };
}

async function resolveProjectRoot(projectId) {
  const project = await projectQueries.get(projectId);
  if (!project || !project.path) return null;
  if (!fs.existsSync(project.path)) return null;
  return { project, root: project.path };
}

export function registerReadRoutes(app, agentRunner, agentHubRoot) {
  const router = express.Router({ mergeParams: true });
  const TASKS_DONE_DIR = path.join(agentHubRoot, 'tasks', 'done');

  // GET 이외는 전부 거부 (라우터 진입 단계에서)
  router.use((req, res, next) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
    next();
  });

  router.use(readAuth);

  // 사용 가능한 경로 안내
  router.get('/', (req, res) => {
    const base = `/r/:token`;
    res.json({
      ok: true,
      readonly: true,
      endpoints: [
        `${base}/status`,
        `${base}/tasks?limit=20`,
        `${base}/tasks/:taskId`,
        `${base}/tasks/:taskId/report`,
        `${base}/reports`,
        `${base}/projects`,
        `${base}/projects/:projectId/git`,
        `${base}/projects/:projectId/diff?staged=&path=`,
        `${base}/projects/:projectId/ls?path=`,
        `${base}/projects/:projectId/file?path=`,
      ],
    });
  });

  router.get('/status', (req, res) => {
    res.json({
      ok: true,
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      harness: agentRunner.getStatus(),
      ts: Date.now(),
    });
  });

  router.get('/tasks', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 100);
    try {
      res.json(await taskQueries.list(limit));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/tasks/:taskId', async (req, res) => {
    const { taskId } = req.params;
    if (!TASK_ID_RE.test(taskId)) return res.status(400).json({ error: '잘못된 task ID 형식' });
    const logLimit = Math.min(parseInt(req.query.logs || '200', 10) || 200, 2000);
    try {
      const task = await taskQueries.get(taskId);
      if (!task) return res.status(404).json({ error: '작업 없음' });
      const logs = await logQueries.forTask(taskId);
      const trimmed = Array.isArray(logs) ? logs.slice(-logLimit) : logs;
      res.json({ ...task, logCount: Array.isArray(logs) ? logs.length : null, logs: trimmed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 리포트 원문 (tasks/done/<taskId>_report.md)
  router.get('/tasks/:taskId/report', (req, res) => {
    const { taskId } = req.params;
    if (!TASK_ID_RE.test(taskId)) return res.status(400).json({ error: '잘못된 task ID 형식' });
    const file = path.join(TASKS_DONE_DIR, `${taskId}_report.md`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: '리포트 없음', path: file });
    try {
      const body = fs.readFileSync(file, 'utf8');
      res.type('text/plain; charset=utf-8').send(body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/reports', (req, res) => {
    if (!fs.existsSync(TASKS_DONE_DIR)) return res.json([]);
    try {
      const files = fs.readdirSync(TASKS_DONE_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const st = fs.statSync(path.join(TASKS_DONE_DIR, f));
          return { file: f, bytes: st.size, mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
        .slice(0, 100);
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/projects', async (req, res) => {
    try {
      const list = await projectQueries.list({ includeHidden: false });
      res.json(list.map(p => ({ id: p.id, name: p.name, path: p.path, stack: p.stack })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 워킹트리 상태 — 커밋 안 된 변경을 원격에서 확인하기 위한 핵심 엔드포인트
  router.get('/projects/:projectId/git', async (req, res) => {
    const { projectId } = req.params;
    if (!PROJECT_ID_RE.test(projectId)) return res.status(400).json({ error: '잘못된 프로젝트 ID' });
    try {
      const found = await resolveProjectRoot(projectId);
      if (!found) return res.status(404).json({ error: '프로젝트 없음 또는 경로 없음' });
      const cwd = found.root;
      const inRepo = git(['rev-parse', '--is-inside-work-tree'], cwd);
      if (!inRepo.ok) return res.status(400).json({ error: 'git 저장소 아님', detail: inRepo.out });
      res.json({
        projectId,
        path: cwd,
        branch:    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).out,
        status:    git(['status', '--porcelain=v1', '-uall'], cwd).out,
        diffStat:  git(['diff', '--stat'], cwd).out,
        stagedStat: git(['diff', '--cached', '--stat'], cwd).out,
        branches:  git(['branch', '--list', '--format=%(refname:short)'], cwd).out,
        recentCommits: git(['log', '-10', '--pretty=%h %ad %s', '--date=short'], cwd).out,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 커밋되지 않은 변경의 실제 diff. status/diffStat만으로는 살릴지 버릴지 판단이 안 된다.
  router.get('/projects/:projectId/diff', async (req, res) => {
    const { projectId } = req.params;
    if (!PROJECT_ID_RE.test(projectId)) return res.status(400).json({ error: '잘못된 프로젝트 ID' });
    try {
      const found = await resolveProjectRoot(projectId);
      if (!found) return res.status(404).json({ error: '프로젝트 없음 또는 경로 없음' });
      const cwd = found.root;
      const args = ['diff'];
      if (req.query.staged === 'true') args.push('--cached');
      if (req.query.path) {
        const target = safeResolve(cwd, String(req.query.path));
        if (!target) return res.status(403).json({ error: '접근 불가 경로' });
        args.push('--', path.relative(cwd, target));
      }
      let out = git(args, cwd).out;
      if (out.length > MAX_FILE_BYTES) {
        out = out.slice(0, MAX_FILE_BYTES) + `\n\n[... diff 잘림 — 총 ${out.length} bytes]`;
      }
      const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd).out;
      res.type('text/plain; charset=utf-8').send(
        (out || '(diff 없음)') + (untracked ? `\n\n--- 추적되지 않는 파일 ---\n${untracked}` : '')
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/projects/:projectId/ls', async (req, res) => {
    const { projectId } = req.params;
    if (!PROJECT_ID_RE.test(projectId)) return res.status(400).json({ error: '잘못된 프로젝트 ID' });
    try {
      const found = await resolveProjectRoot(projectId);
      if (!found) return res.status(404).json({ error: '프로젝트 없음 또는 경로 없음' });
      const target = safeResolve(found.root, req.query.path || '.');
      if (!target) return res.status(403).json({ error: '접근 불가 경로' });
      const st = fs.statSync(target);
      if (!st.isDirectory()) return res.status(400).json({ error: '디렉토리가 아님' });
      const entries = fs.readdirSync(target, { withFileTypes: true })
        .filter(d => !DENY_SEGMENTS.has(d.name) && !DENY_FILE_RE.test(d.name))
        .slice(0, MAX_LS_ENTRIES)
        .map(d => {
          let bytes = null;
          try { if (d.isFile()) bytes = fs.statSync(path.join(target, d.name)).size; } catch { /* ignore */ }
          return { name: d.name, type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other', bytes };
        });
      res.json({ projectId, path: path.relative(found.root, target) || '.', entries });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/projects/:projectId/file', async (req, res) => {
    const { projectId } = req.params;
    if (!PROJECT_ID_RE.test(projectId)) return res.status(400).json({ error: '잘못된 프로젝트 ID' });
    if (!req.query.path) return res.status(400).json({ error: 'path 쿼리 필요' });
    try {
      const found = await resolveProjectRoot(projectId);
      if (!found) return res.status(404).json({ error: '프로젝트 없음 또는 경로 없음' });
      const target = safeResolve(found.root, String(req.query.path));
      if (!target) return res.status(403).json({ error: '접근 불가 경로' });
      const st = fs.statSync(target);
      if (!st.isFile()) return res.status(400).json({ error: '파일이 아님' });
      const fd = fs.openSync(target, 'r');
      const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      let body = buf.toString('utf8');
      if (st.size > MAX_FILE_BYTES) {
        body += `\n\n[... ${st.size - MAX_FILE_BYTES} bytes 잘림 — 총 ${st.size} bytes]`;
      }
      res.type('text/plain; charset=utf-8').send(body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use('/r/:token', router);
}
