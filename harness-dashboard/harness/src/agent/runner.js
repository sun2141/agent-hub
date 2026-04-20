// src/agent/runner.js
// Claude Code CLI 래퍼 + Planner → Generator → Evaluator 파이프라인

import { EventEmitter } from 'events';
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
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

export class AgentRunner extends EventEmitter {
  constructor() {
    super();
    this._running = new Map();
    this._queue   = [];
    this._deleted = new Set();
  }

  getStatus() {
    const running = [...this._running.entries()].map(([id, e]) => ({
      taskId: id, phase: e.phase, round: e.round,
    }));
    return {
      running,
      queue:         this._queue.length,
      queued:        this._queue.length,
      maxConcurrent: MAX_CONCURRENT,
      currentTask:   running[0] || null,
    };
  }

  async run({ projectId, prompt, maxRounds, attachments }) {
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

    // 첨부 파일을 임시 디렉토리에 저장 (this._attachments Map에 보관)
    if (attachments?.length) {
      this._saveAttachments(taskId, attachments);
    }

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
    this._cleanupAttachments(taskId);
    setTimeout(() => this._deleted.delete(taskId), 5000);
    this.emit('task:deleted', { taskId, projectId: task.project_id });
    this._drainQueue();
    return { taskId, projectId: task.project_id };
  }

