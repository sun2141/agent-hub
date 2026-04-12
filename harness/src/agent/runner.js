// src/agent/runner.js
// Claude Code CLI 래퍼 + Planner→Generator→Evaluator 파이프라인

import { EventEmitter } from 'events';
import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { taskQueries, logQueries, projectQueries } from '../db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_CLI   = process.env.CLAUDE_CLI_PATH || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '2', 10);
const MAX_ROUNDS     = parseInt(process.env.MAX_EVAL_ROUNDS || '10', 10);

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
  // 첫 { 부터 매칭되는 } 까지 추출 (문자열 내 중괄호 무시)
  // 여러 후보를 모두 시도하여 유효한 JSON을 반환
  let searchFrom = 0;
  while (true) {
    const start = stripped.indexOf('{', searchFrom);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let foundEnd = false;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          foundEnd = true;
          try {
            return JSON.parse(stripped.slice(start, i + 1));
          } catch {
            // 이 후보는 실패 — 다음 { 부터 재탐색
            searchFrom = start + 1;
            break;
          }
        }
      }
    }
    // 닫히지 않은 중괄호 또는 모든 후보 소진 — 탐색 종료
    if (!foundEnd) break;
  }
  throw new Error('유효한 JSON 객체를 찾을 수 없음');
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
    let task      = await taskQueries.get(taskId);
    const project = await projectQueries.get(task.project_id);
    const safeCwd = this._validateProjectPath(project.path);

    try {
      let plan = task.plan ? JSON.parse(task.plan) : null;
      if (!plan) plan = await this._runPlanner(task, project, safeCwd);

      // 작업 복잡도에 따라 max_rounds 동적 조정 (플래닝 후 한 번만)
      if (!task.plan) {
        const featureCount = (plan.features || []).length;
        const criteriaCount = (plan.acceptance_criteria || []).length;
        const complexity = featureCount + criteriaCount;
        let adjustedRounds = task.max_rounds;
        if (complexity >= 10) adjustedRounds = Math.max(task.max_rounds, MAX_ROUNDS);
        else if (complexity >= 6) adjustedRounds = Math.max(task.max_rounds, Math.ceil(MAX_ROUNDS * 0.8));
        if (adjustedRounds !== task.max_rounds) {
          console.log(`[pipeline] 복잡도(${complexity}) 기반 max_rounds 조정: ${task.max_rounds} → ${adjustedRounds}`);
          await taskQueries.updateStatus(taskId, PHASE.PLAN, { max_rounds: adjustedRounds });
          task = await taskQueries.get(taskId);
        }
      }

      let round = task.round || 0;
      let evalResult = null;
      // 매 반복마다 DB에서 최신 max_rounds 및 eval 결과를 읽기 위해 루프 시작 시 재로드
      while (true) {
        const currentTask = await taskQueries.get(taskId);
        if (round >= currentTask.max_rounds) break;
        round++;
        const isLastRound = round >= currentTask.max_rounds;
        const prevEval = currentTask.eval_result ? JSON.parse(currentTask.eval_result) : null;

        await taskQueries.updateStatus(taskId, PHASE.BUILD);
        await taskQueries.incrementRound(taskId);
        this.emit('phase:start', { taskId, phase: PHASE.BUILD, round });
        await this._runGenerator(task, project, plan, round, currentTask.max_rounds, prevEval, safeCwd);
        this.emit('phase:complete', { taskId, phase: PHASE.BUILD, round });

        await taskQueries.updateStatus(taskId, PHASE.EVAL);
        this.emit('phase:start', { taskId, phase: PHASE.EVAL, round });
        evalResult = await this._runEvaluator(task, project, plan, round, safeCwd);
        this.emit('phase:complete', { taskId, phase: PHASE.EVAL, round });
        await taskQueries.updateStatus(taskId, PHASE.EVAL, { eval_result: JSON.stringify(evalResult) });

        if (this._isEvalPassed(evalResult)) {
          // eval 합격 — issues가 없음을 확인 로그
          const passedIssues = Array.isArray(evalResult.issues) ? evalResult.issues : [];
          console.log(`[pipeline] eval 합격 (score=${evalResult.score}, issues=${passedIssues.length}개) → commit/deploy 진행`);
          await logQueries.append({ task_id: taskId, phase: 'eval', round, level: 'info',
            content: `[eval 합격] score=${evalResult.score}, issues=0, passed=true → commit/deploy 진행` });
          await this._runCommitAndDeploy(task, project, plan, round, safeCwd);
          await taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', { taskId, round, evalResult, maxRoundsReached: false, unresolvedIssues: 0 });
          break;
        }

        if (isLastRound) {
          // 최대 라운드 도달 — eval 불합격으로 종료 (커밋/배포 없음)
          const unresolvedIssues = Array.isArray(evalResult?.issues) ? evalResult.issues.length : null;
          await taskQueries.updateDeploy(taskId, 'skipped:eval_failed');
          await taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', { taskId, round, evalResult, maxRoundsReached: true, unresolvedIssues });
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

  async _runGenerator(task, project, plan, round, maxRounds, prevEval, safeCwd) {
    const prompt = round === 1
      ? this._buildGeneratorPrompt(plan, round, maxRounds)
      : this._buildRetryPrompt(plan, prevEval, round, maxRounds);
    await this._claudeRun({ taskId: task.id, phase: 'build', round, cwd: safeCwd, prompt });
  }

  // eval 합격 여부 판정
  // issues 배열이 존재(Array.isArray)하면 비어있어야 합격으로 인정
  // 빈 문자열, null, whitespace-only 항목은 실질적 이슈가 아닌 것으로 처리
  _isEvalPassed(evalResult) {
    if (!evalResult || evalResult.passed !== true || (evalResult.score ?? 0) < 80) return false;
    if (Array.isArray(evalResult.issues)) {
      const realIssues = evalResult.issues.filter(
        x => x && typeof x === 'string' && x.trim().length > 0
      );
      if (realIssues.length > 0) return false;
    }
    return true;
  }

  async _runCommitAndDeploy(task, project, plan, round, safeCwd) {
    this.emit('phase:start', { taskId: task.id, phase: 'deploying', round });

    // ── 1. git commit (harness/ 경로 한정) ──────────────────
    let commitSha = null;
    try {
      const commitMsg = `feat: ${plan.title || task.prompt.slice(0, 60)} (task=${task.id}, round=${round})`;
      // harness/ 디렉토리 기준 git 루트 확인
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: safeCwd, encoding: 'utf8', timeout: 10_000,
      }).trim();
      // harness/ 경로 및 프로젝트(safeCwd) 경로 모두 스테이징
      const harnessRelPath = path.relative(gitRoot, path.resolve(__dirname, '../..'));
      const projectRelPath = path.relative(gitRoot, safeCwd);
      // 스테이징 대상: harness/ + 프로젝트 경로 (중복 없도록 Set 활용)
      const stagePaths = [...new Set([harnessRelPath, projectRelPath])]
        .filter(p => p && !p.startsWith('..')) // git 루트 외부 경로 제외
        .map(p => JSON.stringify(p))
        .join(' ');
      execSync(`git add -- ${stagePaths}`, {
        cwd: gitRoot, encoding: 'utf8', timeout: 15_000,
      });
      execSync(`git commit -m ${JSON.stringify(commitMsg)}`, {
        cwd: gitRoot, encoding: 'utf8', timeout: 15_000,
      });
      commitSha = execSync('git rev-parse HEAD', {
        cwd: gitRoot, encoding: 'utf8', timeout: 5_000,
      }).trim();
      await taskQueries.updateCommit(task.id, commitSha);
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[commit] ${commitSha}` });
      console.log(`[deploy] commit 완료: ${commitSha}`);
    } catch (err) {
      const msg = err.stderr?.toString().trim() || err.message;
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error', content: `[commit 실패] ${msg.substring(0, 500)}` });
      console.error(`[deploy] commit 실패 — deploy 건너뜀: ${msg}`);
      await taskQueries.updateDeploy(task.id, 'skipped:commit_failed');
      this.emit('phase:complete', { taskId: task.id, phase: 'deploying', round });
      return;
    }

    // ── 2. deploy (커밋 성공 이후에만 실행) ─────────────────
    const deployScript = _findDeployScript(safeCwd);
    if (!deployScript) {
      await taskQueries.updateDeploy(task.id, 'skipped:no_script');
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: '[deploy] 배포 스크립트 없음 — 건너뜀' });
      console.log('[deploy] 배포 스크립트 없음 — 건너뜀');
      this.emit('phase:complete', { taskId: task.id, phase: 'deploying', round });
      return;
    }

    try {
      const output = execSync(deployScript.cmd, {
        cwd: deployScript.cwd, encoding: 'utf8', timeout: 120_000,
      });
      await taskQueries.updateDeploy(task.id, 'success');
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[deploy 성공] ${output.substring(0, 500)}` });
      console.log(`[deploy] 배포 성공: ${deployScript.cmd}`);
    } catch (err) {
      const msg = (err.stderr?.toString() || err.stdout?.toString() || err.message).trim();
      await taskQueries.updateDeploy(task.id, 'failed');
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error', content: `[deploy 실패] ${msg.substring(0, 500)}` });
      console.error(`[deploy] 배포 실패: ${msg}`);
    }

    this.emit('phase:complete', { taskId: task.id, phase: 'deploying', round });
  }

  _buildGeneratorPrompt(plan, round, maxRounds) {
    return ['다음 계획에 따라 코드를 구현하세요.',
      `## 작업\n${plan.title}`, `## 요약\n${plan.summary}`,
      `## 기능\n${(plan.features||[]).map((f,i)=>`${i+1}. ${f}`).join('\n')}`,
      `## 완료 기준\n${(plan.acceptance_criteria||[]).map((c,i)=>`${i+1}. ${c}`).join('\n')}`,
      `## 주의사항\n${plan.tech_notes||'없음'}`,
      `## 라운드 정보\nRound ${round}/${maxRounds} — 모든 완료 기준을 이 라운드에서 충족하는 것을 목표로 하세요.`,
      '기존 코드 스타일을 따르고, 완료 기준을 모두 충족하도록 구현하세요.',
      '⚠️ 이 단계에서는 git commit이나 배포를 실행하지 마세요. 구현만 완료하세요.',
    ].join('\n\n');
  }

  _buildRetryPrompt(plan, prevEval, round, maxRounds) {
    const remaining = maxRounds - round;
    const issuesList = (prevEval?.issues || []);
    const issuesText = issuesList.length > 0
      ? issuesList.map((x, i) => `${i + 1}. ${x}`).join('\n')
      : '없음';
    return [
      `이전 구현에 문제가 있습니다. Round ${round}/${maxRounds} 재시도합니다. (남은 라운드: ${remaining})`,
      `## 원래 작업\n${plan.title}`,
      `## 요약\n${plan.summary || ''}`,
      `## 완료 기준\n${(plan.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      `## 평가 결과 (Round ${round - 1})\n점수: ${prevEval?.score ?? '?'}/100`,
      `## 반드시 해결해야 할 미충족 항목 (${issuesList.length}개)\n${issuesText}`,
      `## 개선 제안\n${prevEval?.suggestions || '없음'}`,
      '위 미충족 항목을 모두 해결하고 모든 완료 기준을 충족하도록 수정하세요. 미충족 항목을 하나라도 건너뛰지 마세요.',
      '⚠️ 이 단계에서는 git commit이나 배포를 실행하지 마세요. 구현만 완료하세요.',
    ].join('\n\n');
  }

  async _runEvaluator(task, project, plan, round, safeCwd) {
    const criteria = (plan.acceptance_criteria||[]).map((c,i)=>`${i+1}. ${c}`).join('\n');
    const prompt = [
      '[지시사항]',
      '당신은 코드 품질 평가자입니다. 반드시 실제 파일을 읽고 코드를 확인한 뒤 평가하세요.',
      '',
      '[평가 절차]',
      '1. ls, cat 등 도구로 현재 디렉토리의 파일 구조를 파악하세요.',
      `2. 아래 완료 기준과 관련된 파일을 직접 읽어서 구현 여부를 확인하세요.`,
      '3. 각 완료 기준이 충족되었는지 하나씩 검토하세요.',
      '4. 검토 완료 후 반드시 아래 JSON 형식으로만 최종 응답을 작성하세요.',
      '',
      '[⚠️ 매우 중요 — 최종 응답 형식]',
      '응답의 마지막 부분에 반드시 아래 형식의 JSON을 그대로 출력하세요 (코드블록, 설명 없이):',
      '{"score":85,"passed":true,"issues":[],"suggestions":"개선 방향","summary":"한줄요약"}',
      '',
      '규칙:',
      '- passed=true 조건: 모든 완료 기준이 구현되어 있고 score >= 80',
      '- 모든 기준이 충족되면 issues는 반드시 빈 배열 [] (충족된 항목을 issues에 넣지 말 것)',
      '- 미구현·부분 구현 항목만 issues에 문자열로 명시',
      '- score는 0~100 사이 정수',
      '',
      '[평가 대상]',
      `작업: ${plan.title}`,
      `요약: ${plan.summary}`,
      '',
      `[완료 기준 — 각 항목의 충족 여부를 파일에서 직접 확인하세요]`,
      criteria,
    ].join('\n');

    const output = await this._claudeRun({ taskId: task.id, phase: 'eval', round, cwd: safeCwd, prompt });
    try { return parseJson(output); }
    catch (e) {
      console.error(`[eval] JSON 파싱 실패: ${e.message}\n출력(500자): ${output.substring(0, 500)}`);
      // 텍스트에서 score/passed 값을 정규식으로 추출 시도
      const scoreMatch = output.match(/"score"\s*:\s*(\d+)/);
      const passedMatch = output.match(/"passed"\s*:\s*(true|false)/);
      const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
      const passed = passedMatch ? passedMatch[1] === 'true' : false;

      // issues 배열: 깊이 추적으로 첫 번째 완결된 배열을 추출
      let issues = null; // null = 파싱 미시도 또는 실패
      let issuesParseFailed = false;
      const issuesKeyIdx = output.indexOf('"issues"');
      if (issuesKeyIdx !== -1) {
        const arrStart = output.indexOf('[', issuesKeyIdx);
        if (arrStart !== -1) {
          let depth = 0, inStr = false, esc = false, arrEnd = -1;
          for (let i = arrStart; i < output.length; i++) {
            const ch = output[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\' && inStr) { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '[') depth++;
            else if (ch === ']') { depth--; if (depth === 0) { arrEnd = i; break; } }
          }
          if (arrEnd !== -1) {
            try { issues = JSON.parse(output.slice(arrStart, arrEnd + 1)); }
            catch { issuesParseFailed = true; }
          } else {
            issuesParseFailed = true;
          }
        } else {
          issuesParseFailed = true;
        }
      }

      // passed=true이면서 issues 파싱 실패 → 빈 배열로 보정 (합격 판정 보호)
      if (issues === null) {
        if (passed) {
          issues = [];
        } else {
          issues = issuesParseFailed ? ['평가 파싱 실패'] : [];
        }
      }

      // suggestions/summary: 멀티라인 문자열을 처리하기 위해 s 플래그 사용
      const suggestionsMatch = output.match(/"suggestions"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/s);
      const summaryMatch = output.match(/"summary"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/s);
      const suggestions = suggestionsMatch ? suggestionsMatch[1] : output.substring(0, 500);
      const summary = summaryMatch ? summaryMatch[1] : '';
      return { score, passed, issues, suggestions, summary };
    }
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

      let finalResult    = null; // result 타입에서 추출한 최종 응답
      let assistantTexts = [];   // assistant 블록 텍스트 누적 (폴백용)
      let buffer         = '';
      let rejected       = false;

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type !== 'system') console.log(`[CLI msg:${phase}] type=${msg.type} ${msg.error||''}`);
            this._handleStreamMsg(taskId, phase, round, msg,
              (text) => { assistantTexts.push(text); },
              (r)    => { finalResult = r; }
            );
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
        // 우선순위: result 타입 > assistant 블록 누적 텍스트
        const output = (finalResult && finalResult.trim())
          ? finalResult
          : assistantTexts.join('\n').trim();
        console.log(`[CLI close:${phase}] code=${code} outputLen=${output.length} source=${finalResult ? 'result' : 'assistant'}`);
        if (rejected) return;
        if (code !== 0 && !output) reject(new Error(`Claude CLI 비정상 종료 (code: ${code})`));
        else resolve(output.trim());
      });

      proc.on('error', (err) => reject(new Error(`Claude CLI 실행 실패: ${err.message}`)));
    });
  }

  _handleStreamMsg(taskId, phase, round, msg, onAssistantText, onResult) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          logQueries.append({ task_id: taskId, phase, round, level: 'info', content: block.text });
          this.emit('agent:text', { taskId, phase, round, content: block.text });
          // assistant 블록 텍스트를 별도 누적 (result가 빈 경우 폴백으로 사용)
          if (onAssistantText) onAssistantText(block.text);
        } else if (block.type === 'tool_use') {
          logQueries.append({ task_id: taskId, phase, round, level: 'tool', content: `[도구: ${block.name}]` });
          this.emit('agent:tool', { taskId, phase, round, tool: block.name });
        }
      }
    } else if (msg.type === 'result') {
      // result 타입: Claude CLI 최종 응답
      if (msg.is_error) {
        logQueries.append({ task_id: taskId, phase, round, level: 'error', content: `[result error] ${JSON.stringify(msg.result||'')}` });
      } else if (msg.result != null) {
        const resultText = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result);
        if (resultText.trim() && onResult) onResult(resultText);
      }
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

