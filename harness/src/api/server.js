// src/api/server.js
// Express REST API + WebSocket 서버

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { projectQueries, taskQueries, logQueries } from '../db/db.js';

const API_KEY = process.env.API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

// ── Rate Limiter (의존성 없는 단순 구현) ─────────────────────
const rateLimitMap = new Map(); // ip → { count, resetAt }
const RATE_LIMIT_MAX = 60;      // 분당 최대 요청 수
const RATE_LIMIT_WINDOW = 60_000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return next();
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too Many Requests' });
  }

  entry.count++;
  next();
}

// ── 인증 미들웨어 ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  // API_KEY는 반드시 설정되어야 함 — 미설정 시 모든 요청 차단
  if (!API_KEY) {
    return res.status(503).json({ error: 'API_KEY not configured. Server is not operational.' });
  }
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── 입력값 검증 헬퍼 ──────────────────────────────────────
function validateString(value, maxLen = 2000) {
  if (typeof value !== 'string') return false;
  if (value.trim().length === 0) return false;
  if (value.length > maxLen) return false;
  return true;
}

export function createApiServer(agentRunner) {
  const app = express();
  const httpServer = createServer(app);

  // 요청 body 크기 제한 (10kb)
  app.use(express.json({ limit: '10kb' }));

  // Rate limiting (인증 전에 적용)
  app.use(rateLimit);

  // CORS — 환경변수로 명시적 origin만 허용
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
      res.header('Access-Control-Allow-Origin', origin);
    } else if (!ALLOWED_ORIGIN) {
      // ALLOWED_ORIGIN 미설정 시 로컬호스트만 허용
      res.header('Access-Control-Allow-Origin', 'http://localhost:5173');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // 인증 (모든 /api/* 경로)
  app.use('/api', authMiddleware);

  // ── REST 엔드포인트 ──────────────────────────────────────

  // GET /api/status
  app.get('/api/status', (req, res) => {
    res.json({
      ok: true,
      harness: agentRunner.getStatus(),
      uptime: Math.floor(process.uptime()),
    });
  });

  // GET /api/projects
  app.get('/api/projects', (req, res) => {
    res.json(projectQueries.list());
  });

  // GET /api/projects/:id
  app.get('/api/projects/:id', (req, res) => {
    // id는 알파벳/숫자/하이픈만 허용
    if (!/^[a-z0-9-]{1,50}$/.test(req.params.id)) {
      return res.status(400).json({ error: '잘못된 프로젝트 ID' });
    }
    const project = projectQueries.get(req.params.id);
    if (!project) return res.status(404).json({ error: '프로젝트 없음' });
    res.json(project);
  });

  // POST /api/run
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
      if (isNaN(r) || r < 1 || r > 5) {
        return res.status(400).json({ error: 'maxRounds: 1~5 사이 정수' });
      }
    }

    try {
      const taskId = await agentRunner.run({ projectId, prompt, maxRounds });
      res.json({ taskId, status: 'started' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/resume
  app.post('/api/resume', async (req, res) => {
    const { taskId } = req.body;
    if (!validateString(taskId, 100)) {
      return res.status(400).json({ error: 'taskId 필수' });
    }
    try {
      await agentRunner.resume(taskId);
      res.json({ taskId, status: 'resuming' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/stop/:taskId
  app.delete('/api/stop/:taskId', (req, res) => {
    const { taskId } = req.params;
    if (!/^task_[0-9]+_[a-z0-9]+$/.test(taskId)) {
      return res.status(400).json({ error: '잘못된 taskId 형식' });
    }
    try {
      agentRunner.stop(taskId);
      res.json({ taskId, status: 'stopped' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/tasks
  app.get('/api/tasks', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    if (isNaN(limit) || limit < 1) {
      return res.status(400).json({ error: 'limit: 1~100 정수' });
    }
    res.json(taskQueries.list(limit));
  });

  // GET /api/tasks/:id
  app.get('/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    if (!/^task_[0-9]+_[a-z0-9]+$/.test(id)) {
      return res.status(400).json({ error: '잘못된 task ID 형식' });
    }
    const task = taskQueries.get(id);
    if (!task) return res.status(404).json({ error: '작업 없음' });
    const logs = logQueries.forTask(id);
    res.json({ ...task, logs });
  });

  // 404 핸들러
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // 전역 에러 핸들러 (스택 트레이스 노출 방지)
  app.use((err, req, res, next) => {
    console.error('[API Error]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  // ── WebSocket 서버 ────────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', noServer: false });
  const clients = new Set();

  wss.on('connection', (ws, req) => {
    // WS 인증: Authorization 헤더 또는 첫 번째 메시지로 인증
    // 쿼리 파라미터 방식은 서버 로그에 키가 노출되므로 사용하지 않음
    let authenticated = !API_KEY; // API_KEY 미설정 시 개발 편의상 허용

    if (!authenticated) {
      // 연결 후 5초 내에 인증 메시지를 받아야 함
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
    // 민감한 필드 제거 후 브로드캐스트
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
