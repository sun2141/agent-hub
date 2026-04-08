// src/agent/runner.js
// Claude Code CLI 래퍼 + Planner→Generator→Evaluator 파이프라인

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { taskQueries, logQueries, projectQueries } from '../db/db.js';

const CLAUDE_CLI   = process.env.CLAUDE_CLI_PATH || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '2', 10);
const MAX_ROUNDS     = parseInt(process.env.MAX_EVAL_ROUNDS || '3', 10);

const ALLOWED_PROJECT_ROOTS = (process.env.PROJECTS_ROOT || '/Users/sun')
  .split(',')
  .map(p => p.trim());

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
  const m = stripped.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : stripped);
}

export class AgentRunner extends EventEmitter {
  constructor() {
    super();
    this._running = new Map();
    this._queue   = [];
  }

  _validateProjectPath(projectPath) {
    const resolved = path.resolve(projectPath);
    const allowed  = ALLOWED_PROJECT_ROOTS.some(root =>
      resolved.startsWith(path.resolve(root))
    );
    if (!allowed) throw new Error(`허용되지 않은 프로젝트 경로: ${projectPath}`);
    return resolved;
  }

  async run({ projectId, prompt, maxRounds = MAX_ROUNDS }) {
    const project = await projectQueries.get(projectId);
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`);
    this._validateProjectPath(project.path);

    const taskId = `task_${Date.now()}_${randomUUID().slice(0, 6)}`;
    await taskQueries.create({ id: taskId, project_id: projectId, prompt, max_rounds: maxRounds });
    this.emit('task:created', { taskId, projectId });

    if (this._running.size >= MAX_CONCURRENT) {
      this._queue.push(taskId);
      this.emit('task:queued', { taskId });
      return taskId;
    }
    this._startPipeline(taskId);
    return taskId;
  }

  async resume(taskId) {
    const task = await taskQueries.get(taskId);
    if (!task) throw new Error(`작업 없음: ${taskId}`);
    if (task.status !== PHASE.PAUSED) throw new Error(`재개 불가 상태: ${task.status}`);
    this.emit('task:resuming', { taskId });
    this._startPipeline(taskId);
  }

  async stop(taskId) {
    const entry = this._running.get(taskId);
    if (entry?.process) entry.process.kill('SIGTERM');
    await taskQueries.updateStatus(taskId, PHASE.PAUSED, { error: 'manual_stop' });
    this._running.delete(taskId);
    this.emit('task:paused', { taskId, reason: 'manual_stop' });
  }

  getStatus() {
    const running = [...this._running.entries()].map(([id, e]) => ({
      taskId: id, phase: e.phase, round: e.round,
    }));
    return { running, queued: this._queue.length, maxConcurrent: MAX_CONCURRENT };
  }

  async _startPipeline(taskId) {
    const task    = await taskQueries.get(taskId);
    const project = await projectQueries.get(task.project_id);
    const safeCwd = this._validateProjectPath(project.path);

    try {
      let plan = task.plan ? JSON.parse(task.plan) : null;
      if (!plan) plan = await this._runPlanner(task, project, safeCwd);

      let round = task.round || 0;
      while (round < task.max_rounds) {
        round++;
        await taskQueries.updateStatus(taskId, PHASE.BUILD);
        await taskQueries.incrementRound(taskId);
        this.emit('phase:start', { taskId, phase: PHASE.BUILD, round });
        await this._runGenerator(task, project, plan, round, safeCwd);
        this.emit('phase:complete', { taskId, phase: PHASE.BUILD, round });

        await taskQueries.updateStatus(taskId, PHASE.EVAL);
        this.emit('phase:start', { taskId, phase: PHASE.EVAL, round });
        const evalResult = await this._runEvaluator(task, project, plan, round, safeCwd);
        this.emit('phase:complete', { taskId, phase: PHASE.EVAL, round });
        await taskQueries.updateStatus(taskId, PHASE.EVAL, { eval_result: JSON.stringify(evalResult) });

        if (evalResult.passed || round >= task.max_rounds) {
          await taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', { taskId, round, evalResult, maxRoundsReached: !evalResult.passed && round >= task.max_rounds });
          break;
        }
      }
    } catch (err) {
      if (err.message === 'RATE_LIMIT') {
        await taskQueries.updateStatus(taskId, PHASE.PAUSED);
        this.emit('task:paused', { taskId, reason: 'rate_limit' });
      } else {
        const safeError = err.message.replace(/\/Users\/[^\s]+/g, '[path]');
        await taskQueries.updateStatus(taskId, PHASE.FAILED, { error: safeError });
        this.emit('task:failed', { taskId, error: safeError });
      }
    } finally {
      this._running.delete(taskId);
      this._drainQueue();
    }
  }

  async _runPlanner(task, project, safeCwd) {
    await taskQueries.updateStatus(task.id, PHASE.PLAN);
    this.emit('phase:start', { taskId: task.id, phase: PHASE.PLAN, round: 0 });

    const prompt = [
      '[지시사항]',
      '당신은 소프트웨어 프로젝트 플래너입니다.',
      '사용자의 요청을 분석하여 구체적인 구현 계획을 JSON으로 반환하세요.',
      `프로젝트: ${project.name} (${project.stack || '미지정'})`,
      '코드블록 없이 순수 JSON만 반환하세요:',
      '{"title":"작업 제목","summary":"한 줄 요약","features":["기능1"],"files_to_modify":["파일"],"acceptance_criteria":["완료 기준1"],"tech_notes":"주의사항"}',
      '',
      '[작업 요청]',
      task.prompt,
    ].join('\n');

    const output = await this._claudeRun({ taskId: task.id, phase: 'plan', round: 0, cwd: safeCwd, prompt });

    let plan;
    try { plan = parseJson(output); }
    catch { plan = { title: task.prompt, summary: output, features: [], acceptance_criteria: [] }; }

    await taskQueries.updateStatus(task.id, PHASE.PLAN, { plan: JSON.stringify(plan) });
    this.emit('phase:complete', { taskId: task.id, phase: PHASE.PLAN, round: 0 });
    return plan;
  }

  async _runGenerator(task, project, plan, round, safeCwd) {
    const prevEval = task.eval_result ? JSON.parse(task.eval_result) : null;
    const prompt   = round === 1 ? this._buildGeneratorPrompt(plan) : this._buildRetryPrompt(plan, prevEval, round);
    await this._claudeRun({ taskId: task.id, phase: 'build', round, cwd: safeCwd, prompt });
  }

  _buildGeneratorPrompt(plan) {
    return ['다음 계획에 따라 코드를 구현하세요.',
      `## 작업\n${plan.title}`, `## 요약\n${plan.summary}`,
      `## 기능\n${(plan.features||[]).map((f,i)=>`${i+1}. ${f}`).join('\n')}`,
      `## 완료 기준\n${(plan.acceptance_criteria||[]).map((c,i)=>`${i+1}. ${c}`).join('\n')}`,
      `## 주의사항\n${plan.tech_notes||'없음'}`,
      '기존 코드 스타일을 따르고, 완료 기준을 모두 충족하도록 구현하세요.',
    ].join('\n\n');
  }

  _buildRetryPrompt(plan, prevEval, round) {
    return [`이전 구현에 문제가 있습니다. Round ${round} 재시도합니다.`,
      `## 원래 작업\n${plan.title}`,
      `## 평가 결과 (Round ${round-1})\n점수: ${prevEval?.score??'?'}/100`,
      `## 수정 필요\n${(prevEval?.issues||[]).map((x,i)=>`${i+1}. ${x}`).join('\n')||'없음'}`,
      `## 제안\n${prevEval?.suggestions||'없음'}`,
      '위 문제를 반드시 해결하고 완료 기준을 충족하도록 수정하세요.',
    ].join('\n\n');
  }

  async _runEvaluator(task, project, plan, round, safeCwd) {
    const prompt = ['[지시사항]', '당신은 코드 품질 평가자입니다.',
      '코드블록 없이 순수 JSON만 반환하세요:',
      '{"score":0~100,"passed":true또는false,"issues":["문제1"],"suggestions":"개선방향","summary":"한줄요약"}',
      'passed 기준: score >= 80이면 true', '',
      '[평가 요청]', `작업: ${plan.title}`,
      `완료 기준:\n${(plan.acceptance_criteria||[]).map((c,i)=>`${i+1}. ${c}`).join('\n')}`,
      '프로젝트 경로의 실제 코드를 확인하고 각 기준의 충족 여부를 평가하세요.',
    ].join('\n');

    const output = await this._claudeRun({ taskId: task.id, phase: 'eval', round, cwd: safeCwd, prompt });
    try { return parseJson(output); }
    catch { return { score: 50, passed: false, issues: ['평가 파싱 실패'], suggestions: output.substring(0, 500) }; }
  }

  // ── Claude CLI 실행 ────────────────────────────────────────
  // 모든 단계 동일 args: --print --verbose --output-format stream-json
  // stdio: ['ignore', 'pipe', 'pipe'] → stdin 닫기로 인터랙티브 모드 방지

  _claudeRun({ taskId, phase, round, cwd, prompt }) {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--model', CLAUDE_MODEL,
        '--dangerously-skip-permissions',
        '--setting-sources', 'user',
        prompt,
      ];

      console.log(`[CLI spawn:${phase}] round=${round}`);

      const entry = { process: null, phase, round };
      this._running.set(taskId, entry);

      const proc = spawn(CLAUDE_CLI, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.process = proc;

      let fullOutput = '';
      let buffer     = '';
      let rejected   = false;

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type !== 'system') console.log(`[CLI msg:${phase}] type=${msg.type} ${msg.error||''}`);
            this._handleStreamMsg(taskId, phase, round, msg, t => { fullOutput += t; });
          } catch { /* JSON 아닌 라인 무시 */ }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        console.error(`[CLI stderr:${phase}] ${text.trim()}`);
        if (!rejected && (text.includes('rate limit') || text.includes('429'))) {
          rejected = true;
          reject(new Error('RATE_LIMIT'));
        }
        logQueries.append({ task_id: taskId, phase, round, level: 'error', content: text.substring(0, 500) });
      });

      proc.on('close', (code) => {
        console.log(`[CLI close:${phase}] code=${code} outputLen=${fullOutput.length}`);
        if (rejected) return;
        if (code !== 0 && !fullOutput) reject(new Error(`Claude CLI 비정상 종료 (code: ${code})`));
        else resolve(fullOutput.trim());
      });

      proc.on('error', (err) => reject(new Error(`Claude CLI 실행 실패: ${err.message}`)));
    });
  }

  _handleStreamMsg(taskId, phase, round, msg, onText) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          onText(block.text);
          logQueries.append({ task_id: taskId, phase, round, level: 'info', content: block.text });
          this.emit('agent:text', { taskId, phase, round, content: block.text });
        } else if (block.type === 'tool_use') {
          logQueries.append({ task_id: taskId, phase, round, level: 'tool', content: `[도구: ${block.name}]` });
          this.emit('agent:tool', { taskId, phase, round, tool: block.name });
        }
      }
    } else if (msg.type === 'result' && msg.result) {
      onText(msg.result);
    }
  }

  _drainQueue() {
    while (this._queue.length > 0 && this._running.size < MAX_CONCURRENT) {
      const nextId = this._queue.shift();
      this.emit('task:dequeued', { taskId: nextId });
      this._startPipeline(nextId);
    }
  }
}
