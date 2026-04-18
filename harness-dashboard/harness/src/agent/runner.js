// src/agent/runner.js
// Claude Code CLI 래퍼 + Planner → Generator → Evaluator 파이프라인

import { EventEmitter } from 'events';
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { taskQueries, logQueries, projectQueries, deleteTask } from '../db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_CLI     = process.env.CLAUDE_CLI_PATH || 'claude';
const CLAUDE_MODEL   = process.env.CLAUDE_MODEL    || 'claude-sonnet-4-6';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '1', 10);
const MAX_ROUNDS     = parseInt(process.env.MAX_ROUNDS || '3', 10);

const ALLOWED_PROJECT_ROOTS = (process.env.PROJECTS_ROOT || '/Users/sun')
  .split(',').map(p => p.trim());

const PHASE = {
  PLAN:   'planning',
  BUILD:  'building',
  EVAL:   'evaluating',
  DONE:   'done',
  FAILED: 'failed',
  PAUSED: 'paused',
};

// ── JSON 추출 헬퍼 ────────────────────────────────────────
function parseJson(text) {
  const stripped = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let searchFrom = 0;
  while (true) {
    const start = stripped.indexOf('{', searchFrom);
    if (start === -1) break;
    let depth = 0, inStr = false, esc = false, foundEnd = false;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          foundEnd = true;
          try { return JSON.parse(stripped.slice(start, i + 1)); }
          catch { searchFrom = start + 1; break; }
        }
      }
    }
    if (!foundEnd) break;
  }
  throw new Error('유효한 JSON 객체 없음');
}

// ── AgentRunner ───────────────────────────────────────────
export class AgentRunner extends EventEmitter {
  constructor() {
    super();
    this._running = new Map(); // taskId → { process, phase, round }
    this._queue   = [];
    this._deleted = new Set();
  }

  // ── 공개 API ─────────────────────────────────────────────

  getStatus() {
    const running = [...this._running.entries()].map(([id, e]) => ({
      taskId: id, phase: e.phase, round: e.round,
    }));
    // index.js / server.js 양쪽 인터페이스 호환
    return {
      running,
      queue:       this._queue.length,
      queued:      this._queue.length,
      maxConcurrent: MAX_CONCURRENT,
      currentTask: running[0] || null,
    };
  }

