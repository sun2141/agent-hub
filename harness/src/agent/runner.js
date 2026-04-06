// src/agent/runner.js
// Claude Code CLI 래퍼 + Planner→Generator→Evaluator 파이프라인

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { taskQueries, logQueries, projectQueries } from '../db/db.js';

const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '2', 10);
const MAX_ROUNDS = parseInt(process.env.MAX_EVAL_ROUNDS || '3', 10);

// 허용된 프로젝트 루트 경로 목록 (path traversal 방지)
const ALLOWED_PROJECT_ROOTS = (process.env.PROJECTS_ROOT || '/Users/sun')
  .split(',')
  .map(p => p.trim());

const PHASE = {
  PLAN:  'planning',
  BUILD: 'building',
  EVAL:  'evaluating',
  DONE:  'done',
  FAILED:'failed',
  PAUSED:'paused',
};

export class AgentRunner extends EventEmitter {
  constructor() {
    super();
    this._running = new Map(); // taskId → { process, phase, round }
    this._queue = [];
  }

  // ── 경로 검증 ──────────────────────────────────────────────
  _validateProjectPath(projectPath) {
    const resolved = path.resolve(projectPath);
    const allowed = ALLOWED_PROJECT_ROOTS.some(root =>
      resolved.startsWith(path.resolve(root))
    );
    if (!allowed) {
      throw new Error(`허용되지 않은 프로젝트 경로: ${projectPath}`);
    }
    return resolved;
  }

  // ── 공개 API ───────────────────────────────────────────────