// ── 배포 스크립트 탐색 헬퍼 ────────────────────────────────────
// 우선순위: deploy.sh → Makefile (deploy target) → pm2 ecosystem
// cwd 기준으로 파일 존재 여부를 확인하여 실행 커맨드 반환
function _findDeployScript(cwd) {
  const deployShPath = path.join(cwd, 'deploy.sh');
  if (fs.existsSync(deployShPath)) {
    return { cmd: 'bash deploy.sh', cwd };
  }

  const makefilePath = path.join(cwd, 'Makefile');
  if (fs.existsSync(makefilePath)) {
    try {
      const content = fs.readFileSync(makefilePath, 'utf8');
      if (/^deploy:/m.test(content)) {
        return { cmd: 'make deploy', cwd };
      }
    } catch { /* 읽기 실패 시 무시 */ }
  }

  const ecosystemPath = path.join(cwd, 'ecosystem.config.js');
  const ecosystem2Path = path.join(cwd, 'ecosystem.config.cjs');
  if (fs.existsSync(ecosystemPath) || fs.existsSync(ecosystem2Path)) {
    return { cmd: 'pm2 reload ecosystem.config.js --update-env', cwd };
  }

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.deploy) {
        return { cmd: 'npm run deploy', cwd };
      }
    } catch { /* 파싱 실패 시 무시 */ }
  }

  return null;
}
