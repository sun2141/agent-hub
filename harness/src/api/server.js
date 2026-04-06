// src/api/server.js
// Express REST API + WebSocket 서버

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { projectQueries, taskQueries, logQueries } from '../db/db.js';

const API_KEY = process.env.API_KEY;

// ── 인증 미들웨어 ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!API_KEY) return next(); // 개발 시 API_KEY 미설정이면 통과
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

export function createApiServer(agentRunner) {
  const app = express();
  const httpServer = createServer(app);

  app.use(express.json());
  app.use(authMiddleware);

  // CORS (모바일 대시보드에서 접근 가능하도록)
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // ── REST 엔드포인트 ──────────────────────────────────────

  // GET /api/status — 하네스 전체 상태
  app.get('/api/status', (req, res) => {
    res.json({
      ok: true,
      harness: agentRunner.getStatus(),
      uptime: process.uptime(),
    });
  });

  // GET /api/projects — 프로젝트 목록
  app.get('/api/projects', (req, res) => {
    res.json(projectQueries.list());
  });

  // GET /api/projects/:id — 프로젝트 단건
  app.get('/api/projects/:id', (req, res) => {
    const project = projectQueries.get(req.params.id);
    if (!project) return res.status(404).json({ error: '프로젝트 없음' });
    res.json(project);
  });

  // POST /api/run — 파이프라인 시작
  // body: { projectId, prompt, maxRounds? }
  app.post('/api/run', async (req, res) => {
    const { projectId, prompt, maxRounds } = req.body;
    if (!projectId || !prompt) {
      return res.status(400).json({ error: 'projectId, prompt 필수' });
    }
    try {
      const taskId = await agentRunner.run({ projectId, prompt, maxRounds });
      res.json({ taskId, status: 'started' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/resume — 일시정지 작업 재개
  app.post('/api/resume', async (req, res) => {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: 'taskId 필수' });
    try {
      await agentRunner.resume(taskId);
      res.json({ taskId, status: 'resuming' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/stop/:taskId — 작업 중지
  app.delete('/api/stop/:taskId', (req, res) => {
    try {
      agentRunner.stop(req.params.taskId);
      res.json({ taskId: req.params.taskId, status: 'stopped' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/tasks — 최근 작업 목록
  app.get('/api/tasks', (req, res) => {
    const limit = parseInt(req.query.limit || '20', 10);
    res.json(taskQueries.list(limit));
  });

  // GET /api/tasks/:id — 작업 단건 + 로그
  app.get('/api/tasks/:id', (req, res) => {
    const task = taskQueries.get(req.params.id);
    if (!task) return res.status(404).json({ error: '작업 없음' });
    const logs = logQueries.forTask(req.params.id);
    res.json({ ...task, logs });
  });

  // ── WebSocket 서버 ────────────────────────────────────────
  // ws://host/ws — 실시간 이벤트 스트림
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set();

  wss.on('connection', (ws, req) => {
    // WS 인증: ?key=... 쿼리 파라미터
    if (API_KEY) {
      const url = new URL(req.url, 'ws://localhost');
      if (url.searchParams.get('key') !== API_KEY) {
        ws.close(1008, 'Unauthorized');
        return;
      }
    }

    clients.add(ws);
    ws.send(JSON.stringify({ type: 'connected', status: agentRunner.getStatus() }));

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  // 에이전트 이벤트 → WS 브로드캐스트
  function broadcast(type, data) {
    const msg = JSON.stringify({ type, ...data, ts: Date.now() });
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