  async _startPipeline(taskId) {
    let task      = await taskQueries.get(taskId);
    const project = await projectQueries.get(task.project_id);
    const safeCwd = this._validateProjectPath(project.path);

    // 첨부 파일 경로 불러오기
    const attachmentPaths = this._attachments?.get(taskId) || [];

    if (!this._running.has(taskId)) {
      this._running.set(taskId, { process: null, phase: PHASE.PLAN, round: 0 });
    }

    console.log(`[pipeline] 시작: ${taskId}, project=${project.name}, attachments=${attachmentPaths.length}`);

    try {
      let plan = task.plan ? JSON.parse(task.plan) : null;
      if (!plan) plan = await this._runPlanner(task, project, safeCwd, attachmentPaths);
      if (this._deleted.has(taskId)) return;

      let evalResult = null;
      while (true) {
        if (this._deleted.has(taskId)) break;

        const current     = await taskQueries.get(taskId);
        if (current.round >= current.max_rounds) break;

        const round       = current.round + 1;
        const isLastRound = round >= current.max_rounds;
        const prevEval    = current.eval_result ? JSON.parse(current.eval_result) : null;

        // Build
        await taskQueries.updateStatus(taskId, PHASE.BUILD);
        await taskQueries.incrementRound(taskId);
        this.emit('phase:start', { taskId, phase: PHASE.BUILD, round });
        let buildPrompt, imageAttachments = [];
        if (round === 1) {
          const result = this._buildGeneratorPrompt(plan, round, current.max_rounds, attachmentPaths);
          buildPrompt = result.prompt;
          imageAttachments = result.imageAttachments;
        } else {
          buildPrompt = this._buildRetryPrompt(plan, prevEval, round, current.max_rounds);
        }
        await this._claudeRun({ taskId, phase: 'build', round, cwd: safeCwd, prompt: buildPrompt, imageAttachments });
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
            round, evalResult, maxRoundsReached: false, unresolvedIssues: 0,
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
      // 첨부 파일 임시 디렉토리 정리
      this._cleanupAttachments(taskId);
      this._drainQueue();
    }
  }

  async _runPlanner(task, project, safeCwd, attachmentPaths = []) {
    await taskQueries.updateStatus(task.id, PHASE.PLAN);
    this.emit('phase:start', { taskId: task.id, phase: PHASE.PLAN, round: 0 });

    const lines = [
      '[지시사항] 당신은 소프트웨어 프로젝트 플래너입니다.',
      '사용자 요청을 분석하여 구체적인 구현 계획을 JSON으로 반환하세요.',
      `프로젝트: ${project.name} (${project.stack || '미지정'})`,
      '코드블록 없이 순수 JSON만 반환하세요:',
      '{"title":"작업 제목","summary":"한 줄 요약","features":["기능1"],"files_to_modify":["파일"],"acceptance_criteria":["완료 기준1"],"tech_notes":"주의사항"}',
      '',
      '[작업 요청]',
      task.prompt,
    ];

    // 첨부 파일 컨텍스트 추가 (텍스트 파일은 텍스트에 포함, 이미지는 vision block으로 전달)
    const planImageAttachments = [];
    if (attachmentPaths.length) {
      lines.push('');
      lines.push('[첨부 파일 컨텍스트]');
      lines.push('다음 파일들이 작업 컨텍스트로 제공됩니다:');
      for (const ap of attachmentPaths) {
        if (ap.type === 'image') {
          lines.push(`- 이미지 파일 "${ap.name}": 아래에 첨부된 이미지를 참조하세요.`);
          planImageAttachments.push(ap);
        } else if (ap.type === 'text') {
          lines.push(`- 텍스트 파일: ${ap.name} (내용은 아래 포함됨)`);
          lines.push('```');
          lines.push(ap.content || '');
          lines.push('```');
        }
      }
    }

    const prompt = lines.join('\n');
    const output = await this._claudeRun({ taskId: task.id, phase: 'plan', round: 0, cwd: safeCwd, prompt, imageAttachments: planImageAttachments });

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
      const scoreM  = output.match(/"score"\s*:\s*(\d+)/);
      const passedM = output.match(/"passed"\s*:\s*(true|false)/);
      const score   = scoreM  ? parseInt(scoreM[1], 10) : 0;
      const passed  = passedM ? passedM[1] === 'true'  : false;
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

  async _runCommitAndDeploy(task, project, plan, round, safeCwd) {
    this.emit('phase:start', { taskId: task.id, phase: 'deploying', round });
    const commitMsg  = `feat: ${plan.title || task.prompt.slice(0, 60)} (task=${task.id}, round=${round})`;
    const harnessAbs = fs.realpathSync(path.resolve(__dirname, '../..'));
    const cwdReal    = fs.existsSync(safeCwd) ? fs.realpathSync(safeCwd) : safeCwd;

    const getGitRoot = (cwd) => {
      const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
      return r.status === 0 ? (r.stdout || '').trim() : null;
    };

    const doCommit = async (label, gitRoot, stageTarget) => {
      spawnSync('git', ['add', '--', stageTarget], { cwd: gitRoot, encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
      const stagedR = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: gitRoot, encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      if (!(stagedR.stdout || '').trim()) return null;
      const commitR = spawnSync('git', ['commit', '-m', commitMsg], { cwd: gitRoot, encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
      if (commitR.status !== 0) return null;
      const shaR = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      const sha = (shaR.stdout || '').trim();
      spawnSync('git', ['push'], { cwd: gitRoot, encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[${label}] commit ${sha}` });
      return sha;
    };

    const hGit = getGitRoot(harnessAbs);
    const pGit = getGitRoot(cwdReal);
    const same = hGit && pGit && hGit === pGit;

    let sha = null;
    if (same) {
      sha = await doCommit('repo', hGit, '.');
    } else {
      if (hGit) {
        const rel = path.relative(hGit, harnessAbs);
        if (!rel.startsWith('..')) sha = await doCommit('harness', hGit, rel || '.');
      }
      if (pGit) {
        const rel = path.relative(pGit, cwdReal);
        if (!rel.startsWith('..')) {
          const s = await doCommit('project', pGit, rel || '.');
          if (s && !sha) sha = s;
        }
      }
    }
    if (sha) await taskQueries.updateCommit(task.id, sha);

    await taskQueries.updateDeploy(task.id, 'skipped:no_script');
    this.emit('phase:complete', { taskId: task.id, phase: 'deploying', round });
    return 'skipped:no_script';
  }

  _buildGeneratorPrompt(plan, round, maxRounds, attachmentPaths = []) {
    const parts = [
      '다음 계획에 따라 코드를 구현하세요.',
      `## 작업\n${plan.title}`,
      `## 기능\n${(plan.features || []).map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
      `## 완료 기준\n${(plan.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      `## 주의사항\n${plan.tech_notes || '없음'}`,
    ];

    // 이미지 첨부 파일: vision content block으로 별도 반환 (텍스트 안내만 포함)
    const imageAttachments = [];
    if (attachmentPaths.length) {
      const attLines = ['## 첨부 파일 컨텍스트'];
      for (const ap of attachmentPaths) {
        if (ap.type === 'image') {
          // 이미지는 vision block으로 전달되므로 텍스트에는 참조 안내만
          attLines.push(`- 이미지 파일 "${ap.name}": 아래에 첨부된 이미지를 참조하세요.`);
          imageAttachments.push(ap);
        } else if (ap.type === 'text') {
          attLines.push(`- 텍스트 파일 (${ap.name}):\n\`\`\`\n${ap.content || ''}\n\`\`\``);
        }
      }
      if (attLines.length > 1) parts.push(attLines.join('\n'));
    }

    parts.push(
      `Round ${round}/${maxRounds} — 모든 완료 기준을 이 라운드에서 충족하세요.`,
      '⚠️ git commit이나 배포는 실행하지 마세요. 구현만 완료하세요.',
    );

    return { prompt: parts.join('\n\n'), imageAttachments };
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
  // --setting-sources user 제거: CLAUDE_CONFIG_DIR(인증된 harness .claude)을 직접 사용
  // hasTrustDialogAccepted는 CLAUDE_CONFIG_DIR의 .claude.json projects에 true로 설정 필요

  _claudeRun({ taskId, phase, round, cwd, prompt, imageAttachments = [] }) {
    return new Promise((resolve, reject) => {
      if (this._deleted.has(taskId)) { resolve(''); return; }

      const entry = this._running.get(taskId) || { process: null, phase, round };
      entry.phase = phase;
      entry.round = round;
      this._running.set(taskId, entry);

      // 이미지 첨부 파일이 있으면 stream-json 입력 방식으로 vision content block 전달
      const hasImages = imageAttachments.length > 0;

      let args;
      if (hasImages) {
        args = [
          '--print',
          '--verbose',
          '--output-format', 'stream-json',
          '--input-format', 'stream-json',
          '--model', CLAUDE_MODEL,
          '--dangerously-skip-permissions',
        ];
      } else {
        args = [
          '--print',
          '--verbose',
          '--output-format', 'stream-json',
          '--model', CLAUDE_MODEL,
          '--dangerously-skip-permissions',
          prompt,
        ];
      }

      // CLAUDE_CONFIG_DIR 명시 (인증된 harness/.claude 디렉토리)
      const spawnEnv = {
        ...process.env,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      };

      console.log(`[CLI spawn:${phase}] round=${round} cwd=${cwd} hasImages=${hasImages}`);

      const proc = spawn(CLAUDE_CLI, args, {
        cwd,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      entry.process = proc;

      // 이미지 첨부 파일이 있으면 stream-json 형식으로 stdin에 전달
      if (hasImages) {
        // content 배열: 텍스트 + 이미지 블록들
        const contentBlocks = [];

        // 먼저 텍스트 프롬프트 추가
        contentBlocks.push({ type: 'text', text: prompt });

        // 이미지 블록 추가 (base64 인코딩)
        for (const imgAtt of imageAttachments) {
          try {
            const imageData = fs.readFileSync(imgAtt.path);
            const base64Data = imageData.toString('base64');
            const mediaType = imgAtt.mimeType || 'image/jpeg';
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data,
              },
            });
            console.log(`[CLI vision] 이미지 첨부: ${imgAtt.name} (${Math.round(imageData.length / 1024)}KB)`);
          } catch (err) {
            console.error(`[CLI vision] 이미지 읽기 실패: ${err.message}`);
            // 이미지 읽기 실패 시 경로 텍스트로 대체
            contentBlocks.push({ type: 'text', text: `[이미지 첨부 실패: ${imgAtt.name}]` });
          }
        }

        // stream-json 형식으로 user 메시지 전송
        const streamMsg = JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: contentBlocks,
          },
        });

        proc.stdin.write(streamMsg + '\n');
        proc.stdin.end();
      } else {
        // 이미지 없는 경우 stdin 닫기
        proc.stdin.end();
      }

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
        console.error(`[CLI stderr:${phase}] ${text.trim()}`);
        if (!rateLimit && (text.includes('rate limit') || text.includes('429') || text.includes('usage limit'))) {
          rateLimit = true;
          reject(new Error('RATE_LIMIT'));
        }
        logQueries.append({ task_id: taskId, phase, round, level: 'error', content: text.slice(0, 500) });
      });

      proc.on('close', (code) => {
        const output = (finalResult?.trim()) ? finalResult : assistantTexts.join('\n').trim();
        console.log(`[CLI close:${phase}] code=${code} outputLen=${output.length}`);
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
          this.emit('agent:text', { taskId, phase, round, text: block.text });
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

  // 첨부 파일을 임시 디렉토리에 저장하고 경로 정보 반환
  _saveAttachments(taskId, attachments) {
    const tmpDir = path.join(os.tmpdir(), `harness-attach-${taskId}`);
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* 무시 */ }

    const paths = [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      if (att.type === 'image') {
        const ext  = att.mimeType === 'image/png'  ? '.png'
                   : att.mimeType === 'image/gif'  ? '.gif'
                   : att.mimeType === 'image/webp' ? '.webp'
                   : '.jpg';
        const fileName = `attachment_${i}${ext}`;
        const filePath = path.join(tmpDir, fileName);
        try {
          fs.writeFileSync(filePath, Buffer.from(att.data, 'base64'));
          paths.push({ type: 'image', name: att.name, path: filePath, mimeType: att.mimeType || 'image/jpeg' });
        } catch (err) {
          console.error(`[attachments] 이미지 저장 실패: ${err.message}`);
        }
      } else if (att.type === 'text') {
        const fileName = `attachment_${i}_${path.basename(att.name || 'file.txt').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const filePath = path.join(tmpDir, fileName);
        try {
          fs.writeFileSync(filePath, att.text || '', 'utf8');
          paths.push({ type: 'text', name: att.name, path: filePath, content: (att.text || '').slice(0, 8000) });
        } catch (err) {
          console.error(`[attachments] 텍스트 저장 실패: ${err.message}`);
        }
      }
    }

    this._attachments = this._attachments || new Map();
    this._attachments.set(taskId, paths);
    return paths;
  }

  // 첨부 파일 임시 디렉토리 정리
  _cleanupAttachments(taskId) {
    if (!this._attachments?.has(taskId)) return;
    const paths = this._attachments.get(taskId);
    this._attachments.delete(taskId);
    if (!paths.length) return;
    const tmpDir = path.dirname(paths[0].path);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }
  }

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

function _findDeployScript(cwd, harnessAbsPath) {
  const dirs = [cwd, harnessAbsPath].filter(Boolean).filter((d, i, a) => a.indexOf(d) === i);
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, 'deploy.sh'))) return { cmd: 'bash deploy.sh', cwd: dir };
    const mkf = path.join(dir, 'Makefile');
    if (fs.existsSync(mkf)) {
      try {
        if (/^deploy:/m.test(fs.readFileSync(mkf, 'utf8'))) return { cmd: 'make deploy', cwd: dir };
      } catch { /* 무시 */ }
    }
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
