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

  async run({ projectId, prompt, maxRounds }) {
    const project = await projectQueries.get(projectId);
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`);
    this._validateProjectPath(project.path);

    // maxRounds는 MAX_ROUNDS 이상으로 보장 (외부 입력으로 하향 불가)
    const effectiveMaxRounds = Math.max(
      typeof maxRounds === 'number' && maxRounds > 0 ? maxRounds : MAX_ROUNDS,
      MAX_ROUNDS
    );

    const taskId = `task_${Date.now()}_${randomUUID().slice(0, 6)}`;
    await taskQueries.create({ id: taskId, project_id: projectId, prompt, max_rounds: effectiveMaxRounds });
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

    // 파이프라인 시작 시 _running에 초기 엔트리 등록 (concurrent 제한 및 stop 지원)
    if (!this._running.has(taskId)) {
      this._running.set(taskId, { process: null, phase: PHASE.PLAN, round: 0 });
    }

    console.log(`[pipeline] 시작: taskId=${taskId}, project=${project.name}(${project.path})`);

    try {
      let plan = task.plan ? JSON.parse(task.plan) : null;
      if (!plan) plan = await this._runPlanner(task, project, safeCwd);

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

        const evalPassed = this._isEvalPassed(evalResult);
        const passedIssues = Array.isArray(evalResult?.issues) ? evalResult.issues : [];
        console.log(`[pipeline] eval 결과: passed=${evalPassed}, score=${evalResult?.score ?? '?'}, issues=${passedIssues.length}개`);
        await logQueries.append({ task_id: taskId, phase: 'eval', round, level: 'info',
          content: `[eval] passed=${evalPassed}, score=${evalResult?.score ?? '?'}, issues=${passedIssues.length}개` });

        if (evalPassed) {
          console.log(`[pipeline] eval 합격 → commit/deploy 진행`);
          await logQueries.append({ task_id: taskId, phase: 'eval', round, level: 'info',
            content: `[eval 합격] score=${evalResult.score}, passed=true → commit/deploy 진행` });
          let deployResult = 'skipped';
          try {
            deployResult = await this._runCommitAndDeploy(task, project, plan, round, safeCwd);
          } catch (deployErr) {
            // commit/deploy 에서 예외가 발생해도 task는 DONE으로 처리
            console.error(`[pipeline] commit/deploy 예외 발생 (task는 DONE 처리): ${deployErr.message}`);
            await logQueries.append({ task_id: taskId, phase: 'deploy', round, level: 'error',
              content: `[commit/deploy 예외] ${deployErr.message.substring(0, 500)}` });
            deployResult = 'deploy_failed';
          }
          // deploy 실패 여부와 무관하게 DONE으로 기록하되, deploy_status는 이미 updateDeploy로 구분됨
          const deployFailed = deployResult === 'deploy_failed';
          console.log(`[pipeline] 완료 처리: deployResult=${deployResult}, deployFailed=${deployFailed}`);
          await taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', { taskId, round, evalResult, maxRoundsReached: false, unresolvedIssues: 0, deployFailed });
          break;
        }

        if (isLastRound) {
          // 최대 라운드 도달 — eval 불합격으로 종료 (커밋/배포 없음)
          const unresolvedIssues = Array.isArray(evalResult?.issues) ? evalResult.issues.length : null;
          console.log(`[pipeline] 최대 라운드(${round}/${currentTask.max_rounds}) 도달 — eval 불합격으로 종료. unresolvedIssues=${unresolvedIssues}`);
          await logQueries.append({ task_id: taskId, phase: 'eval', round, level: 'warn',
            content: `[eval 불합격] 최대 라운드 도달, unresolvedIssues=${unresolvedIssues}, score=${evalResult?.score ?? '?'}` });
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
    try {
      plan = parseJson(output);
      // 누락 필드 보정: title/summary가 없는 경우 task.prompt로 대체
      if (!plan.title) plan.title = task.prompt.slice(0, 100);
      if (!plan.summary) plan.summary = plan.title;
      if (!Array.isArray(plan.features)) plan.features = [];
      if (!Array.isArray(plan.acceptance_criteria)) plan.acceptance_criteria = [];
    } catch {
      plan = { title: task.prompt.slice(0, 100), summary: output.slice(0, 200), features: [], acceptance_criteria: [] };
    }

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

    const commitMsg = `feat: ${plan.title || task.prompt.slice(0, 60)} (task=${task.id}, round=${round})`;

    // harness/ 절대 경로를 realpath로 확정 (symlink/상대경로 오류 방지)
    const harnessAbsPath = fs.realpathSync(path.resolve(__dirname, '../..'));
    const safeCwdReal = fs.existsSync(safeCwd) ? fs.realpathSync(safeCwd) : safeCwd;

    console.log(`[deploy] 커밋 시작 — task=${task.id}, round=${round}`);
    console.log(`[deploy] harnessAbsPath=${harnessAbsPath}`);
    console.log(`[deploy] safeCwdReal=${safeCwdReal}`);

    let commitSha = null;

    // ── 커밋 헬퍼: 주어진 git root에서 stageTarget을 add 후 commit ──
    const doCommit = async (label, gitRoot, stageTarget) => {
      console.log(`[deploy] [${label}] git root=${gitRoot}, stageTarget=${stageTarget}`);
      try {
        // git status로 변경사항 파악 (디버그)
        let statusOut = '';
        try {
          statusOut = execSync('git status --short', { cwd: gitRoot, encoding: 'utf8', timeout: 5_000, stdio: 'pipe' }).trim();
        } catch { /* 무시 */ }
        console.log(`[deploy] [${label}] git status:\n${statusOut || '(변경 없음)'}`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info',
          content: `[${label}] git status: ${statusOut || 'clean'}` });

        execSync(`git add -- ${JSON.stringify(stageTarget)}`, {
          cwd: gitRoot, encoding: 'utf8', timeout: 15_000, stdio: 'pipe',
        });

        // staged 내용 확인 (디버그)
        let stagedOut = '';
        try {
          stagedOut = execSync('git diff --cached --name-only', { cwd: gitRoot, encoding: 'utf8', timeout: 5_000, stdio: 'pipe' }).trim();
        } catch { /* 무시 */ }
        console.log(`[deploy] [${label}] staged files: ${stagedOut || '(없음)'}`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info',
          content: `[${label}] staged: ${stagedOut || 'none'}` });

        if (!stagedOut) {
          console.log(`[deploy] [${label}] 스테이징된 변경사항 없음 — 커밋 건너뜀`);
          await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info',
            content: `[commit ${label}] nothing staged — skipped` });
          return null;
        }

        execSync(`git commit -m ${JSON.stringify(commitMsg)}`, {
          cwd: gitRoot, encoding: 'utf8', timeout: 15_000, stdio: 'pipe',
        });
        const sha = execSync('git rev-parse HEAD', {
          cwd: gitRoot, encoding: 'utf8', timeout: 5_000, stdio: 'pipe',
        }).trim();
        console.log(`[deploy] [${label}] commit 완료: ${sha}`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info',
          content: `[commit ${label}] ${sha}` });
        return sha;
      } catch (err) {
        const stderr = err.stderr?.toString().trim() || '';
        const stdout = err.stdout?.toString().trim() || '';
        // nothing to commit 메시지는 stderr가 아닌 stdout에 있으므로 stdout도 확인
        const msg = stderr || stdout || err.message;
        if (msg.includes('nothing to commit') || msg.includes('nothing added to commit')) {
          console.log(`[deploy] [${label}] 커밋할 변경사항 없음 — 건너뜀`);
          await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info',
            content: `[commit ${label}] nothing to commit — skipped` });
          return null;
        }
        // 실패 시 git status로 원인 파악
        let gitStatus = '';
        try {
          gitStatus = execSync('git status', { cwd: gitRoot, encoding: 'utf8', timeout: 5_000, stdio: 'pipe' }).trim();
        } catch { /* 무시 */ }
        const fullMsg = [msg, gitStatus ? `\n[git status]\n${gitStatus}` : ''].join('');
        console.error(`[deploy] [${label}] commit 실패: ${msg}`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error',
          content: `[commit ${label} 실패] ${fullMsg.substring(0, 1000)}` });
        return null; // commit 실패해도 deploy는 계속 진행
      }
    };

    // ── 1. 어느 git 저장소에 속하는지 판별하여 커밋 ──────────────
    // 전략: safeCwdReal의 git root와 harness의 git root를 구한 뒤,
    //   - 같은 저장소이면 한 번만 커밋 (stageTarget = '.' — 모든 변경사항 포함)
    //   - 다른 저장소이면 각각 커밋

    let harnessGitRoot = null;
    let projectGitRoot = null;

    try {
      harnessGitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: harnessAbsPath, encoding: 'utf8', timeout: 10_000, stdio: 'pipe',
      }).trim();
    } catch (err) {
      console.error(`[deploy] harness git root 탐색 실패: ${err.message}`);
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error',
        content: `[deploy] harness git root 탐색 실패: ${err.message}` });
    }

    try {
      projectGitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: safeCwdReal, encoding: 'utf8', timeout: 10_000, stdio: 'pipe',
      }).trim();
    } catch (err) {
      const msg = err.stderr?.toString().trim() || err.message;
      if (!msg.includes('not a git repository')) {
        console.error(`[deploy] project git root 탐색 실패: ${msg}`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error',
          content: `[deploy] project git root 탐색 실패: ${msg}` });
      } else {
        console.log(`[deploy] project(${safeCwdReal}): git 저장소 아님 — 건너뜀`);
      }
    }

    const sameRepo = harnessGitRoot && projectGitRoot && harnessGitRoot === projectGitRoot;
    console.log(`[deploy] sameRepo=${sameRepo}, harnessGitRoot=${harnessGitRoot}, projectGitRoot=${projectGitRoot}`);

    if (sameRepo) {
      // 같은 저장소 — '.' 으로 모든 변경사항 스테이징 후 한 번만 커밋
      const sha = await doCommit('repo', harnessGitRoot, '.');
      if (sha) {
        commitSha = sha;
        await taskQueries.updateCommit(task.id, commitSha);
      }
    } else {
      // 다른 저장소 — harness와 project 각각 커밋
      if (harnessGitRoot) {
        const harnessRelPath = path.relative(harnessGitRoot, harnessAbsPath);
        // harnessRelPath가 '' 이면 git root 자체가 harness
        const harnessStageTarget = harnessRelPath === '' ? '.' : harnessRelPath;
        if (!harnessStageTarget.startsWith('..')) {
          const sha = await doCommit('harness', harnessGitRoot, harnessStageTarget);
          if (sha) {
            commitSha = sha;
            await taskQueries.updateCommit(task.id, commitSha);
          }
        } else {
          console.error(`[deploy] harnessAbsPath가 gitRoot 외부 — 건너뜀: ${harnessRelPath}`);
        }
      }

      if (projectGitRoot) {
        const projectRelPath = path.relative(projectGitRoot, safeCwdReal);
        const projectStageTarget = projectRelPath === '' ? '.' : projectRelPath;
        if (!projectStageTarget.startsWith('..')) {
          const sha = await doCommit('project', projectGitRoot, projectStageTarget);
          if (sha && !commitSha) {
            commitSha = sha;
            await taskQueries.updateCommit(task.id, commitSha);
          }
        } else {
          console.error(`[deploy] safeCwdReal이 projectGitRoot 외부 — 건너뜀: ${projectRelPath}`);
        }
      }
    }

    console.log(`[deploy] 커밋 단계 완료. commitSha=${commitSha || '(없음)'}`);
    await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info',
      content: `[deploy] 커밋 완료. sha=${commitSha || 'none'}` });

    // ── 2. deploy (커밋 결과와 무관하게 항상 실행) ─────────────────
    const deployScript = _findDeployScript(safeCwd, harnessAbsPath);
    console.log(`[deploy] 배포 스크립트 탐색: ${deployScript ? `${deployScript.cmd} (cwd=${deployScript.cwd})` : '없음'}`);
    if (!deployScript) {
      await taskQueries.updateDeploy(task.id, 'skipped:no_script');
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: '[deploy] 배포 스크립트 없음 — 건너뜀' });
      console.log('[deploy] 배포 스크립트 없음 — 건너뜀');
      this.emit('phase:complete', { taskId: task.id, phase: 'deploying', round });
      return 'skipped:no_script';
    }

    console.log(`[deploy] 배포 실행: ${deployScript.cmd}`);
    await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info',
      content: `[deploy] 배포 실행: ${deployScript.cmd}` });

    let deployFailed = false;
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
      deployFailed = true;
    }

    this.emit('phase:complete', { taskId: task.id, phase: 'deploying', round });
    return deployFailed ? 'deploy_failed' : 'success';
  }

  _buildGeneratorPrompt(plan, round, maxRounds) {
    return ['다음 계획에 따라 코드를 구현하세요.',
      `## 작업\n${plan.title || plan.summary || '(제목 없음)'}`, `## 요약\n${plan.summary || plan.title || ''}`,
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
      `## 원래 작업\n${plan.title || plan.summary || '(제목 없음)'}`,
      `## 요약\n${plan.summary || plan.title || ''}`,
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
      '모든 분석이 끝나면 응답의 맨 마지막 줄에 반드시 아래 형식의 JSON 한 줄만 출력하세요.',
      '코드블록(```), 설명 텍스트, 줄바꿈 없이 JSON 객체만 그대로 출력하세요:',
      '{"score":85,"passed":true,"issues":[],"suggestions":"개선 방향","summary":"한줄요약"}',
      '',
      '규칙:',
      '- passed=true 조건: 모든 완료 기준이 구현되어 있고 score >= 80',
      '- 모든 기준이 충족되면 issues는 반드시 빈 배열 [] (충족된 항목을 issues에 넣지 말 것)',
      '- 미구현·부분 구현 항목만 issues에 문자열로 명시',
      '- score는 0~100 사이 정수',
      '- 반드시 score, passed, issues, suggestions, summary 필드를 모두 포함할 것',
      '',
      '[평가 대상]',
      `작업: ${plan.title || plan.summary || '(제목 없음)'}`,
      `요약: ${plan.summary || plan.title || ''}`,
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
      } else {
        // issues 키 자체가 출력에 없는 경우도 파싱 실패로 처리
        issuesParseFailed = true;
      }

      // suggestions/summary: 멀티라인 문자열을 처리하기 위해 s 플래그 사용
      const suggestionsMatch = output.match(/"suggestions"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/s);
      const summaryMatch = output.match(/"summary"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/s);
      const suggestions = suggestionsMatch ? suggestionsMatch[1] : output.substring(0, 500);
      const summary = summaryMatch ? summaryMatch[1] : '';

      // passed=true이면서 issues 파싱 실패 → 빈 배열로 보정 (합격 판정 보호)
      // passed=false이면서 issues 파싱 실패 → suggestions 텍스트를 issue로 사용
      if (issues === null) {
        if (passed) {
          issues = [];
        } else if (issuesParseFailed) {
          // suggestions에서 의미있는 정보 추출, 없으면 출력 앞부분 사용
          const fallbackText = suggestions && suggestions !== output.substring(0, 500)
            ? suggestions.substring(0, 200)
            : output.replace(/```[\s\S]*?```/g, '').trim().substring(0, 200);
          issues = [fallbackText || '평가 파싱 실패'];
        } else {
          issues = [];
        }
      }

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
// safeCwd 기준으로 먼저 탐색하고, 없으면 harnessAbsPath 기준으로도 탐색
function _findDeployScript(cwd, harnessAbsPath) {
  // safeCwd 기준 탐색 후, 없으면 harnessAbsPath 기준으로 재탐색
  const searchDirs = [cwd];
  if (harnessAbsPath && harnessAbsPath !== cwd) {
    searchDirs.push(harnessAbsPath);
  }

  for (const dir of searchDirs) {
    const deployShPath = path.join(dir, 'deploy.sh');
    if (fs.existsSync(deployShPath)) {
      return { cmd: 'bash deploy.sh', cwd: dir };
    }

    const makefilePath = path.join(dir, 'Makefile');
    if (fs.existsSync(makefilePath)) {
      try {
        const content = fs.readFileSync(makefilePath, 'utf8');
        if (/^deploy:/m.test(content)) {
          return { cmd: 'make deploy', cwd: dir };
        }
      } catch { /* 읽기 실패 시 무시 */ }
    }

    const ecosystemPath = path.join(dir, 'ecosystem.config.js');
    const ecosystem2Path = path.join(dir, 'ecosystem.config.cjs');
    if (fs.existsSync(ecosystemPath) || fs.existsSync(ecosystem2Path)) {
      return { cmd: 'pm2 reload ecosystem.config.js --update-env', cwd: dir };
    }

    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts?.deploy) {
          return { cmd: 'npm run deploy', cwd: dir };
        }
      } catch { /* 파싱 실패 시 무시 */ }
    }
  }

  return null;
}
