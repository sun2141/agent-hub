// src/api/server.js
// Express REST API + WebSocket 서버

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { projectQueries, taskQueries, logQueries } from '../db/db.js';
import crypto from 'crypto';
import fs from 'fs';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIST = path.join(__dirname, '../../dashboard/dist');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER = process.env.GITHUB_USER || 'sun2141';

// CLAUDE.md 위치 (agent-hub 루트)
const CLAUDE_MD_PATH = path.resolve(__dirname, '../../../CLAUDE.md');

// ── directives/projects/{id}.md 자동 생성 ─────────────────
function createDirectiveFile({ id, name, localPath, github, deploy, stack, description }) {
  try {
    const directivesDir = path.resolve(__dirname, '../../../directives/projects');
    fs.mkdirSync(directivesDir, { recursive: true });

    const filePath = path.join(directivesDir, `${id}.md`);
    if (fs.existsSync(filePath)) return { ok: true, reason: '이미 존재함 (스킵)' };

    const githubStr = github || '-';
    const deployStr = deploy || '개발중';
    const stackStr = stack || '-';
    const descStr = description || '';

    const content = `# ${name} Project Directive

## Project Info

- **ID**: ${id}
- **Name**: ${name}
- **Path**: \`${localPath}\`
- **GitHub**: ${githubStr}
- **Deploy**: ${deployStr}

## Tech Stack

${stackStr}

## Description

${descStr}

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

// ── 프로젝트 폴더에 CLAUDE.md 생성 ───────────────────────
function createProjectClaudeMd({ id, name, localPath, github, deploy, stack, description }) {
  try {
    if (!localPath || !fs.existsSync(localPath)) {
      return { ok: false, reason: '로컬 경로 없음 (스킵)' };
    }

    const claudeMdPath = path.join(localPath, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) return { ok: true, reason: '이미 존재함 (스킵)' };

    const templatePath = path.resolve(__dirname, '../../../directives/templates/project_claude_md.md');
    let content;

    if (fs.existsSync(templatePath)) {
      content = fs.readFileSync(templatePath, 'utf8')
        .replace(/\{PROJECT_NAME\}/g, name)
        .replace(/\{PROJECT_ID\}/g, id)
        .replace(/\{PROJECT_DESCRIPTION\}/g, description || '프로젝트 설명을 추가하세요')
        .replace(/\{TECH_STACK\}/g, stack || '스택 정보를 추가하세요')
        .replace(/\{DEPLOYMENT_INFO\}/g, deploy || '배포 정보를 추가하세요')
        .replace(/\{GITHUB_REPO\}/g, github || '-')
        .replace(/\{BRANCH_STRATEGY\}/g, 'main 브랜치 사용')
        .replace(/\{PROJECT_FOCUS\}/g, description || '프로젝트 목적에 집중')
        .replace(/\{DEPLOYMENT_CONSIDERATIONS\}/g, deploy ? `${deploy} 배포 환경 고려` : '배포 환경 고려');
    } else {
      content = `# ${name} - Agent Instructions

> 이 파일은 ${name} 프로젝트 전용 Agent 지침입니다.

## Project Overview

**${name}** - ${description || ''}

- **Tech Stack**: ${stack || '-'}
- **Deployment**: ${deploy || '개발중'}
- **GitHub**: ${github || '-'}

## Agent Guidelines

1. 프로젝트 목적에 집중
2. 배포 환경 고려
3. 새 기능 추가 시 테스트 포함

### 금지 사항

- 이 프로젝트에서 자동화/인프라 작업 하지 말 것
- agent-hub 전용 작업은 \`/Users/sun/agent-hub/\`에서 수행

---

## Central Hub Connection

이 프로젝트는 **agent-hub** (\`/Users/sun/agent-hub/\`)와 연결됩니다.

- 프로젝트별 directive: \`/Users/sun/agent-hub/directives/projects/${id}.md\`
- 전체 인프라: \`/Users/sun/agent-hub/CLAUDE.md\`
`;
    }

    fs.writeFileSync(claudeMdPath, content, 'utf8');
    return { ok: true, path: claudeMdPath };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── CLAUDE.md 프로젝트 레지스트리 업데이트 ─────────────────
function updateClaudeMdRegistry({ id, name, localPath, github, deploy }) {
  try {
    if (!fs.existsSync(CLAUDE_MD_PATH)) return { ok: false, reason: 'CLAUDE.md 없음' };

    const content = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');

    // 테이블 헤더 다음 줄 패턴으로 행 삽입 위치 탐색
    const tableHeaderRe = /\| ID \| 프로젝트 \| 로컬 경로 \| GitHub \| 배포 \|\n\|[-| ]+\|\n/;
    const match = tableHeaderRe.exec(content);
    if (!match) return { ok: false, reason: '레지스트리 테이블을 찾을 수 없음' };

    // 이미 등록된 ID인지 확인
    const idPattern = new RegExp(`\\| ${id} \\|`);
    if (idPattern.test(content)) return { ok: true, reason: '이미 등록됨 (스킵)' };

    const githubStr = github ? github : '-';
    const deployStr = deploy ? deploy : '개발중';
    const newRow = `| ${id} | ${name} | \`${localPath}\` | ${githubStr} | ${deployStr} |\n`;

    // 테이블 헤더+구분선 바로 다음에 새 행 삽입
    const insertAt = match.index + match[0].length;
    const updated = content.slice(0, insertAt) + newRow + content.slice(insertAt);

    fs.writeFileSync(CLAUDE_MD_PATH, updated, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

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

function validateString(value, maxLen = 500000) {
  if (typeof value !== 'string') return false;
  if (value.trim().length === 0) return false;
  if (value.length > maxLen) return false;
  return true;
}

export function createApiServer(agentRunner) {
  const app = express();
  const httpServer = createServer(app);

  app.use(express.json({ limit: '50mb' }));
  app.use(rateLimit);

  // CORS (정적 파일 서빙보다 먼저 등록)
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

  // ── 헬스체크 ──────────────────────────────────────────────
  app.get('/health', (req, res) => {
    const status = agentRunner.getStatus();
    res.json({
      ok: true,
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      harness: status,
      ts: Date.now(),
    });
  });

  app.use('/api', authMiddleware);

  if (fs.existsSync(DASHBOARD_DIST)) {
    app.use(express.static(DASHBOARD_DIST));
  }

  // ── 프로젝트 생성 ─────────────────────────────────────────
  app.post('/api/projects/create', async (req, res) => {
    const { name, path: projectPath, stack, description, githubRepo, githubPrivate } = req.body;

    if (!validateString(name, 100)) return res.status(400).json({ error: 'name: 1~100자 필수' });
    if (!validateString(projectPath, 500)) return res.status(400).json({ error: 'path: 1~500자 필수' });

    const resolvedPath = path.resolve(projectPath);
    if (!resolvedPath.startsWith('/Users/sun/')) {
      return res.status(400).json({ error: '경로는 /Users/sun/ 하위여야 합니다' });
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
    const suffix = crypto.randomBytes(3).toString('hex');
    const id = `${slug}-${suffix}`;

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

      // CLAUDE.md 레지스트리 자동 업데이트
      results.claudeMd = updateClaudeMdRegistry({
        id,
        name,
        localPath: resolvedPath,
        github: results.githubRepo ? `${GITHUB_USER}/${results.githubRepo.name}` : null,
        deploy: null,
      });

      // directives/projects/{id}.md 자동 생성
      results.directive = createDirectiveFile({
        id,
        name,
        localPath: resolvedPath,
        github: results.githubRepo ? `${GITHUB_USER}/${results.githubRepo.name}` : null,
        deploy: null,
        stack,
        description,
      });

      // 프로젝트 폴더에 CLAUDE.md 생성
      results.projectClaudeMd = createProjectClaudeMd({
        id,
        name,
        localPath: resolvedPath,
        github: results.githubRepo ? `${GITHUB_USER}/${results.githubRepo.name}` : null,
        deploy: null,
        stack,
        description,
      });

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
    const { name, path: projectPath, stack, description, github, deploy, id: customId } = req.body;
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

    let id;
    if (customId && /^[a-z0-9-]{1,50}$/.test(customId)) {
      id = customId;
    } else {
      const slug = name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'project';
      const suffix = crypto.randomBytes(3).toString('hex');
      id = `${slug}-${suffix}`;
    }

    try {
      const existing = await projectQueries.get(id);
      if (existing) return res.status(409).json({ error: '이미 존재하는 프로젝트 ID' });
      const project = await projectQueries.insert({ id, name, path: projectPath, stack, description });

      // CLAUDE.md 레지스트리 자동 업데이트
      const claudeResult = updateClaudeMdRegistry({
        id,
        name,
        localPath: projectPath,
        github: github || null,
        deploy: deploy || null,
      });

      // directives/projects/{id}.md 자동 생성
      const directiveResult = createDirectiveFile({
        id,
        name,
        localPath: projectPath,
        github: github || null,
        deploy: deploy || null,
        stack,
        description,
      });

      // 프로젝트 폴더에 CLAUDE.md 생성
      const projectClaudeMdResult = createProjectClaudeMd({
        id,
        name,
        localPath: projectPath,
        github: github || null,
        deploy: deploy || null,
        stack,
        description,
      });

      res.status(201).json({ ...project, claudeMd: claudeResult, directive: directiveResult, projectClaudeMd: projectClaudeMdResult });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
    let parsedAttachments;
    if (attachments !== undefined) {
      if (!Array.isArray(attachments)) {
        return res.status(400).json({ error: 'attachments: 배열 형식 필요' });
      }
      if (attachments.length > 200) {
        return res.status(400).json({ error: 'attachments: 최대 200개까지 첨부 가능' });
      }
      const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      for (const att of attachments) {
        if (!att || typeof att !== 'object') {
          return res.status(400).json({ error: 'attachments: 각 항목은 객체여야 합니다' });
        }
        if (!['image', 'text'].includes(att.type)) {
          return res.status(400).json({ error: 'attachments[].type: image 또는 text만 허용' });
        }
        if (!validateString(att.name, 255)) {
          return res.status(400).json({ error: 'attachments[].name: 255자 이하 문자열 필요' });
        }
        if (att.type === 'image') {
          if (!ALLOWED_IMAGE_TYPES.includes(att.mimeType)) {
            return res.status(400).json({ error: `attachments[].mimeType: PNG/JPEG/GIF/WEBP만 허용 (받은 값: ${att.mimeType})` });
          }
          if (typeof att.data !== 'string') {
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
        return res.status(409).json({ error: `삭제 불가 상태: ${task.status}. failed/paused/building 상태만 삭제 가능합니다.` });
      }

      const result = await agentRunner.deleteTask(taskId);
      res.json({ taskId, projectId: result.projectId, status: 'deleted' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── 폴더 파일 분석 ───────────────────────────────────────
  // 클라이언트에서 여러 파일(폴더 내용)을 JSON 배열로 전송 받아 파일 트리 구조를 반환
  app.post('/api/folder-parse', async (req, res) => {
    const { files } = req.body;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files: 배열 형식 필요' });
    }
    if (files.length > 500) {
      return res.status(400).json({ error: 'files: 최대 500개까지 처리 가능' });
    }

    const tree = {};
    const processed = [];

    for (const f of files) {
      if (!f || typeof f !== 'object') continue;
      if (typeof f.path !== 'string' || typeof f.name !== 'string') continue;
      if (f.size !== undefined && f.size > 5 * 1024 * 1024) continue; // 5MB 초과 스킵

      // 경로 기반 트리 구성
      const parts = f.path.split('/').filter(Boolean);
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) node[parts[i]] = { _type: 'dir', _children: {} };
        node = node[parts[i]]._children;
      }
      const fileName = parts[parts.length - 1] || f.name;
      node[fileName] = { _type: 'file', _path: f.path, _size: f.size || 0 };
      processed.push({ path: f.path, name: f.name, size: f.size || 0 });
    }

    res.json({ ok: true, tree, files: processed, total: processed.length });
  });

  // ── Google Drive 폴더 파일 목록 조회 ─────────────────────
  app.post('/api/gdrive-folder', async (req, res) => {
    const { url } = req.body;
    if (!validateString(url, 500)) {
      return res.status(400).json({ error: 'url: Google Drive 공유 링크 필요' });
    }

    // Google Drive 폴더 ID 추출 패턴들
    const patterns = [
      /\/folders\/([a-zA-Z0-9_-]+)/,
      /id=([a-zA-Z0-9_-]+)/,
      /\/d\/([a-zA-Z0-9_-]+)/,
    ];

    let folderId = null;
    for (const pat of patterns) {
      const m = url.match(pat);
      if (m) { folderId = m[1]; break; }
    }

    if (!folderId) {
      return res.status(400).json({ error: 'Google Drive 폴더 ID를 추출할 수 없습니다. 폴더 공유 링크를 확인하세요.' });
    }

    const GDRIVE_API_KEY = process.env.GOOGLE_API_KEY;

    // 단일 폴더에서 파일/서브폴더 목록 조회 (페이지네이션 포함)
    async function listFolderContents(parentId) {
      const items = [];
      let pageToken = null;
      do {
        let apiUrl;
        if (GDRIVE_API_KEY) {
          apiUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and trashed=false`)}&fields=nextPageToken,files(id,name,mimeType,size,parents)&pageSize=100&key=${GDRIVE_API_KEY}`;
        } else {
          apiUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and trashed=false`)}&fields=nextPageToken,files(id,name,mimeType,size,parents)&pageSize=100`;
        }
        if (pageToken) apiUrl += `&pageToken=${pageToken}`;

        const resp = await fetch(apiUrl, {
          headers: GDRIVE_API_KEY ? {} : { 'Authorization': 'Bearer ' + (process.env.GDRIVE_ACCESS_TOKEN || '') },
        });
        const data = await resp.json();

        if (data.error) {
          const msg = data.error.message || 'Google Drive API 오류';
          throw Object.assign(new Error(msg), { status: msg.includes('required') ? 401 : 400 });
        }

        if (Array.isArray(data.files)) items.push(...data.files);
        pageToken = data.nextPageToken || null;
      } while (pageToken && items.length < 1000);
      return items;
    }

    // 재귀적으로 폴더 탐색 (BFS 방식, 최대 500개 파일 / 5단계 깊이)
    async function traverseFolder(rootId) {
      const allFiles = [];
      const folderQueue = [{ id: rootId, path: '' }];
      const visited = new Set();
      const MAX_FILES = 500;
      const MAX_DEPTH = 5;

      while (folderQueue.length > 0 && allFiles.length < MAX_FILES) {
        const { id: currentId, path: currentPath, depth = 0 } = folderQueue.shift();
        if (visited.has(currentId) || depth > MAX_DEPTH) continue;
        visited.add(currentId);

        const items = await listFolderContents(currentId);

        for (const item of items) {
          const itemPath = currentPath ? `${currentPath}/${item.name}` : item.name;
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            folderQueue.push({ id: item.id, path: itemPath, depth: depth + 1 });
          } else {
            allFiles.push({ ...item, _path: itemPath });
          }
          if (allFiles.length >= MAX_FILES) break;
        }
      }
      return allFiles;
    }

    try {
      let allFiles;
      try {
        allFiles = await traverseFolder(folderId);
      } catch (apiErr) {
        if (apiErr.status === 401) {
          return res.status(401).json({ error: 'Google Drive 공개 폴더 접근에는 API 키가 필요합니다. 환경 변수 GOOGLE_API_KEY를 설정하거나 파일을 공개로 설정하세요.' });
        }
        return res.status(400).json({ error: apiErr.message });
      }

      // 파일 트리 구조 구성
      const fileList = allFiles.map(f => ({
        id: f.id,
        name: f.name,
        path: f._path || f.name,
        size: parseInt(f.size || '0', 10),
        mimeType: f.mimeType,
        downloadUrl: `https://drive.google.com/uc?export=download&id=${f.id}`,
        webViewUrl: `https://drive.google.com/file/d/${f.id}/view`,
      }));

      res.json({ ok: true, folderId, files: fileList, folders: [], total: fileList.length });
    } catch (err) {
      console.error('[gdrive-folder]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Google Drive 파일 내용 다운로드 ──────────────────────
  app.post('/api/gdrive-download', async (req, res) => {
    const { fileId, fileName } = req.body;
    if (!validateString(fileId, 200)) {
      return res.status(400).json({ error: 'fileId 필요' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return res.status(400).json({ error: '잘못된 fileId 형식' });
    }

    const GDRIVE_API_KEY = process.env.GOOGLE_API_KEY;
    try {
      const downloadUrl = GDRIVE_API_KEY
        ? `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GDRIVE_API_KEY}`
        : `https://drive.google.com/uc?export=download&id=${fileId}`;

      const resp = await fetch(downloadUrl, {
        headers: GDRIVE_API_KEY ? {} : { 'Authorization': 'Bearer ' + (process.env.GDRIVE_ACCESS_TOKEN || '') },
        redirect: 'follow',
      });

      if (!resp.ok) {
        return res.status(400).json({ error: `파일 다운로드 실패: ${resp.status} ${resp.statusText}` });
      }

      const contentType = resp.headers.get('content-type') || '';
      const isText = contentType.startsWith('text/') ||
        contentType.includes('json') || contentType.includes('javascript') ||
        /\.(md|txt|json|js|ts|jsx|tsx|py|yaml|yml|html|css|sh|sql|java|go|rs|rb|php|swift|kt|vue|svelte|csv|log|conf|ini|toml|xml|prisma|graphql)$/i.test(fileName || '');

      if (!isText) {
        return res.status(400).json({ error: '텍스트/코드 파일만 지원합니다' });
      }

      const text = await resp.text();
      if (text.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: '파일 크기 5MB 초과' });
      }

      res.json({ ok: true, name: fileName || fileId, text });
    } catch (err) {
      console.error('[gdrive-download]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Dropbox 공유 폴더 파일 목록 조회 ─────────────────────
  app.post('/api/dropbox-folder', async (req, res) => {
    const { url } = req.body;
    if (!validateString(url, 500)) {
      return res.status(400).json({ error: 'url: Dropbox 공유 링크 필요' });
    }

    // Dropbox 공유 링크인지 확인
    if (!url.includes('dropbox.com')) {
      return res.status(400).json({ error: 'Dropbox 공유 링크가 아닙니다' });
    }

    const DROPBOX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;

    try {
      // Dropbox shared link metadata API
      const metaResp = await fetch('https://api.dropboxapi.com/2/sharing/get_shared_link_metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(DROPBOX_TOKEN ? { 'Authorization': `Bearer ${DROPBOX_TOKEN}` } : {}),
        },
        body: JSON.stringify({ url }),
      });
      const meta = await metaResp.json();

      if (meta.error || meta['error_summary']) {
        // 토큰 없이 공유 링크 파일 목록 조회 시도 (공개 공유 링크)
        const listResp = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(DROPBOX_TOKEN ? { 'Authorization': `Bearer ${DROPBOX_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            path: '',
            shared_link: { url },
            recursive: false,
          }),
        });
        const listData = await listResp.json();

        if (listData.error || listData['error_summary']) {
          const errMsg = listData['error_summary'] || 'Dropbox API 오류';
          if (errMsg.includes('not_a_folder') || errMsg.includes('not_found')) {
            return res.status(400).json({ error: 'Dropbox 폴더 공유 링크가 아니거나 접근할 수 없습니다' });
          }
          if (errMsg.includes('invalid_access_token') || errMsg.includes('expired_access_token')) {
            return res.status(401).json({ error: 'Dropbox 액세스 토큰이 필요합니다. 환경 변수 DROPBOX_ACCESS_TOKEN을 설정하세요.' });
          }
          return res.status(400).json({ error: errMsg });
        }

        // 폴더 공유 링크 기반 개별 파일 다운로드 URL 구성
        // Dropbox shared link + ?dl=1 for direct download (per-file path via path param)
        const folderShareBase = url.split('?')[0];
        const files = (listData.entries || []).filter(e => e['.tag'] === 'file').map(f => {
          // 파일 path_display를 이용해 개별 파일 공유 링크 구성 (sharing/get_shared_link_file 방식)
          // 또는 토큰 있을 경우 get_temporary_link URL 사용 예정 (아래 enrichment 단계)
          const filePath = f.path_display || ('/' + f.name);
          // Dropbox API: files/get_temporary_link (Bearer 토큰 필요)
          return {
            name: f.name,
            path: f.path_display || f.name,
            size: f.size || 0,
            id: f.id,
            _dropboxPath: filePath, // 임시 URL 생성용
          };
        });

        // 토큰이 있으면 각 파일의 임시 다운로드 URL 획득 (최대 20개, 성능 고려)
        if (DROPBOX_TOKEN && files.length > 0) {
          const BATCH_SIZE = 20;
          const batch = files.slice(0, BATCH_SIZE);
          await Promise.all(batch.map(async (f) => {
            try {
              const tmpResp = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${DROPBOX_TOKEN}`,
                },
                body: JSON.stringify({ path: f._dropboxPath }),
              });
              const tmpData = await tmpResp.json();
              if (tmpData.link) f.downloadUrl = tmpData.link;
            } catch { /* 실패 시 downloadUrl 없이 진행 */ }
          }));
        }

        // _dropboxPath를 dropboxPath로 노출 (폴백 다운로드용), sharedLinkUrl도 포함
        const cleanFiles = files.map(({ _dropboxPath, ...rest }) => ({
          ...rest,
          dropboxPath: _dropboxPath || null,
        }));
        return res.json({ ok: true, files: cleanFiles, total: cleanFiles.length, sharedLinkUrl: url });
      }

      res.json({ ok: true, type: meta['.tag'], name: meta.name, files: [], sharedLinkUrl: url });
    } catch (err) {
      console.error('[dropbox-folder]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Dropbox 파일 직접 다운로드 ───────────────────────────
  app.post('/api/dropbox-download', async (req, res) => {
    const { url, fileName } = req.body;
    if (!validateString(url, 500)) {
      return res.status(400).json({ error: 'url 필요' });
    }
    if (!url.includes('dropbox.com')) {
      return res.status(400).json({ error: 'Dropbox URL이 아닙니다' });
    }

    try {
      // ?dl=1 파라미터로 직접 다운로드
      const dlUrl = url.replace(/[?&]dl=0/, '').replace(/\?.*$/, '') + '?dl=1';
      const resp = await fetch(dlUrl, { redirect: 'follow' });

      if (!resp.ok) {
        return res.status(400).json({ error: `파일 다운로드 실패: ${resp.status}` });
      }

      const contentType = resp.headers.get('content-type') || '';
      const isText = contentType.startsWith('text/') ||
        contentType.includes('json') || contentType.includes('javascript') ||
        /\.(md|txt|json|js|ts|jsx|tsx|py|yaml|yml|html|css|sh|sql|java|go|rs|rb|php|swift|kt|vue|svelte|csv|log|conf|ini|toml|xml|prisma|graphql)$/i.test(fileName || '');

      if (!isText) {
        return res.status(400).json({ error: '텍스트/코드 파일만 지원합니다' });
      }

      const text = await resp.text();
      if (text.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: '파일 크기 5MB 초과' });
      }

      res.json({ ok: true, name: fileName || 'file', text });
    } catch (err) {
      console.error('[dropbox-download]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Dropbox 공유링크+경로 기반 파일 다운로드 (미인증 환경 폴백) ─────
  // Dropbox content API: https://content.dropboxapi.com/2/sharing/get_shared_link_file
  // 공개 공유 링크와 파일 상대 경로로 인증 없이 다운로드 가능
  app.post('/api/dropbox-download-by-path', async (req, res) => {
    const { sharedLinkUrl, filePath, fileName } = req.body;
    if (!validateString(sharedLinkUrl, 500)) {
      return res.status(400).json({ error: 'sharedLinkUrl 필요' });
    }
    if (!sharedLinkUrl.includes('dropbox.com')) {
      return res.status(400).json({ error: 'Dropbox 공유 링크가 아닙니다' });
    }
    if (!validateString(filePath, 1000)) {
      return res.status(400).json({ error: 'filePath 필요' });
    }

    const DROPBOX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
    try {
      // 방법 1: 토큰 있으면 files/get_temporary_link 사용 (가장 안정적)
      if (DROPBOX_TOKEN && filePath) {
        try {
          const tmpResp = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${DROPBOX_TOKEN}`,
            },
            body: JSON.stringify({ path: filePath }),
          });
          const tmpData = await tmpResp.json();
          if (tmpData.link) {
            const fileResp = await fetch(tmpData.link, { redirect: 'follow' });
            if (fileResp.ok) {
              const text = await fileResp.text();
              if (text.length > 5 * 1024 * 1024) {
                return res.status(400).json({ error: '파일 크기 5MB 초과' });
              }
              return res.json({ ok: true, name: fileName || filePath.split('/').pop(), text });
            }
          }
        } catch { /* 실패 시 다음 방법으로 */ }
      }

      // 방법 2: sharing/get_shared_link_file API (공개 공유 링크 + 경로)
      // Dropbox-API-Arg 헤더로 shared_link와 path를 전달
      const dropboxArg = JSON.stringify({
        url: sharedLinkUrl,
        path: filePath.startsWith('/') ? filePath : '/' + filePath,
      });

      const contentResp = await fetch('https://content.dropboxapi.com/2/sharing/get_shared_link_file', {
        method: 'POST',
        headers: {
          'Dropbox-API-Arg': dropboxArg,
          ...(DROPBOX_TOKEN ? { 'Authorization': `Bearer ${DROPBOX_TOKEN}` } : {}),
        },
      });

      if (!contentResp.ok) {
        const errText = await contentResp.text();
        return res.status(400).json({ error: `Dropbox 파일 다운로드 실패: ${contentResp.status} - ${errText.slice(0, 200)}` });
      }

      const contentType = contentResp.headers.get('content-type') || '';
      const effectiveName = fileName || filePath.split('/').pop() || 'file';
      const isText = contentType.startsWith('text/') ||
        contentType.includes('json') || contentType.includes('javascript') ||
        /\.(md|txt|json|js|ts|jsx|tsx|py|yaml|yml|html|css|sh|sql|java|go|rs|rb|php|swift|kt|vue|svelte|csv|log|conf|ini|toml|xml|prisma|graphql)$/i.test(effectiveName);

      if (!isText) {
        return res.status(400).json({ error: '텍스트/코드 파일만 지원합니다' });
      }

      const text = await contentResp.text();
      if (text.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: '파일 크기 5MB 초과' });
      }

      res.json({ ok: true, name: effectiveName, text });
    } catch (err) {
      console.error('[dropbox-download-by-path]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/deploy', (req, res) => {
    const harnessRoot = path.resolve(__dirname, '../..');
    const scriptPath = path.join(harnessRoot, 'scripts', 'deploy_detached.sh');

    if (!fs.existsSync(scriptPath)) {
      return res.status(500).json({ error: 'deploy_detached.sh 스크립트 없음' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = path.join(harnessRoot, 'logs');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* 무시 */ }

    const logPath = path.join(logDir, `deploy-${timestamp}.log`);

    let logFd;
    try {
      logFd = fs.openSync(logPath, 'w');
    } catch (err) {
      return res.status(500).json({ error: `로그 파일 생성 실패: ${err.message}` });
    }

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

    res.json({
      ok: true,
      message: '배포 프로세스 시작됨',
      logPath,
      note: '약 10초 후 harness가 재시작됩니다',
    });
  });

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
  agentRunner.on('task:deleted',   d => broadcast('task:deleted',   d));
  agentRunner.on('phase:start',    d => broadcast('phase:start',    d));
  agentRunner.on('phase:complete', d => broadcast('phase:complete', d));
  agentRunner.on('agent:text',     d => broadcast('agent:text',     d));
  agentRunner.on('agent:tool',     d => broadcast('agent:tool',     d));

  return { app, server: httpServer };
}
