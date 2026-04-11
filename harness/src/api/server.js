// src/api/server.js
// Express REST API + WebSocket 서버

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { projectQueries, taskQueries, logQueries } from '../db/db.js';
import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIST = path.join(__dirname, '../../dashboard/dist');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER = process.env.GITHUB_USER || 'sun2141';

const API_KEY = process.env.API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

// ── Rate Limiter ──────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW = 60_000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return next();
  }
  if (entry.count >= RATE_LIMIT_MAX) return res.status(429).json({ error: 'Too Many Requests' });
  entry.count++;
  next();
}

// ── 인증 미들웨어 ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!API_KEY) return res.status(503).json({ error: 'API_KEY not configured' });
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function validateString(value, maxLen = 2000) {
  if (typeof value !== 'string') return false;
  if (value.trim().length === 0) return false;
  if (value.length > maxLen) return false;
  return true;
}

export function createApiServer(agentRunner) {
  const app = express();
  const httpServer = createServer(app);

  app.use(express.json({ limit: '10kb' }));
  app.use(rateLimit);

  // ── 대시보드 정적 파일 서빙 (빌드된 dist/) ─────────────────
  if (fs.existsSync(DASHBOARD_DIST)) {
    app.use(express.static(DASHBOARD_DIST));
    // SPA fallback: /api 제외한 모든 요청은 index.html
    app.get(/^(?!\/api|\/ws).*/, (req, res) => {
      res.sendFile(path.join(DASHBOARD_DIST, 'index.html'));
    });
  }

  // CORS
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
      res.header('Access-Control-Allow-Origin', origin);
    } else if (!ALLOWED_ORIGIN) {
      res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  app.use('/api', authMiddleware);

  // ── 프로젝트 생성 (폴더 + GitHub 레포 + DB) ───────────────
  app.post('/api/projects/create', async (req, res) => {
    const { name, path: projectPath, stack, description, githubRepo, githubPrivate } = req.body;

    if (!validateString(name, 100)) return res.status(400).json({ error: 'name: 1~100자 필수' });
    if (!validateString(projectPath, 500)) return res.status(400).json({ error: 'path: 1~500자 필수' });

    // 경로 안전 검증: /Users/sun/ 하위만 허용
    const resolvedPath = path.resolve(projectPath);
    if (!resolvedPath.startsWith('/Users/sun/')) {
      return res.status(400).json({ error: '경로는 /Users/sun/ 하위여야 합니다' });
    }

    // slug 기반 ID 생성
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
    const suffix = crypto.randomBytes(3).toString('hex');
    const id = `${slug}-${suffix}`;

    const results = { id, folderCreated: false, gitInit: false, githubRepo: null, dbInserted: false };

    try {
      // 1. 로컬 폴더 생성
      fs.mkdirSync(resolvedPath, { recursive: true });
      results.folderCreated = true;

      // 2. git init
      execSync(`git init`, { cwd: resolvedPath, stdio: 'pipe' });
      execSync(`git checkout -b main`, { cwd: resolvedPath, stdio: 'pipe' });
      results.gitInit = true;

      // 3. GitHub 레포 생성 (토큰이 있을 때만)
      if (githubRepo && GITHUB_TOKEN) {
        const repoName = (githubRepo === true || githubRepo === 'auto')
          ? slug
          : String(githubRepo).toLowerCase().replace(/[^a-z0-9-_]/g, '-');

        const ghRes = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'agent-harness',
          },
          body: JSON.stringify({
            name: repoName,
            description: description || '',
            private: githubPrivate !== false, // 기본 private
            auto_init: false,
          }),
        });

        const ghData = await ghRes.json();

        if (ghRes.ok) {
          results.githubRepo = { name: repoName, url: ghData.html_url, sshUrl: ghData.ssh_url, cloneUrl: ghData.clone_url };
          // remote 연결
          execSync(`git remote add origin ${ghData.ssh_url}`, { cwd: resolvedPath, stdio: 'pipe' });
        } else {
          results.githubError = ghData.message || 'GitHub 레포 생성 실패';
        }
      }

      // 4. README 초기 커밋
      const readmeContent = `# ${name}\n\n${description || ''}\n`;
      fs.writeFileSync(path.join(resolvedPath, 'README.md'), readmeContent);
      execSync(`git add README.md && git commit -m "Initial commit"`, { cwd: resolvedPath, stdio: 'pipe', shell: true });

      // 5. DB에 프로젝트 등록
      const project = await projectQueries.insert({ id, name, path: resolvedPath, stack, description });
      results.dbInserted = true;

      res.status(201).json({ ...results, project });
    } catch (err) {
      console.error('[create-project]', err);
      res.status(500).json({ error: err.message, results });
    }
  });

  // ── REST 엔드포인트 (모두 async/await) ────────────────────

  app.get('/api/status', (req, res) => {
    res.json({ ok: true, harness: agentRunner.getStatus(), uptime: Math.floor(process.uptime()) });
  });

  app.get('/api/projects', async (req, res) => {
    try {
      const data = await projectQueries.list();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id', async (req, res) => {
    if (!/^[a-z0-9-]{1,50}$/.test(req.params.id)) {
      return res.status(400).json({ error: '잘못된 프로젝트 ID' });
    }
    try {
      const project = await projectQueries.get(req.params.id);
      if (!project) return res.status(404).json({ error: '프로젝트 없음' });
      res.json(project);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects', async (req, res) => {
    const { name, path: projectPath, stack, description } = req.body;
    if (!validateString(name, 100)) {
      return res.status(400).json({ error: 'name: 1~100자 문자열 필수' });
    }
    if (!validateString(projectPath, 500)) {
      return res.status(400).json({ error: 'path: 1~500자 문자열 필수' });
    }
    if (stack !== undefined && !validateString(stack, 100)) {
      return res.status(400).json({ error: 'stack: 100자 이하 문자열' });
    }
    if (description !== undefined && !validateString(description, 500)) {
      return res.status(400).json({ error: 'description: 500자 이하 문자열' });
    }
    // 이름 기반 slug 생성 (영문 소문자/숫자/하이픈, 최대 30자) + 충돌 방지 suffix
    const slug = name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'project';
    const suffix = crypto.randomBytes(3).toString('hex');
    const id = `${slug}-${suffix}`;
    try {
      const existing = await projectQueries.get(id);
      if (existing) return res.status(409).json({ error: '이미 존재하는 프로젝트 ID' });
      const project = await projectQueries.insert({ id, name, path: projectPath, stack, description });
      res.status(201).json(project);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/run', async (req, res) => {
    const { projectId, prompt, maxRounds } = req.body;
    if (!validateString(projectId, 50) || !/^[a-z0-9-]+$/.test(projectId)) {
      return res.status(400).json({ error: 'projectId: 영문 소문자/숫자/하이픈만 허용' });
    }
    if (!validateString(prompt, 2000)) {
      return res.status(400).json({ error: 'prompt: 1~2000자 문자열 필요' });
    }
    if (maxRounds !== undefined) {
      const r = parseInt(maxRounds, 10);
      if (isNaN(r) || r < 1 || r > 20) {
        return res.status(400).json({ error: 'maxRounds: 1~20 사이 정수' });
      }
    }
    try {
      const taskId = await agentRunner.run({ projectId, prompt, maxRounds });
      res.json({ taskId, status: 'started' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/resume', async (req, res) => {
    const { taskId } = req.body;
    if (!validateString(taskId, 100)) return res.status(400).json({ error: 'taskId 필수' });
    try {
      await agentRunner.resume(taskId);
      res.json({ taskId, status: 'resuming' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/stop/:taskId', async (req, res) => {
    const { taskId } = req.params;
    if (!/^task_[0-9]+_[a-z0-9]+$/.test(taskId)) {
      return res.status(400).json({ error: '잘못된 taskId 형식' });
    }
    try {
      await agentRunner.stop(taskId);
      res.json({ taskId, status: 'stopped' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/tasks', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    if (isNaN(limit) || limit < 1) return res.status(400).json({ error: 'limit: 1~100 정수' });
    try {
      const data = await taskQueries.list(limit);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    if (!/^task_[0-9]+_[a-z0-9]+$/.test(id)) {
      return res.status(400).json({ error: '잘못된 task ID 형식' });
    }
    try {
      const task = await taskQueries.get(id);
      if (!task) return res.status(404).json({ error: '작업 없음' });
      const logs = await logQueries.forTask(id);
      res.json({ ...task, logs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'Not Found' }));
  app.use((err, req, res, next) => {
    console.error('[API Error]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  // ── WebSocket 서버 ────────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set();

  wss.on('connection', (ws) => {
    let authenticated = !API_KEY;

    if (!authenticated) {
      const authTimeout = setTimeout(() => {
        if (!authenticated) ws.close(1008, 'Authentication timeout');
      }, 5000);

      ws.once('message', (data) => {
        clearTimeout(authTimeout);
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth' && msg.key === API_KEY) {
            authenticated = true;
            clients.add(ws);
            ws.send(JSON.stringify({ type: 'authenticated', status: agentRunner.getStatus() }));
          } else {
            ws.close(1008, 'Unauthorized');
          }
        } catch {
          ws.close(1008, 'Invalid auth message');
        }
      });
    } else {
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'connected', status: agentRunner.getStatus() }));
    }

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  function broadcast(type, data) {
    const { prompt: _p, plan: _pl, ...safeData } = data;
    const msg = JSON.stringify({ type, ...safeData, ts: Date.now() });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  agentRunner.on('task:created',   d => broadcast('task:created',   d));
  agentRunner.on('task:queued',    d => broadcast('task:queued',    d));
  agentRunner.on('task:complete',  d => broadcast('task:complete',  d));
  agentRunner.on('task:paused',    d => broadcast('task:paused',    d));
  agentRunner.on('task:failed',    d => broadcast('task:failed',    d));
  agentRunner.on('phase:start',    d => broadcast('phase:start',    d));
  agentRunner.on('phase:complete', d => broadcast('phase:complete', d));
  agentRunner.on('agent:text',     d => broadcast('agent:text',     d));
  agentRunner.on('agent:tool',     d => broadcast('agent:tool',     d));

  return { app, server: httpServer };
}
