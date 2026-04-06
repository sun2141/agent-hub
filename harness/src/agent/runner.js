// src/agent/runner.js
// Claude Code CLI 래퍼 + Planner→Generator→Evaluator 파이프라인

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { taskQueries, logQueries, projectQueries } from '../db/db.js';

const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '2', 10);
const MAX_ROUNDS = parseInt(process.env.MAX_EVAL_ROUNDS || '3', 10);

// 파이프라인 단계
const PHASE = {
  PLAN: 'planning',
  BUILD: 'building',
  EVAL: 'evaluating',
  DONE: 'done',
  FAILED: 'failed',
  PAUSED: 'paused',
};

export class AgentRunner extends EventEmitter {
  constructor() {
    super();
    this._running = new Map(); // taskId → { process, phase }
    this._queue = [];          // 대기 중인 taskId 목록
  }

  // ── 공개 API ───────────────────────────────────────────────

  /** 새 파이프라인 실행 요청 */
  async run({ projectId, prompt, maxRounds = MAX_ROUNDS }) {
    const project = projectQueries.get(projectId);
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`);

    const taskId = `task_${Date.now()}_${randomUUID().slice(0, 6)}`;
    taskQueries.create({ id: taskId, project_id: projectId, prompt, max_rounds: maxRounds });

    this.emit('task:created', { taskId, projectId, prompt });

    if (this._running.size >= MAX_CONCURRENT) {
      this._queue.push(taskId);
      this.emit('task:queued', { taskId });
      return taskId;
    }

    this._startPipeline(taskId);
    return taskId;
  }

  /** 일시정지된 작업 재개 (rate limit 이후) */
  async resume(taskId) {
    const task = taskQueries.get(taskId);
    if (!task) throw new Error(`작업 없음: ${taskId}`);
    if (task.status !== PHASE.PAUSED) throw new Error(`재개 불가 상태: ${task.status}`);

    this.emit('task:resuming', { taskId });
    this._startPipeline(taskId, { resuming: true });
  }

  /** 작업 강제 중지 */
  stop(taskId) {
    const entry = this._running.get(taskId);
    if (entry?.process) {
      entry.process.kill('SIGTERM');
    }
    taskQueries.updateStatus(taskId, PHASE.PAUSED, { error: 'manual_stop' });
    this._running.delete(taskId);
    this.emit('task:paused', { taskId, reason: 'manual_stop' });
  }

  /** 현재 상태 반환 */
  getStatus() {
    const running = [...this._running.entries()].map(([id, e]) => ({
      taskId: id,
      phase: e.phase,
      round: e.round,
    }));
    return {
      running,
      queued: this._queue.length,
      maxConcurrent: MAX_CONCURRENT,
    };
  }

  // ── 파이프라인 내부 ────────────────────────────────────────

  async _startPipeline(taskId, opts = {}) {
    const task = taskQueries.get(taskId);
    const project = projectQueries.get(task.project_id);

    try {
      // 1. Planner (재개 시 이미 plan이 있으면 스킵)
      let plan = task.plan ? JSON.parse(task.plan) : null;
      if (!plan) {
        plan = await this._runPlanner(task, project);
      }

      // 2. Generator → Evaluator 루프
      let round = task.round || 0;
      while (round < task.max_rounds) {
        round++;
        taskQueries.updateStatus(taskId, PHASE.BUILD);
        taskQueries.incrementRound(taskId);
        this.emit('phase:start', { taskId, phase: PHASE.BUILD, round });

        await this._runGenerator(task, project, plan, round);
        this.emit('phase:complete', { taskId, phase: PHASE.BUILD, round });

        taskQueries.updateStatus(taskId, PHASE.EVAL);
        this.emit('phase:start', { taskId, phase: PHASE.EVAL, round });

        const evalResult = await this._runEvaluator(task, project, plan, round);
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
          // 최대 라운드 도달 — 그래도 완료로 처리
          taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', { taskId, round, evalResult, maxRoundsReached: true });
        }
      }
    } catch (err) {
      if (err.message === 'RATE_LIMIT') {
        taskQueries.updateStatus(taskId, PHASE.PAUSED);
        this.emit('task:paused', { taskId, reason: 'rate_limit' });
      } else {
        taskQueries.updateStatus(taskId, PHASE.FAILED, { error: err.message });
        this.emit('task:failed', { taskId, error: err.message });
      }
    } finally {
      this._running.delete(taskId);
      this._drainQueue();
    }
  }

  // ── Planner ────────────────────────────────────────────────

  async _runPlanner(task, project) {
    taskQueries.updateStatus(task.id, PHASE.PLAN);
    this.emit('phase:start', { taskId: task.id, phase: PHASE.PLAN, round: 0 });

    const systemPrompt = `당신은 소프트웨어 프로젝트 플래너입니다.
사용자의 요청을 분석하여 구체적인 구현 계획을 JSON으로 반환하세요.

프로젝트 정보:
- 이름: ${project.name}
- 경로: ${project.path}
- 기술 스택: ${project.stack || '미지정'}

반드시 다음 JSON 형식으로만 응답하세요:
{
  "title": "작업 제목",
  "summary": "한 줄 요약",
  "features": ["기능1", "기능2"],
  "files_to_modify": ["예상 수정 파일 목록"],
  "acceptance_criteria": ["완료 기준1", "완료 기준2"],
  "tech_notes": "기술적 주의사항"
}`;

    const output = await this._claudeRun({
      taskId: task.id,
      phase: 'plan',
      round: 0,
      cwd: project.path,
      prompt: `다음 작업을 계획하세요:\n\n${task.prompt}`,
      systemPrompt,
      printMode: true, // --print 모드로 JSON 받기
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

  async _runGenerator(task, project, plan, round) {
    const prevEval = task.eval_result ? JSON.parse(task.eval_result) : null;

    const prompt = round === 1
      ? this._buildGeneratorPrompt(plan)
      : this._buildRetryPrompt(plan, prevEval, round);

    await this._claudeRun({
      taskId: task.id,
      phase: 'build',
      round,
      cwd: project.path,
      prompt,
      printMode: false, // 대화형 모드로 실제 코드 작성
    });
  }

  _buildGeneratorPrompt(plan) {
    return `다음 계획에 따라 코드를 구현하세요.

## 작업
${plan.title}

## 요약
${plan.summary}

## 구현할 기능
${plan.features.map((f, i) => `${i + 1}. ${f}`).join('\n')}

## 완료 기준
${plan.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## 기술 주의사항
${plan.tech_notes || '없음'}

기존 코드 스타일을 따르고, 완료 기준을 모두 충족하도록 구현하세요.`;
  }

  _buildRetryPrompt(plan, prevEval, round) {
    return `이전 구현에 문제가 있습니다. Round ${round} 재시도합니다.

## 원래 작업
${plan.title}

## 평가 결과 (Round ${round - 1})
점수: ${prevEval?.score ?? '?'}/100
통과: ${prevEval?.passed ? '예' : '아니오'}

## 수정 필요 사항
${(prevEval?.issues || []).map((i, idx) => `${idx + 1}. ${i}`).join('\n') || '없음'}

## 제안사항
${prevEval?.suggestions || '없음'}

위 문제점을 반드시 해결하고 완료 기준을 충족하도록 수정하세요.`;
  }

  // ── Evaluator ──────────────────────────────────────────────

  async _runEvaluator(task, project, plan, round) {
    const systemPrompt = `당신은 코드 품질 평가자입니다.
구현된 코드가 요구사항을 충족하는지 객관적으로 평가하세요.

반드시 다음 JSON 형식으로만 응답하세요:
{
  "score": 0-100,
  "passed": true/false,
  "issues": ["문제1", "문제2"],
  "suggestions": "개선 방향",
  "summary": "한 줄 평가 요약"
}

passed 기준: score >= 80 이면 true`;

    const prompt = `다음 완료 기준에 따라 현재 코드를 평가하세요:

## 작업
${plan.title}

## 완료 기준
${plan.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

프로젝트 경로의 실제 코드를 확인하고 각 기준의 충족 여부를 평가하세요.`;

    const output = await this._claudeRun({
      taskId: task.id,
      phase: 'eval',
      round,
      cwd: project.path,
      prompt,
      systemPrompt,
      printMode: true,
    });

    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      return JSON.parse(jsonMatch ? jsonMatch[0] : output);
    } catch {
      return { score: 50, passed: false, issues: ['평가 파싱 실패'], suggestions: output };
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

      const proc = spawn(CLAUDE_CLI, args, {
        cwd,
        env: { ...process.env },
      });

      entry.process = proc;

      let fullOutput = '';
      let buffer = '';

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 마지막 불완전 라인 보관

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
        if (text.includes('rate limit') || text.includes('429')) {
          reject(new Error('RATE_LIMIT'));
        }
        logQueries.append({ task_id: taskId, phase, round, level: 'error', content: text });
      });

      proc.on('close', (code) => {
        if (code !== 0 && !fullOutput) {
          reject(new Error(`Claude CLI 종료 코드: ${code}`));
        } else {
          resolve(fullOutput.trim());
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Claude CLI 실행 실패: ${err.message}`));
      });
    });
  }

  _handleStreamMsg(taskId, phase, round, msg, onText) {
    // stream-json 형식 파싱
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          onText(block.text);
          logQueries.append({ task_id: taskId, phase, round, level: 'info', content: block.text });
          this.emit('agent:text', { taskId, phase, round, content: block.text });
        } else if (block.type === 'tool_use') {
          const summary = `[도구: ${block.name}]`;
          logQueries.append({ task_id: taskId, phase, round, level: 'tool', content: summary });
          this.emit('agent:tool', { taskId, phase, round, tool: block.name, input: block.input });
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