  async run({ projectId, prompt, maxRounds = MAX_ROUNDS }) {
    const project = projectQueries.get(projectId);
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`);

    // 경로 검증
    this._validateProjectPath(project.path);

    const taskId = `task_${Date.now()}_${randomUUID().slice(0, 6)}`;
    taskQueries.create({ id: taskId, project_id: projectId, prompt, max_rounds: maxRounds });
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
    const task = taskQueries.get(taskId);
    if (!task) throw new Error(`작업 없음: ${taskId}`);
    if (task.status !== PHASE.PAUSED) throw new Error(`재개 불가 상태: ${task.status}`);

    this.emit('task:resuming', { taskId });
    this._startPipeline(taskId, { resuming: true });
  }

  stop(taskId) {
    const entry = this._running.get(taskId);
    if (entry?.process) {
      entry.process.kill('SIGTERM');
    }
    taskQueries.updateStatus(taskId, PHASE.PAUSED, { error: 'manual_stop' });
    this._running.delete(taskId);
    this.emit('task:paused', { taskId, reason: 'manual_stop' });
  }

  getStatus() {
    const running = [...this._running.entries()].map(([id, e]) => ({
      taskId: id,
      phase: e.phase,
      round: e.round,
    }));
    return { running, queued: this._queue.length, maxConcurrent: MAX_CONCURRENT };
  }

  // ── 파이프라인 ─────────────────────────────────────────────

  async _startPipeline(taskId, opts = {}) {
    const task = taskQueries.get(taskId);
    const project = projectQueries.get(task.project_id);
    const safeCwd = this._validateProjectPath(project.path);

    try {
      let plan = task.plan ? JSON.parse(task.plan) : null;
      if (!plan) {
        plan = await this._runPlanner(task, project, safeCwd);
      }

      let round = task.round || 0;
      while (round < task.max_rounds) {
        round++;
        taskQueries.updateStatus(taskId, PHASE.BUILD);
        taskQueries.incrementRound(taskId);
        this.emit('phase:start', { taskId, phase: PHASE.BUILD, round });

        await this._runGenerator(task, project, plan, round, safeCwd);
        this.emit('phase:complete', { taskId, phase: PHASE.BUILD, round });

        taskQueries.updateStatus(taskId, PHASE.EVAL);
        this.emit('phase:start', { taskId, phase: PHASE.EVAL, round });

        const evalResult = await this._runEvaluator(task, project, plan, round, safeCwd);
        this.emit('phase:complete', { taskId, phase: PHASE.EVAL, round });

        taskQueries.updateStatus(taskId, PHASE.EVAL, {
          eval_result: JSON.stringify(evalResult),
        });

        if (evalResult.passed) {
          taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', { taskId, round, evalResult });
          break;
        }

        if (round >= task.max_rounds) {
          taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', { taskId, round, evalResult, maxRoundsReached: true });
        }
      }
    } catch (err) {
      if (err.message === 'RATE_LIMIT') {
        taskQueries.updateStatus(taskId, PHASE.PAUSED);
        this.emit('task:paused', { taskId, reason: 'rate_limit' });
      } else {
        // 오류 메시지에서 경로 정보 제거 (정보 노출 방지)
        const safeError = err.message.replace(/\/Users\/[^\s]+/g, '[path]');
        taskQueries.updateStatus(taskId, PHASE.FAILED, { error: safeError });
        this.emit('task:failed', { taskId, error: safeError });
      }
    } finally {
      this._running.delete(taskId);
      this._drainQueue();
    }
  }

  // ── Planner ────────────────────────────────────────────────

  async _runPlanner(task, project, safeCwd) {
    taskQueries.updateStatus(task.id, PHASE.PLAN);
    this.emit('phase:start', { taskId: task.id, phase: PHASE.PLAN, round: 0 });

    const systemPrompt = [
      '당신은 소프트웨어 프로젝트 플래너입니다.',
      '사용자의 요청을 분석하여 구체적인 구현 계획을 JSON으로 반환하세요.',
      '',
      `프로젝트: ${project.name} (${project.stack || '미지정'})`,
      '',
      '반드시 다음 JSON 형식으로만 응답하세요:',
      '{',
      '  "title": "작업 제목",',
      '  "summary": "한 줄 요약",',
      '  "features": ["기능1", "기능2"],',
      '  "files_to_modify": ["예상 수정 파일"],',
      '  "acceptance_criteria": ["완료 기준1", "완료 기준2"],',
      '  "tech_notes": "기술적 주의사항"',
      '}',
    ].join('\n');

    const output = await this._claudeRun({
      taskId: task.id,
      phase: 'plan',
      round: 0,
      cwd: safeCwd,
      prompt: `다음 작업을 계획하세요:\n\n${task.prompt}`,
      systemPrompt,
      printMode: true,
    });

    let plan;
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      plan = JSON.parse(jsonMatch ? jsonMatch[0] : output);
    } catch {
      plan = { title: task.prompt, summary: output, features: [], acceptance_criteria: [] };
    }

    taskQueries.updateStatus(task.id, PHASE.PLAN, { plan: JSON.stringify(plan) });
    this.emit('phase:complete', { taskId: task.id, phase: PHASE.PLAN, round: 0 });
    return plan;
  }

  // ── Generator ──────────────────────────────────────────────

  async _runGenerator(task, project, plan, round, safeCwd) {
    const prevEval = task.eval_result ? JSON.parse(task.eval_result) : null;
    const prompt = round === 1
      ? this._buildGeneratorPrompt(plan)
      : this._buildRetryPrompt(plan, prevEval, round);

    await this._claudeRun({
      taskId: task.id,
      phase: 'build',
      round,
      cwd: safeCwd,
      prompt,
      printMode: false,
    });
  }

  _buildGeneratorPrompt(plan) {
    return [
      '다음 계획에 따라 코드를 구현하세요.',
      '',
      `## 작업\n${plan.title}`,
      `## 요약\n${plan.summary}`,
      `## 구현할 기능\n${(plan.features || []).map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
      `## 완료 기준\n${(plan.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      `## 기술 주의사항\n${plan.tech_notes || '없음'}`,
      '',
      '기존 코드 스타일을 따르고, 완료 기준을 모두 충족하도록 구현하세요.',
    ].join('\n');
  }

  _buildRetryPrompt(plan, prevEval, round) {
    return [
      `이전 구현에 문제가 있습니다. Round ${round} 재시도합니다.`,
      '',
      `## 원래 작업\n${plan.title}`,
      `## 평가 결과 (Round ${round - 1})`,
      `점수: ${prevEval?.score ?? '?'}/100`,
      `통과: ${prevEval?.passed ? '예' : '아니오'}`,
      `## 수정 필요 사항\n${(prevEval?.issues || []).map((i, idx) => `${idx + 1}. ${i}`).join('\n') || '없음'}`,
      `## 제안사항\n${prevEval?.suggestions || '없음'}`,
      '',
      '위 문제점을 반드시 해결하고 완료 기준을 충족하도록 수정하세요.',
    ].join('\n');
  }

  // ── Evaluator ──────────────────────────────────────────────

  async _runEvaluator(task, project, plan, round, safeCwd) {
    const systemPrompt = [
      '당신은 코드 품질 평가자입니다.',
      '구현된 코드가 요구사항을 충족하는지 객관적으로 평가하세요.',
      '',
      '반드시 다음 JSON 형식으로만 응답하세요:',
      '{',
      '  "score": 0-100,',
      '  "passed": true/false,',
      '  "issues": ["문제1", "문제2"],',
      '  "suggestions": "개선 방향",',
      '  "summary": "한 줄 평가 요약"',
      '}',
      '',
      'passed 기준: score >= 80 이면 true',
    ].join('\n');

    const prompt = [
      '다음 완료 기준에 따라 현재 코드를 평가하세요:',
      '',
      `## 작업\n${plan.title}`,
      `## 완료 기준\n${(plan.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      '',
      '프로젝트 경로의 실제 코드를 확인하고 각 기준의 충족 여부를 평가하세요.',
    ].join('\n');

    const output = await this._claudeRun({
      taskId: task.id,
      phase: 'eval',
      round,
      cwd: safeCwd,
      prompt,
      systemPrompt,
      printMode: true,
    });

    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      return JSON.parse(jsonMatch ? jsonMatch[0] : output);
    } catch {
      return { score: 50, passed: false, issues: ['평가 파싱 실패'], suggestions: output.substring(0, 500) };
    }
  }

  // ── Claude CLI 실행 ────────────────────────────────────────

  _claudeRun({ taskId, phase, round, cwd, prompt, systemPrompt, printMode }) {
    return new Promise((resolve, reject) => {
      const args = printMode
        ? ['--print', '--output-format', 'stream-json']
        : ['--output-format', 'stream-json'];

      if (systemPrompt) {
        args.push('--system', systemPrompt);
      }
      args.push(prompt);

      const entry = { process: null, phase, round };
      this._running.set(taskId, entry);

      // 환경변수: 필요한 것만 전달 (전체 process.env 노출 방지)
      const safeEnv = {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        TERM: 'xterm-256color',
        LANG: process.env.LANG || 'en_US.UTF-8',
      };

      const proc = spawn(CLAUDE_CLI, args, { cwd, env: safeEnv });
      entry.process = proc;

      let fullOutput = '';
      let buffer = '';
      let rejected = false;

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._handleStreamMsg(taskId, phase, round, msg, (text) => {
              fullOutput += text;
            });
          } catch {
            // JSON 아닌 라인 무시
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (!rejected && (text.includes('rate limit') || text.includes('429'))) {
          rejected = true;
          reject(new Error('RATE_LIMIT'));
        }
        // stderr는 로그에만 기록, 이벤트로 노출하지 않음
        logQueries.append({ task_id: taskId, phase, round, level: 'error', content: text.substring(0, 500) });
      });

      proc.on('close', (code) => {
        if (rejected) return;
        if (code !== 0 && !fullOutput) {
          reject(new Error(`Claude CLI 비정상 종료 (code: ${code})`));
        } else {
          resolve(fullOutput.trim());
        }
      });

      proc.on('error', (err) => {
        reject(new Error('Claude CLI 실행 실패'));
      });
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
          const summary = `[도구: ${block.name}]`;
          logQueries.append({ task_id: taskId, phase, round, level: 'tool', content: summary });
          this.emit('agent:tool', { taskId, phase, round, tool: block.name });
          // tool input은 민감 정보 포함 가능하므로 이벤트에 포함하지 않음
        }
      }
    } else if (msg.type === 'result') {
      if (msg.result) onText(msg.result);
    }
  }

  // ── 큐 관리 ───────────────────────────────────────────────

  _drainQueue() {
    while (this._queue.length > 0 && this._running.size < MAX_CONCURRENT) {
      const nextId = this._queue.shift();
      this.emit('task:dequeued', { taskId: nextId });
      this._startPipeline(nextId);
    }
  }
}
