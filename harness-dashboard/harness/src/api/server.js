// src/api/server.js
// Express REST API + WebSocket 서버

import express from 'express';
import session from 'express-session';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { projectQueries, taskQueries, logQueries } from '../db/db.js';
import crypto from 'crypto';
import fs from 'fs';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 레포 구조: harness-dashboard/harness/src/api/server.js
// 대시보드 빌드: harness-dashboard/dashboard/dist/
const DASHBOARD_DIST = path.join(__dirname, '../../../dashboard/dist');

// CLAUDE.md 위치 (agent-hub 루트)
const CLAUDE_MD_PATH = path.resolve(__dirname, '../../../../CLAUDE.md');

// ── directives/projects/{id}.md 자동 생성 ─────────────────
function createDirectiveFile({ id, name, localPath, github, deploy, stack, description }) {
  try {
    const directivesDir = path.resolve(__dirname, '../../../../directives/projects');
    fs.mkdirSync(directivesDir, { recursive: true });

    const filePath = path.join(directivesDir, `${id}.md`);
    if (fs.existsSync(filePath)) return { ok: true, reason: '이미 존재함 (스킵)' };

    const content = `# ${name} Project Directive

## Project Info

- **ID**: ${id}
- **Name**: ${name}
- **Path**: \`${localPath}\`
- **GitHub**: ${github || '-'}
- **Deploy**: ${deploy || '개발중'}

## Tech Stack

${stack || '-'}

## Description

${description || ''}

## Monitoring Rules

### Health Check
- URL: (배포 URL 설정 필요)
- Interval: 5분
- Alert: 3회 연속 실패 시 텔레그램 알림

## Auto-Fix Rules

1. **빌드 실패**: 에러 로그 분석 후 자동 수정 시도
2. **배포 실패**: 환경 변수 및 설정 확인
3. **런타임 에러**: 로그 분석 후 롤백 판단

## Related Directives

- \`directives/deploy.md\` - 배포 워크플로우
- \`directives/run_tests.md\` - 테스트 실행
`;

    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── CLAUDE.md 레지스트리 테이블 업데이트 ────────────────
function updateClaudeMdRegistry({ id, name, localPath, github, deploy }) {
  try {
    if (!fs.existsSync(CLAUDE_MD_PATH)) return { ok: false, reason: 'CLAUDE.md 없음' };

    let content = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
    const tableHeader = '| ID | 프로젝트 |';
    const idx = content.indexOf(tableHeader);
    if (idx === -1) return { ok: false, reason: 'CLAUDE.md 레지스트리 테이블 없음' };

    // 이미 등록된 경우 스킵
    if (content.includes(`| ${id} |`)) return { ok: true, reason: '이미 등록됨 (스킵)' };

    // 테이블의 구분선 다음 줄 찾기 (| --- | --- | ... |)
    const afterHeader = content.indexOf('\n', idx);
    const afterSep = content.indexOf('\n', afterHeader + 1);

    const newRow = `| ${id} | ${name} | \`${localPath}\` | ${github || '-'} | ${deploy || '개발중'} |`;
    content = content.slice(0, afterSep + 1) + newRow + '\n' + content.slice(afterSep + 1);

    fs.writeFileSync(CLAUDE_MD_PATH, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── 프로젝트 폴더에 CLAUDE.md 생성 ───────────────────────
function createProjectClaudeMd({ id, name, localPath, github, deploy, stack, description }) {
  try {
    if (!localPath || !fs.existsSync(localPath)) {
      return { ok: false, reason: '로컬 경로 없음 (스킵)' };
    }

    const claudeMdPath = path.join(localPath, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) return { ok: true, reason: '이미 존재함 (스킵)' };

    const templatePath = path.resolve(__dirname, '../../../../directives/templates/project_claude_md.md');
    let content;

    if (fs.existsSync(templatePath)) {
      content = fs.readFileSync(templatePath, 'utf8')
        .replace(/\{PROJECT_NAME\}/g, name)
        .replace(/\{PROJECT_ID\}/g, id)
        .replace(/\{PROJECT_DESCRIPTION\}/g, description || '프로젝트 설명을 추가하세요')
        .replace(/\{TECH_STACK\}/g, stack || '스택 정보를 추가하세요')
        .replace(/\{DEPLOYMENT_INFO\}/g, deploy || '배포 정보를 추가하세요');
    } else {
      content = `# ${name}

## 프로젝트 개요

- **ID**: ${id}
- **스택**: ${stack || '-'}
- **설명**: ${description || ''}
- **배포**: ${deploy || '개발중'}

## Agent 지침

이 프로젝트에서 작업할 때:
1. 변경 전 코드를 먼저 읽고 이해하세요
2. 기존 패턴과 컨벤션을 따르세요
3. 작업 완료 후 빌드/테스트 확인
`;
    }

    fs.writeFileSync(claudeMdPath, content, 'utf8');
    return { ok: true, path: claudeMdPath };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER  = process.env.GITHUB_USER || 'sun2141';

const API_KEY          = process.env.API_KEY;
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN || '';
// ALLOWED_ORIGINS: 쉼표 구분 복수 도메인 허용 (예: "https://a.vercel.app,https://b.cfargotunnel.com")
const ALLOWED_ORIGINS  = ALLOWED_ORIGIN
  ? ALLOWED_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
  : [];
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

// SESSION_SECRET: 환경변수 없으면 파일에 저장하여 서버 재시작 후에도 세션 유지
const SESSION_SECRET_FILE = path.join(__dirname, '../../../.session_secret');
function getOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const secret = fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
      if (secret.length >= 32) return secret;
    }
    const newSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SESSION_SECRET_FILE, newSecret, { mode: 0o600 });
    return newSecret;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}
const SESSION_SECRET = getOrCreateSessionSecret();

// ── Rate Limiter ──────────────────────────────────────────
const rateLimitMap   = new Map();
const RATE_LIMIT_MAX    = 60;
const RATE_LIMIT_WINDOW = 60_000;

function rateLimit(req, res, next) {
  const ip  = req.ip || req.socket.remoteAddress || 'unknown';
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
  // 대시보드 세션으로 인증된 경우 API Key 불필요
  if (req.session?.dashboardAuthenticated) return next();
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function validateString(value, maxLen = 500000) {
  if (typeof value !== 'string') return false;
  if (value.trim().length === 0) return false;
  if (value.length > maxLen) return false;
  return true;
}

// ── 대시보드 세션 인증 미들웨어 ────────────────────────────
// 정적 파일(HTML/CSS/JS)은 통과 — 클라이언트(React)가 로그인 화면 처리
// API 엔드포인트만 서버에서 세션 인증 검사
function dashboardAuthMiddleware(req, res, next) {
  // /auth/* 및 /health 경로는 인증 없이 허용
  if (req.path.startsWith('/auth/') || req.path === '/health') return next();

  // API 경로가 아닌 요청(정적 파일, SPA 라우팅)은 클라이언트가 처리하므로 통과
  if (!req.path.startsWith('/api/')) return next();

  // ── 이하 /api/* 경로 인증 ──────────────────────────────
  if (!DASHBOARD_PASSWORD) {
    return res.status(503).json({ error: 'DASHBOARD_PASSWORD not configured.' });
  }
  if (req.session?.dashboardAuthenticated) return next();
  return res.status(401).json({ error: 'Dashboard authentication required' });
}

export function createApiServer(agentRunner) {
  const app = express();
  const httpServer = createServer(app);

  app.use(express.json({ limit: '50mb' }));
  app.use(rateLimit);

  // 세션 미들웨어
  // COOKIE_SECURE 환경변수로 secure 쿠키 여부를 명시적으로 제어.
  // - HTTPS(Cloudflare Tunnel 포함): COOKIE_SECURE=true, COOKIE_SAME_SITE=none
  // - HTTP 직접 서빙:                COOKIE_SECURE=false (또는 미설정)
  //
  // Cross-origin(Vercel HTTPS → 백엔드 HTTPS) 쿠키 전송 요구사항:
  //   SameSite=None + Secure=true 필수 (크롬/파이어폭스 정책)
  const cookieSecure = process.env.COOKIE_SECURE === 'true';
  // COOKIE_SAME_SITE: 명시적 설정 없으면 cross-origin 여부로 자동 결정
  // cross-origin(Vercel→터널) 환경이면 'none', 동일 출처면 'lax'
  const cookieSameSite = process.env.COOKIE_SAME_SITE
    || (cookieSecure ? 'none' : 'lax');
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7일
    },
  }));

  // CORS
  // credentials: 'include' 사용 시 Access-Control-Allow-Origin에 와일드카드(*) 불가.
  // ALLOWED_ORIGINS 목록에 있거나, 목록이 비어있으면 요청 origin을 그대로 반영.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const isAllowed = ALLOWED_ORIGINS.length === 0
      || (origin && ALLOWED_ORIGINS.includes(origin));
    if (origin && isAllowed) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    } else if (!origin) {
      // curl 등 non-browser 요청
      res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // ── 대시보드 인증 미들웨어 전역 적용 ────────────────────────
  app.use(dashboardAuthMiddleware);

  // ── 헬스체크 (인증 없이) ──────────────────────────────────
  app.get('/health', (req, res) => {
    const status = agentRunner.getStatus();
    res.json({ ok: true, pid: process.pid, uptime: Math.floor(process.uptime()), harness: status, ts: Date.now() });
  });

  // ── 대시보드 비밀번호 인증 엔드포인트 ────────────────────
  app.post('/auth/login', (req, res) => {
    if (!DASHBOARD_PASSWORD) {
      return res.status(503).json({ error: 'DASHBOARD_PASSWORD not configured' });
    }
    const { password } = req.body;
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: '비밀번호를 입력하세요' });
    }
    const inputHash   = crypto.createHash('sha256').update(password).digest('hex');
    const storedHash  = crypto.createHash('sha256').update(DASHBOARD_PASSWORD).digest('hex');
    if (inputHash !== storedHash) {
      return res.status(401).json({ error: '비밀번호가 올바르지 않습니다' });
    }
    req.session.dashboardAuthenticated = true;
    res.json({ ok: true });
  });

  app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  // 클라이언트 localStorage 해시로 세션 복원 (페이지 새로고침 시 자동 재인증)
  app.post('/auth/reauth', (req, res) => {
    if (!DASHBOARD_PASSWORD) {
      return res.status(503).json({ error: 'DASHBOARD_PASSWORD not configured' });
    }
    const { hash } = req.body;
    if (!hash || typeof hash !== 'string') {
      return res.status(400).json({ error: '해시가 없습니다' });
    }
    const storedHash = crypto.createHash('sha256').update(DASHBOARD_PASSWORD).digest('hex');
    if (hash !== storedHash) {
      return res.status(401).json({ error: '인증 실패' });
    }
    req.session.dashboardAuthenticated = true;
    res.json({ ok: true });
  });

  app.get('/auth/status', (req, res) => {
    if (!DASHBOARD_PASSWORD) {
      return res.status(503).json({ error: 'DASHBOARD_PASSWORD not configured', authenticated: false, passwordRequired: false });
    }
    const authenticated = !!req.session?.dashboardAuthenticated;
    res.json({ authenticated, passwordRequired: true });
  });

  app.use('/api', authMiddleware);

  // ── 대시보드 정적 파일 서빙 (harness-dashboard/dashboard/dist/) ──
  if (fs.existsSync(DASHBOARD_DIST)) {
    app.use(express.static(DASHBOARD_DIST));
  }

  // ── 프로젝트 생성 (폴더 + GitHub 레포 + DB) ───────────────
  app.post('/api/projects/create', async (req, res) => {
    const { name, path: projectPath, stack, description, githubRepo, githubPrivate } = req.body;

    if (!validateString(name, 100)) return res.status(400).json({ error: 'name: 1~100자 필수' });
    if (!validateString(projectPath, 500)) return res.status(400).json({ error: 'path: 1~500자 필수' });

    const resolvedPath = path.resolve(projectPath);
    if (!resolvedPath.startsWith('/Users/sun/')) {
      return res.status(400).json({ error: '경로는 /Users/sun/ 하위여야 합니다' });
    }

    const slug   = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
    const suffix = crypto.randomBytes(3).toString('hex');
    const id     = `${slug}-${suffix}`;

    const results = { id, folderCreated: false, gitInit: false, githubRepo: null, dbInserted: false };

    try {
      fs.mkdirSync(resolvedPath, { recursive: true });
      results.folderCreated = true;

      execSync(`git init`, { cwd: resolvedPath, stdio: 'pipe' });
      execSync(`git checkout -b main`, { cwd: resolvedPath, stdio: 'pipe' });
      results.gitInit = true;

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
            private: githubPrivate !== false,
            auto_init: false,
          }),
        });

        const ghData = await ghRes.json();

        if (ghRes.ok) {
          results.githubRepo = { name: repoName, url: ghData.html_url, sshUrl: ghData.ssh_url, cloneUrl: ghData.clone_url };
          execSync(`git remote add origin ${ghData.ssh_url}`, { cwd: resolvedPath, stdio: 'pipe' });
        } else {
          results.githubError = ghData.message || 'GitHub 레포 생성 실패';
        }
      }

      const readmeContent = `# ${name}\n\n${description || ''}\n`;
      fs.writeFileSync(path.join(resolvedPath, 'README.md'), readmeContent);
      execSync(`git add README.md && git commit -m "Initial commit"`, { cwd: resolvedPath, stdio: 'pipe', shell: true });

      const project = await projectQueries.insert({ id, name, path: resolvedPath, stack, description });
      results.dbInserted = true;

      res.status(201).json({ ...results, project });
    } catch (err) {
      console.error('[create-project]', err);
      res.status(500).json({ error: err.message, results });
    }
  });

  // ── REST 엔드포인트 ────────────────────────────────────────

  app.get('/api/status', (req, res) => {
    res.json({ ok: true, harness: agentRunner.getStatus(), uptime: Math.floor(process.uptime()) });
  });

  app.get('/api/projects', async (req, res) => {
    try { res.json(await projectQueries.list()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/projects/:id', async (req, res) => {
    if (!/^[a-z0-9-]{1,50}$/.test(req.params.id)) {
      return res.status(400).json({ error: '잘못된 프로젝트 ID' });
    }
    try {
      const project = await projectQueries.get(req.params.id);
      if (!project) return res.status(404).json({ error: '프로젝트 없음' });
      res.json(project);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects', async (req, res) => {
    const { name, path: projectPath, stack, description, github, deploy, id: customId } = req.body;
    if (!validateString(name, 100))        return res.status(400).json({ error: 'name: 1~100자 문자열 필수' });
    if (!validateString(projectPath, 500)) return res.status(400).json({ error: 'path: 1~500자 문자열 필수' });
    if (stack !== undefined && !validateString(stack, 100))           return res.status(400).json({ error: 'stack: 100자 이하 문자열' });
    if (description !== undefined && !validateString(description, 500)) return res.status(400).json({ error: 'description: 500자 이하 문자열' });

    let id;
    if (customId && /^[a-z0-9-]{1,50}$/.test(customId)) {
      id = customId;
    } else {
      const slug   = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
      const suffix = crypto.randomBytes(3).toString('hex');
      id = `${slug}-${suffix}`;
    }

    try {
      const existing = await projectQueries.get(id);
      if (existing) return res.status(409).json({ error: '이미 존재하는 프로젝트 ID' });
      const project = await projectQueries.insert({ id, name, path: projectPath, stack, description });

      // CLAUDE.md 레지스트리 자동 업데이트
      const claudeResult = updateClaudeMdRegistry({ id, name, localPath: projectPath, github: github || null, deploy: deploy || null });

      // directives/projects/{id}.md 자동 생성
      const directiveResult = createDirectiveFile({ id, name, localPath: projectPath, github: github || null, deploy: deploy || null, stack, description });

      // 프로젝트 폴더에 CLAUDE.md 생성
      const projectClaudeMdResult = createProjectClaudeMd({ id, name, localPath: projectPath, github: github || null, deploy: deploy || null, stack, description });

      res.status(201).json({ ...project, claudeMd: claudeResult, directive: directiveResult, projectClaudeMd: projectClaudeMdResult });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/run', async (req, res) => {
    const { projectId, prompt, maxRounds, attachments } = req.body;
    if (!validateString(projectId, 50) || !/^[a-z0-9-]+$/.test(projectId)) {
      return res.status(400).json({ error: 'projectId: 영문 소문자/숫자/하이픈만 허용' });
    }
    // 파일 첨부 내용 포함 프롬프트 허용 (500KB)
    if (!validateString(prompt, 500000)) {
      return res.status(400).json({ error: 'prompt: 1~500000자 문자열 필요' });
    }
    let parsedMaxRounds;
    if (maxRounds !== undefined) {
      parsedMaxRounds = parseInt(maxRounds, 10);
      if (isNaN(parsedMaxRounds) || parsedMaxRounds < 1 || parsedMaxRounds > 20) {
        return res.status(400).json({ error: 'maxRounds: 1~20 사이 정수' });
      }
    }

    // attachments 검증
    let parsedAttachments;
    if (attachments !== undefined) {
      if (!Array.isArray(attachments)) {
        return res.status(400).json({ error: 'attachments: 배열 형식 필요' });
      }
      if (attachments.length > 10) {
        return res.status(400).json({ error: 'attachments: 최대 10개까지 첨부 가능' });
      }
      const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      for (const att of attachments) {
        if (!att || typeof att !== 'object') {
          return res.status(400).json({ error: 'attachments: 각 항목은 객체여야 합니다' });
        }
        if (!['image', 'text'].includes(att.type)) {
          return res.status(400).json({ error: 'attachments[].type: image 또는 text만 허용' });
        }
        if (typeof att.name !== 'string' || att.name.length > 255) {
          return res.status(400).json({ error: 'attachments[].name: 255자 이하 문자열 필요' });
        }
        if (att.type === 'image') {
          if (!ALLOWED_IMAGE_TYPES.includes(att.mimeType)) {
            return res.status(400).json({ error: `attachments[].mimeType: PNG/JPEG/GIF/WEBP만 허용 (받은 값: ${att.mimeType})` });
          }
          if (typeof att.data !== 'string' || !att.data) {
            return res.status(400).json({ error: 'attachments[].data: base64 문자열 필요' });
          }
        } else if (att.type === 'text') {
          if (typeof att.text !== 'string') {
            return res.status(400).json({ error: 'attachments[].text: 문자열 필요' });
          }
        }
      }
      parsedAttachments = attachments;
    }

    try {
      const taskId = await agentRunner.run({ projectId, prompt, maxRounds: parsedMaxRounds, attachments: parsedAttachments });
      res.json({ taskId, status: 'started' });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/resume', async (req, res) => {
    const { taskId } = req.body;
    if (!validateString(taskId, 100)) return res.status(400).json({ error: 'taskId 필수' });
    try {
      await agentRunner.resume(taskId);
      res.json({ taskId, status: 'resuming' });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/stop/:taskId', async (req, res) => {
    const { taskId } = req.params;
    if (!/^task_[0-9]+_[a-z0-9]+$/.test(taskId)) {
      return res.status(400).json({ error: '잘못된 taskId 형식' });
    }
    try {
      await agentRunner.stop(taskId);
      res.json({ taskId, status: 'stopped' });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/tasks', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    if (isNaN(limit) || limit < 1) return res.status(400).json({ error: 'limit: 1~100 정수' });
    try { res.json(await taskQueries.list(limit)); }
    catch (err) { res.status(500).json({ error: err.message }); }
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
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/tasks/:taskId', async (req, res) => {
    const { taskId } = req.params;
    if (!/^task_[0-9]+_[a-z0-9]+$/.test(taskId)) {
      return res.status(400).json({ error: '잘못된 taskId 형식' });
    }
    try {
      const task = await taskQueries.get(taskId);
      if (!task) return res.status(404).json({ error: '작업 없음' });

      const DELETABLE = ['failed', 'paused', 'building', 'pending', 'planning', 'evaluating'];
      if (!DELETABLE.includes(task.status)) {
        return res.status(409).json({ error: `삭제 불가 상태: ${task.status}.` });
      }

      const result = await agentRunner.deleteTask(taskId);
      res.json({ taskId, projectId: result.projectId, status: 'deleted' });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ── 웹훅 배포 트리거 ──────────────────────────────────────
  app.post('/api/deploy', (req, res) => {
    const harnessRoot = path.resolve(__dirname, '../..');
    const scriptPath  = path.join(harnessRoot, 'scripts', 'deploy_detached.sh');

    if (!fs.existsSync(scriptPath)) {
      return res.status(500).json({ error: 'deploy_detached.sh 스크립트 없음' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir    = path.join(harnessRoot, 'logs');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* 무시 */ }

    const logPath = path.join(logDir, `deploy-${timestamp}.log`);

    let logFd;
    try { logFd = fs.openSync(logPath, 'w'); }
    catch (err) { return res.status(500).json({ error: `로그 파일 생성 실패: ${err.message}` }); }

    const child = spawn('bash', [scriptPath], {
      cwd: harnessRoot,
      env: { ...process.env },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
    child.unref();
    fs.closeSync(logFd);

    child.on('error', (err) => {
      console.error('[/api/deploy] 배포 프로세스 시작 실패:', err.message);
    });

    res.json({ ok: true, message: '배포 프로세스 시작됨', logPath, note: '약 10초 후 harness가 재시작됩니다' });
  });

  // SPA fallback
  if (fs.existsSync(DASHBOARD_DIST)) {
    app.get(/^(?!\/api|\/ws).*/, (req, res) => {
      res.sendFile(path.join(DASHBOARD_DIST, 'index.html'));
    });
  }

  app.use((req, res) => res.status(404).json({ error: 'Not Found' }));
  app.use((err, req, res, next) => {
    console.error('[API Error]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  // ── WebSocket 서버 ────────────────────────────────────────
  const wss     = new WebSocketServer({ server: httpServer, path: '/ws' });
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
  agentRunner.on('task:deleted',   d => broadcast('task:deleted',   d));
  agentRunner.on('phase:start',    d => broadcast('phase:start',    d));
  agentRunner.on('phase:complete', d => broadcast('phase:complete', d));
  agentRunner.on('agent:text',     d => broadcast('agent:text',     d));
  agentRunner.on('agent:tool',     d => broadcast('agent:tool',     d));

  return { app, server: httpServer };
}