  async run({ projectId, prompt, maxRounds }) {
    const project = await projectQueries.get(projectId);
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`);
    this._validateProjectPath(project.path);

    const activeTask = await taskQueries.getActiveForProject(projectId);
    if (activeTask) {
      throw new Error(`이미 실행 중인 task: ${activeTask.id} (${activeTask.status})`);
    }

    const effectiveMaxRounds = (typeof maxRounds === 'number' && maxRounds > 0)
      ? maxRounds : MAX_ROUNDS;

    const taskId = `task_${Date.now()}_${randomUUID().slice(0, 6)}`;
    await taskQueries.create({ id: taskId, project_id: projectId, prompt, max_rounds: effectiveMaxRounds });
    this.emit('task:created', { taskId, projectId });

    if (this._running.size >= MAX_CONCURRENT) {
      this._queue.push(taskId);
      this.emit('task:queued', { taskId, queueLength: this._queue.length });
      return taskId;
    }
    this._startPipeline(taskId);
    return taskId;
  }

  async resume(taskId) {
    const task = await taskQueries.get(taskId);
    if (!task) throw new Error(`작업 없음: ${taskId}`);
    if (task.status !== PHASE.PAUSED) throw new Error(`재개 불가 상태: ${task.status}`);
    if (this._running.size >= MAX_CONCURRENT) throw new Error('이미 실행 중인 작업이 있습니다');
    this.emit('task:resuming', { taskId });
    this._startPipeline(taskId);
  }

  async stop(taskId) {
    const entry = this._running.get(taskId);
    if (entry?.process) entry.process.kill('SIGTERM');
    await taskQueries.updateStatus(taskId, PHASE.PAUSED, { error: 'manual_stop' });
    this._running.delete(taskId);
    this.emit('task:paused', { task: { id: taskId }, taskId, phase: entry?.phase, round: entry?.round, reason: 'manual_stop' });
    this._drainQueue();
  }

  async deleteTask(taskId) {
    const task = await taskQueries.get(taskId);
    if (!task) throw new Error(`작업 없음: ${taskId}`);

    this._deleted.add(taskId);
    const entry = this._running.get(taskId);
    if (entry?.process) entry.process.kill('SIGTERM');
    this._running.delete(taskId);

    const qi = this._queue.indexOf(taskId);
    if (qi !== -1) this._queue.splice(qi, 1);

    await deleteTask(taskId);
    setTimeout(() => this._deleted.delete(taskId), 5000);
    this.emit('task:deleted', { taskId, projectId: task.project_id });
    this._drainQueue();
    return { taskId, projectId: task.project_id };
  }

  // ── 파이프라인 ────────────────────────────────────────────

  async _startPipeline(taskId) {
    let task      = await taskQueries.get(taskId);
    const project = await projectQueries.get(task.project_id);
    const safeCwd = this._validateProjectPath(project.path);

    if (!this._running.has(taskId)) {
      this._running.set(taskId, { process: null, phase: PHASE.PLAN, round: 0 });
    }

    console.log(`[pipeline] 시작: ${taskId}, project=${project.name}`);

    try {
      // ── Plan ────────────────────────────────────────────
      let plan = task.plan ? JSON.parse(task.plan) : null;
      if (!plan) plan = await this._runPlanner(task, project, safeCwd);
      if (this._deleted.has(taskId)) return;

      // ── Build → Eval 루프 ────────────────────────────────
      let evalResult = null;
      while (true) {
        if (this._deleted.has(taskId)) break;

        const current = await taskQueries.get(taskId);
        if (current.round >= current.max_rounds) break;

        const round       = current.round + 1;
        const isLastRound = round >= current.max_rounds;
        const prevEval    = current.eval_result ? JSON.parse(current.eval_result) : null;

        // Build
        await taskQueries.updateStatus(taskId, PHASE.BUILD);
        await taskQueries.incrementRound(taskId);
        this.emit('phase:start', { taskId, phase: PHASE.BUILD, round });
        const buildPrompt = round === 1
          ? this._buildGeneratorPrompt(plan, round, current.max_rounds)
          : this._buildRetryPrompt(plan, prevEval, round, current.max_rounds);
        await this._claudeRun({ taskId, phase: 'build', round, cwd: safeCwd, prompt: buildPrompt });
        if (this._deleted.has(taskId)) break;
        this.emit('phase:complete', { taskId, phase: PHASE.BUILD, round });

        // Eval
        await taskQueries.updateStatus(taskId, PHASE.EVAL);
        this.emit('phase:start', { taskId, phase: PHASE.EVAL, round });
        evalResult = await this._runEvaluator(task, project, plan, round, safeCwd);
        if (this._deleted.has(taskId)) break;
        this.emit('phase:complete', { taskId, phase: PHASE.EVAL, round });
        await taskQueries.updateStatus(taskId, PHASE.EVAL, { eval_result: JSON.stringify(evalResult) });

        const passed = this._isEvalPassed(evalResult);
        console.log(`[pipeline] eval: passed=${passed}, score=${evalResult?.score}`);

        if (passed) {
          await this._runCommitAndDeploy(task, project, plan, round, safeCwd).catch(err => {
            console.error(`[pipeline] commit/deploy 오류 (무시):`, err.message);
          });
          await taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', {
            taskId, task, projectId: task.project_id,
            round, evalResult, maxRoundsReached: false,
            unresolvedIssues: 0, deployFailed: false,
          });
          return;
        }

        if (isLastRound) {
          const unresolvedIssues = Array.isArray(evalResult?.issues) ? evalResult.issues.length : null;
          await taskQueries.updateDeploy(taskId, 'skipped:eval_failed');
          await taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', {
            taskId, task, projectId: task.project_id,
            round, evalResult, maxRoundsReached: true, unresolvedIssues,
          });
          return;
        }
      }
    } catch (err) {
      if (this._deleted.has(taskId)) return;
      if (err.message === 'RATE_LIMIT') {
        await taskQueries.updateStatus(taskId, PHASE.PAUSED);
        this.emit('task:paused', { task: { id: taskId }, taskId, reason: 'rate_limit' });
      } else {
        const safeErr = err.message.replace(/\/Users\/[^\s]+/g, '[path]');
        await taskQueries.updateStatus(taskId, PHASE.FAILED, { error: safeErr });
        this.emit('task:failed', { task: { id: taskId }, taskId, projectId: task?.project_id, error: safeErr });
      }
    } finally {
      this._running.delete(taskId);
      this._drainQueue();
    }
  }

  // ── Planner ───────────────────────────────────────────────

  async _runPlanner(task, project, safeCwd) {
    await taskQueries.updateStatus(task.id, PHASE.PLAN);
    this.emit('phase:start', { taskId: task.id, phase: PHASE.PLAN, round: 0 });

    const prompt = [
      '[지시사항] 당신은 소프트웨어 프로젝트 플래너입니다.',
      '사용자 요청을 분석하여 구체적인 구현 계획을 JSON으로 반환하세요.',
      `프로젝트: ${project.name} (${project.stack || '미지정'})`,
      '코드블록 없이 순수 JSON만 반환하세요:',
      '{"title":"작업 제목","summary":"한 줄 요약","features":["기능1"],"files_to_modify":["파일"],"acceptance_criteria":["완료 기준1"],"tech_notes":"주의사항"}',
      '',
      '[작업 요청]',
      task.prompt,
    ].join('\n');

    const output = await this._claudeRun({ taskId: task.id, phase: 'plan', round: 0, cwd: safeCwd, prompt });

    let plan;
    try {
      plan = parseJson(output);
      if (!plan.title)   plan.title   = task.prompt.slice(0, 100);
      if (!plan.summary) plan.summary = plan.title;
      if (!Array.isArray(plan.features))            plan.features            = [];
      if (!Array.isArray(plan.acceptance_criteria)) plan.acceptance_criteria = [];
    } catch {
      plan = { title: task.prompt.slice(0, 100), summary: output.slice(0, 200), features: [], acceptance_criteria: [] };
    }

    await taskQueries.updateStatus(task.id, PHASE.PLAN, { plan: JSON.stringify(plan) });
    this.emit('phase:complete', { taskId: task.id, phase: PHASE.PLAN, round: 0 });
    return plan;
  }

  // ── Evaluator ─────────────────────────────────────────────

  async _runEvaluator(task, project, plan, round, safeCwd) {
    const criteria = (plan.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n');
    const prompt = [
      '[지시사항] 당신은 코드 품질 평가자입니다. 실제 파일을 읽고 평가하세요.',
      '',
      '[평가 절차]',
      '1. ls, cat으로 파일 구조 파악',
      '2. 완료 기준과 관련된 파일을 직접 읽어서 구현 여부 확인',
      '3. 모든 분석 후 마지막 줄에 아래 JSON 한 줄만 출력',
      '',
      '[응답 형식 — 마지막 줄에 JSON만]',
      '{"score":85,"passed":true,"issues":[],"suggestions":"개선 방향","summary":"한줄요약"}',
      '',
      '규칙:',
      '- passed=true: 모든 완료 기준 충족 AND score >= 80',
      '- issues: 미구현·부분 구현 항목만 (충족된 항목 제외)',
      '- score: 0~100 정수',
      '',
      `[평가 대상] ${plan.title || plan.summary}`,
      '',
      '[완료 기준]',
      criteria,
    ].join('\n');

    const output = await this._claudeRun({ taskId: task.id, phase: 'eval', round, cwd: safeCwd, prompt });

    try { return parseJson(output); }
    catch {
      // 부분 파싱 폴백
      const scoreM   = output.match(/"score"\s*:\s*(\d+)/);
      const passedM  = output.match(/"passed"\s*:\s*(true|false)/);
      const score    = scoreM  ? parseInt(scoreM[1],  10) : 0;
      const passed   = passedM ? passedM[1] === 'true'   : false;
      return { score, passed, issues: passed ? [] : ['평가 결과 파싱 실패'], suggestions: '', summary: '' };
    }
  }

  _isEvalPassed(evalResult) {
    if (!evalResult || evalResult.passed !== true || (evalResult.score ?? 0) < 80) return false;
    if (Array.isArray(evalResult.issues)) {
      const real = evalResult.issues.filter(x => x && typeof x === 'string' && x.trim());
      if (real.length > 0) return false;
    }
    return true;
  }

  // ── 커밋 & 배포 ───────────────────────────────────────────

  async _runCommitAndDeploy(task, project, plan, round, safeCwd) {
    this.emit('phase:start', { taskId: task.id, phase: 'deploying', round });
    const commitMsg = `feat: ${plan.title || task.prompt.slice(0, 60)} (task=${task.id}, round=${round})`;

    const harnessAbsPath = fs.realpathSync(path.resolve(__dirname, '../..'));
    const safeCwdReal    = fs.existsSync(safeCwd) ? fs.realpathSync(safeCwd) : safeCwd;

    const getGitRoot = (cwd) => {
      const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
      return (r.status === 0) ? (r.stdout || '').trim() : null;
    };

    const doCommit = async (label, gitRoot, stageTarget) => {
      const addR = spawnSync('git', ['add', '--', stageTarget], { cwd: gitRoot, encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
      if (addR.status !== 0) {
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error', content: `[${label}] git add 실패: ${addR.stderr}` });
        return null;
      }

      const stagedR = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: gitRoot, encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      if (!(stagedR.stdout || '').trim()) {
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[${label}] nothing staged` });
        return null;
      }

      const commitR = spawnSync('git', ['commit', '-m', commitMsg], { cwd: gitRoot, encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
      if (commitR.status !== 0) {
        const msg = (commitR.stderr || commitR.stdout || '').trim();
        if (msg.includes('nothing to commit')) return null;
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error', content: `[${label}] commit 실패: ${msg}` });
        return null;
      }

      const shaR = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      const sha  = (shaR.stdout || '').trim();
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[${label}] commit ${sha}` });

      const pushR = spawnSync('git', ['push'], { cwd: gitRoot, encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
      await logQueries.append({
        task_id: task.id, phase: 'deploy', round,
        level: pushR.status === 0 ? 'info' : 'error',
        content: `[${label}] push ${pushR.status === 0 ? 'ok' : 'failed'}: ${(pushR.stderr || pushR.stdout || '').trim()}`,
      });
      return sha;
    };

    const harnessGitRoot = getGitRoot(harnessAbsPath);
    const projectGitRoot = getGitRoot(safeCwdReal);
    const sameRepo       = harnessGitRoot && projectGitRoot && harnessGitRoot === projectGitRoot;

    let commitSha = null;
    if (sameRepo) {
      const sha = await doCommit('repo', harnessGitRoot, '.');
      if (sha) { commitSha = sha; await taskQueries.updateCommit(task.id, sha); }
    } else {
      if (harnessGitRoot) {
        const rel = path.relative(harnessGitRoot, harnessAbsPath);
        if (!rel.startsWith('..')) {
          const sha = await doCommit('harness', harnessGitRoot, rel || '.');
          if (sha) { commitSha = sha; await taskQueries.updateCommit(task.id, sha); }
        }
      }
      if (projectGitRoot) {
        const rel = path.relative(projectGitRoot, safeCwdReal);
        if (!rel.startsWith('..')) {
          const sha = await doCommit('project', projectGitRoot, rel || '.');
          if (sha && !commitSha) { commitSha = sha; await taskQueries.updateCommit(task.id, sha); }
        }
      }
    }

    // 배포 스크립트 탐색 & 실행
    const deployScript = _findDeployScript(safeCwd, harnessAbsPath);
    if (!deployScript) {
      await taskQueries.updateDeploy(task.id, 'skipped:no_script');
      this.emit('phase:complete', { taskId: task.id, phase: 'deploying', round });
      return 'skipped:no_script';
    }

    const deployArgs = deployScript.cmd.split(/\s+/);
    const deployR    = spawnSync(deployArgs[0], deployArgs.slice(1), {
      cwd: deployScript.cwd, encoding: 'utf8', timeout: 120000, stdio: 'pipe',
    });
    const deployOk = deployR.status === 0;
    await taskQueries.updateDeploy(task.id, deployOk ? 'success' : 'failed');
    await logQueries.append({
      task_id: task.id, phase: 'deploy', round,
      level: deployOk ? 'info' : 'error',
      content: `[deploy] ${deployOk ? 'success' : 'failed'}: ${(deployR.stdout || deployR.stderr || '').trim().slice(0, 500)}`,
    });

    this.emit('phase:complete', { taskId: task.id, phase: 'deploying', round });
    return deployOk ? 'success' : 'deploy_failed';
  }

  // ── 프롬프트 빌더 ─────────────────────────────────────────

  _buildGeneratorPrompt(plan, round, maxRounds) {
    return [
      '다음 계획에 따라 코드를 구현하세요.',
      `## 작업\n${plan.title}`,
      `## 기능\n${(plan.features || []).map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
      `## 완료 기준\n${(plan.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      `## 주의사항\n${plan.tech_notes || '없음'}`,
      `Round ${round}/${maxRounds} — 모든 완료 기준을 이 라운드에서 충족하세요.`,
      '⚠️ git commit이나 배포는 실행하지 마세요. 구현만 완료하세요.',
    ].join('\n\n');
  }

  _buildRetryPrompt(plan, prevEval, round, maxRounds) {
    const issues = (prevEval?.issues || []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '없음';
    return [
      `이전 구현에 문제가 있습니다. Round ${round}/${maxRounds} 재시도합니다.`,
      `## 원래 작업\n${plan.title}`,
      `## 완료 기준\n${(plan.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      `## 이전 평가 (Round ${round - 1})\n점수: ${prevEval?.score ?? '?'}/100`,
      `## 반드시 해결할 미충족 항목\n${issues}`,
      `## 개선 제안\n${prevEval?.suggestions || '없음'}`,
      '위 항목을 모두 해결하세요. 하나도 건너뛰지 마세요.',
      '⚠️ git commit이나 배포는 실행하지 마세요. 구현만 완료하세요.',
    ].join('\n\n');
  }

  // ── Claude Code CLI 실행 ──────────────────────────────────

  _claudeRun({ taskId, phase, round, cwd, prompt }) {
    return new Promise((resolve, reject) => {
      if (this._deleted.has(taskId)) { resolve(''); return; }

      const entry = this._running.get(taskId) || { process: null, phase, round };
      entry.phase = phase;
      entry.round = round;
      this._running.set(taskId, entry);

      const args = [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--model', CLAUDE_MODEL,
        '--dangerously-skip-permissions',
        '--setting-sources', 'user',
        prompt,
      ];

      const proc = spawn(CLAUDE_CLI, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.process = proc;

      let finalResult    = null;
      let assistantTexts = [];
      let buffer         = '';
      let rateLimit      = false;

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._handleStreamMsg(taskId, phase, round, msg,
              (t) => assistantTexts.push(t),
              (r) => { finalResult = r; }
            );
          } catch { /* 무시 */ }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (!rateLimit && (text.includes('rate limit') || text.includes('429') || text.includes('usage limit'))) {
          rateLimit = true;
          reject(new Error('RATE_LIMIT'));
        }
        logQueries.append({ task_id: taskId, phase, round, level: 'error', content: text.slice(0, 500) });
      });

      proc.on('close', (code) => {
        const output = (finalResult?.trim()) ? finalResult : assistantTexts.join('\n').trim();
        if (rateLimit) return;
        if (this._deleted.has(taskId)) { resolve(output); return; }
        if (code !== 0 && !output) reject(new Error(`Claude CLI 종료 code=${code}`));
        else resolve(output);
      });

      proc.on('error', (err) => reject(new Error(`Claude CLI 실행 실패: ${err.message}`)));
    });
  }

  _handleStreamMsg(taskId, phase, round, msg, onText, onResult) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          logQueries.append({ task_id: taskId, phase, round, level: 'info', content: block.text });
          this.emit('agent:text',  { taskId, phase, round, content: block.text });
          onText(block.text);
        } else if (block.type === 'tool_use') {
          logQueries.append({ task_id: taskId, phase, round, level: 'tool', content: `[tool: ${block.name}]` });
          this.emit('agent:tool', { taskId, phase, round, tool: block.name });
        }
      }
    } else if (msg.type === 'result' && !msg.is_error && msg.result != null) {
      const r = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result);
      if (r.trim()) onResult(r);
    }
  }

  // ── 내부 유틸 ─────────────────────────────────────────────

  _validateProjectPath(projectPath) {
    const resolved = path.resolve(projectPath);
    const allowed  = ALLOWED_PROJECT_ROOTS.some(root => resolved.startsWith(path.resolve(root)));
    if (!allowed) throw new Error(`허용되지 않은 경로: ${projectPath}`);
    return resolved;
  }

  _drainQueue() {
    while (this._queue.length > 0 && this._running.size < MAX_CONCURRENT) {
      const nextId = this._queue.shift();
      this.emit('task:dequeued', { taskId: nextId });
      this._startPipeline(nextId);
    }
  }
}

// ── 배포 스크립트 탐색 ────────────────────────────────────
function _findDeployScript(cwd, harnessAbsPath) {
  const dirs = [cwd, harnessAbsPath].filter(Boolean).filter((d, i, a) => a.indexOf(d) === i);
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, 'deploy.sh'))) return { cmd: 'bash deploy.sh', cwd: dir };
    const mkf = path.join(dir, 'Makefile');
    if (fs.existsSync(mkf) && /^deploy:/m.test(fs.readFileSync(mkf, 'utf8').catch?.() || fs.readFileSync(mkf, 'utf8')))
      return { cmd: 'make deploy', cwd: dir };
    if (fs.existsSync(path.join(dir, 'ecosystem.config.js')))
      return { cmd: 'pm2 reload ecosystem.config.js --update-env', cwd: dir };
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        if (p.scripts?.deploy) return { cmd: 'npm run deploy', cwd: dir };
      } catch { /* 무시 */ }
    }
  }
  return null;
}
