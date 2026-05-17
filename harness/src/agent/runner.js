// src/agent/runner.js
// Claude Code CLI 래퍼 + Planner→Generator→Evaluator 파이프라인

import { EventEmitter } from 'events';
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { taskQueries, logQueries, projectQueries, deleteTask, limitEventQueries } from '../db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_CLI   = process.env.CLAUDE_CLI_PATH || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const CODEX_CLI    = process.env.CODEX_CLI_PATH || '/Users/sun/.nvm/versions/node/v22.22.2/bin/codex';
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
            searchFrom = start + 1;
            break;
          }
        }
      }
    }
    if (!foundEnd) break;
  }
  throw new Error('유효한 JSON 객체를 찾을 수 없음');
}

export class AgentRunner extends EventEmitter {
  constructor() {
    super();
    this._running = new Map();
    this._queue   = [];
    this._deleted = new Set();
  }

  _validateProjectPath(projectPath) {
    const resolved = path.resolve(projectPath);
    const allowed  = ALLOWED_PROJECT_ROOTS.some(root =>
      resolved.startsWith(path.resolve(root))
    );
    if (!allowed) throw new Error(`허용되지 않은 프로젝트 경로: ${projectPath}`);
    return resolved;
  }

  async run({ projectId, prompt, maxRounds, attachments }) {
    const project = await projectQueries.get(projectId);
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`);
    this._validateProjectPath(project.path);

    const activeTask = await taskQueries.getActiveForProject(projectId);
    if (activeTask) {
      throw new Error(`이미 실행 중인 task가 있습니다: ${activeTask.id} (${activeTask.status}). 완료 후 다시 시도하세요.`);
    }

    // 사용자가 지정한 값 사용, 단 MAX_ROUNDS를 상한으로 제한 (Math.min)
    const effectiveMaxRounds = typeof maxRounds === 'number' && maxRounds > 0
      ? Math.min(maxRounds, MAX_ROUNDS)
      : MAX_ROUNDS;

    const taskId = `task_${Date.now()}_${randomUUID().slice(0, 6)}`;

    // 첨부 파일을 임시 디렉토리에 저장
    if (attachments?.length) {
      this._saveAttachments(taskId, attachments);
    }

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

  _saveAttachments(taskId, attachments) {
    const tmpDir = path.join(os.tmpdir(), `harness-attach-${taskId}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const saved = [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      try {
        if (att.type === 'image') {
          const ext = att.mimeType === 'image/png' ? '.png'
            : att.mimeType === 'image/gif' ? '.gif'
            : att.mimeType === 'image/webp' ? '.webp' : '.jpg';
          const fileName = `attachment_${i}${ext}`;
          const filePath = path.join(tmpDir, fileName);
          fs.writeFileSync(filePath, Buffer.from(att.data, 'base64'));
          saved.push({ type: 'image', name: att.name || fileName, path: filePath, mimeType: att.mimeType || 'image/jpeg' });
        } else if (att.type === 'text') {
          const safeName = path.basename(att.name || 'file.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
          const fileName = `attachment_${i}_${safeName}`;
          const filePath = path.join(tmpDir, fileName);
          fs.writeFileSync(filePath, att.text || '', 'utf8');
          saved.push({ type: 'text', name: att.name || safeName, path: filePath, content: (att.text || '').slice(0, 8000) });
        }
      } catch (err) {
        console.error(`[attachments] 파일 저장 실패: ${err.message}`);
      }
    }
    this._attachments = this._attachments || new Map();
    this._attachments.set(taskId, saved);
    console.log(`[attachments] taskId=${taskId}, ${saved.length}개 저장: ${tmpDir}`);
  }

  _cleanupAttachments(taskId) {
    if (!this._attachments?.has(taskId)) return;
    const saved = this._attachments.get(taskId);
    this._attachments.delete(taskId);
    if (saved.length > 0) {
      const tmpDir = path.dirname(saved[0].path);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  async resume(taskId) {
    const task = await taskQueries.get(taskId);
    if (!task) throw new Error(`작업 없음: ${taskId}`);
    if (task.status !== PHASE.PAUSED && task.status !== 'rate_limited') {
      throw new Error(`재개 불가 상태: ${task.status}`);
    }
    // rate_limited 상태면 scheduled_resume_at 초기화
    if (task.status === 'rate_limited') {
      await taskQueries.updateScheduledResumeAt(taskId, null);
    }
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

  async deleteTask(taskId) {
    const task = await taskQueries.get(taskId);
    if (!task) throw new Error(`작업 없음: ${taskId}`);

    this._deleted.add(taskId);

    const entry = this._running.get(taskId);
    if (entry?.process) {
      entry.process.kill('SIGTERM');
    }
    this._running.delete(taskId);

    const queueIdx = this._queue.indexOf(taskId);
    if (queueIdx !== -1) this._queue.splice(queueIdx, 1);

    await deleteTask(taskId);

    setTimeout(() => this._deleted.delete(taskId), 5000);
    this.emit('task:deleted', { taskId, projectId: task.project_id });
    return { taskId, projectId: task.project_id };
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
    const attachmentPaths = this._attachments?.get(taskId) || [];

    if (!this._running.has(taskId)) {
      this._running.set(taskId, { process: null, phase: PHASE.PLAN, round: 0 });
    }

    console.log(`[pipeline] 시작: taskId=${taskId}, project=${project.name}(${project.path}), attachments=${attachmentPaths.length}`);

    try {
      let plan = task.plan ? JSON.parse(task.plan) : null;
      if (!plan) plan = await this._runPlanner(task, project, safeCwd, attachmentPaths);
      if (this._deleted.has(taskId)) return;

      // 플래너 완료 후 task를 다시 읽어 최신 상태 반영
      task = await taskQueries.get(taskId);
      if (!task) return; // 삭제된 경우

      let round = task.round || 0;
      let evalResult = null;
      while (true) {
        if (this._deleted.has(taskId)) break;

        // 루프 시작마다 DB에서 fresh한 task 조회
        const currentTask = await taskQueries.get(taskId);
        if (!currentTask) break; // 삭제된 경우

        // 외부에서 상태가 변경된 경우(manual stop, delete 등) 중단
        if (currentTask.status === PHASE.PAUSED || currentTask.status === PHASE.FAILED || currentTask.status === PHASE.DONE) {
          console.log(`[pipeline] 외부 상태 변경 감지 (${currentTask.status}) → 루프 중단`);
          break;
        }

        if (round >= currentTask.max_rounds) break;
        round++;
        const isLastRound = round >= currentTask.max_rounds;
        const prevEval = currentTask.eval_result ? JSON.parse(currentTask.eval_result) : null;

        await taskQueries.updateStatus(taskId, PHASE.BUILD);
        await taskQueries.incrementRound(taskId);
        this.emit('phase:start', { taskId, phase: PHASE.BUILD, round });
        await this._runGenerator(currentTask, project, plan, round, currentTask.max_rounds, prevEval, safeCwd, attachmentPaths);
        if (this._deleted.has(taskId)) break;
        this.emit('phase:complete', { taskId, phase: PHASE.BUILD, round });

        await taskQueries.updateStatus(taskId, PHASE.EVAL);
        this.emit('phase:start', { taskId, phase: PHASE.EVAL, round });
        evalResult = await this._runEvaluator(currentTask, project, plan, round, safeCwd);
        if (this._deleted.has(taskId)) break;
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
            deployResult = await this._runCommitAndDeploy(currentTask, project, plan, round, safeCwd);
          } catch (deployErr) {
            console.error(`[pipeline] commit/deploy 예외 발생 (task는 DONE 처리): ${deployErr.message}`);
            await logQueries.append({ task_id: taskId, phase: 'deploy', round, level: 'error',
              content: `[commit/deploy 예외] ${deployErr.message.substring(0, 500)}` });
            deployResult = 'deploy_failed';
          }
          const deployFailed = deployResult === 'deploy_failed';
          console.log(`[pipeline] 완료 처리: deployResult=${deployResult}, deployFailed=${deployFailed}`);
          await taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', { taskId, projectId: currentTask.project_id, round, evalResult, maxRoundsReached: false, unresolvedIssues: 0, deployFailed });
          break;
        }

        if (isLastRound) {
          const unresolvedIssues = Array.isArray(evalResult?.issues) ? evalResult.issues.length : null;
          console.log(`[pipeline] 최대 라운드(${round}/${currentTask.max_rounds}) 도달 — eval 불합격으로 종료. unresolvedIssues=${unresolvedIssues}`);
          await logQueries.append({ task_id: taskId, phase: 'eval', round, level: 'warn',
            content: `[eval 불합격] 최대 라운드 도달, unresolvedIssues=${unresolvedIssues}, score=${evalResult?.score ?? '?'}` });
          await taskQueries.updateDeploy(taskId, 'skipped:eval_failed');
          await taskQueries.updateStatus(taskId, PHASE.DONE);
          this.emit('task:complete', { taskId, projectId: currentTask.project_id, round, evalResult, maxRoundsReached: true, unresolvedIssues });
          break;
        }
      }
    } catch (err) {
      if (this._deleted.has(taskId)) {
        console.log(`[pipeline] taskId=${taskId} 삭제 진행 중 — catch 블록 스킵`);
      } else if (err.message === 'RATE_LIMIT') {
        // 토큰 리미트 감지: 즉시 중단 (수동 재개 방식으로 변경 — 시간 예약 없음)
        console.log(`[pipeline] Claude 토큰 리미트 감지 → 즉시 중단. 대시보드에서 수동으로 재개하세요.`);
        await taskQueries.updateStatus(taskId, 'rate_limited');
        await logQueries.append({ task_id: taskId, phase: 'system', round: 0, level: 'warn',
          content: `[rate_limited] 토큰 리미트 도달. 대시보드에서 계속하기 버튼으로 수동 재개하세요.` });

        // 체크포인트 자동 저장
        const checkpointInfo = await this._saveRateLimitCheckpoint(taskId, task, null);

        // limit_events 이력 기록
        try {
          await limitEventQueries.insert({
            task_id: taskId,
            project_id: task?.project_id,
            resume_available_at: null,
            checkpoint_path: checkpointInfo?.checkpointPath || null,
            checkpoint_summary: checkpointInfo?.summary || null,
          });
          console.log(`[pipeline] limit_event 기록됨: taskId=${taskId}`);
        } catch (dbErr) {
          console.error(`[pipeline] limit_event DB 저장 실패: ${dbErr.message}`);
        }

        this.emit('task:rate_limited', { taskId, projectId: task?.project_id });
      } else {
        const safeError = err.message.replace(/\/Users\/[^\s]+/g, '[path]');
        await taskQueries.updateStatus(taskId, PHASE.FAILED, { error: safeError });
        this.emit('task:failed', { taskId, projectId: task?.project_id, error: safeError });
      }
    } finally {
      this._running.delete(taskId);
      this._cleanupAttachments(taskId);
      this._drainQueue();
    }
  }

  async _runPlanner(task, project, safeCwd, attachmentPaths = []) {
    await taskQueries.updateStatus(task.id, PHASE.PLAN);
    this.emit('phase:start', { taskId: task.id, phase: PHASE.PLAN, round: 0 });

    const promptParts = [
      '[지시사항]',
      '당신은 소프트웨어 프로젝트 플래너입니다.',
      '사용자의 요청을 분석하여 구체적인 구현 계획을 JSON으로 반환하세요.',
      `프로젝트: ${project.name} (${project.stack || '미지정'})`,
      '코드블록 없이 순수 JSON만 반환하세요:',
      '{"title":"작업 제목","summary":"한 줄 요약","features":["기능1"],"files_to_modify":["파일"],"acceptance_criteria":["완료 기준1"],"tech_notes":"주의사항"}',
      '',
      '[작업 요청]',
      task.prompt,
    ];

    if (attachmentPaths.length) {
      promptParts.push('', '[첨부 파일 컨텍스트]', '다음 파일들이 작업 컨텍스트로 제공됩니다:');
      for (const ap of attachmentPaths) {
        if (ap.type === 'text') {
          promptParts.push(`\n--- 첨부파일: ${ap.name} ---\n${ap.content || ''}\n--- 끝: ${ap.name} ---`);
        } else if (ap.type === 'image') {
          promptParts.push(`- 이미지 파일: ${ap.name}`);
        }
      }
      promptParts.push('위 첨부 파일들을 참고하여 계획을 수립하세요.');
    }

    const prompt = promptParts.join('\n');
    const output = await this._claudeRun({ taskId: task.id, phase: 'plan', round: 0, cwd: safeCwd, prompt });

    let plan;
    try {
      plan = parseJson(output);
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

  async _runGenerator(task, project, plan, round, maxRounds, prevEval, safeCwd, attachmentPaths = []) {
    let prompt = round === 1
      ? this._buildGeneratorPrompt(plan, round, maxRounds)
      : this._buildRetryPrompt(plan, prevEval, round, maxRounds);
    if (round === 1 && attachmentPaths.length) {
      prompt += '\n\n[첨부 파일 컨텍스트]\n다음 파일들을 참고하여 작업을 수행하세요:\n';
      for (const ap of attachmentPaths) {
        if (ap.type === 'text') {
          prompt += `\n--- 첨부파일: ${ap.name} ---\n${ap.content || ''}\n--- 끝: ${ap.name} ---\n`;
        } else if (ap.type === 'image') {
          prompt += `- 이미지 파일: ${ap.name}\n`;
        }
      }
    }
    await this._claudeRun({ taskId: task.id, phase: 'build', round, cwd: safeCwd, prompt });
  }

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
    const harnessAbsPath = fs.realpathSync(path.resolve(__dirname, '../..'));
    const safeCwdReal = fs.existsSync(safeCwd) ? fs.realpathSync(safeCwd) : safeCwd;

    console.log(`[deploy] 커밋 시작 — task=${task.id}, round=${round}`);
    console.log(`[deploy] harnessAbsPath=${harnessAbsPath}`);
    console.log(`[deploy] safeCwdReal=${safeCwdReal}`);

    let commitSha = null;

    const doCommit = async (label, gitRoot, stageTarget) => {
      console.log(`[deploy] [${label}] git root=${gitRoot}, stageTarget=${stageTarget}`);

      const statusRes = spawnSync('git', ['status', '--short'], { cwd: gitRoot, encoding: 'utf8', timeout: 5_000, stdio: 'pipe' });
      const statusOut = (statusRes.stdout || '').trim();
      console.log(`[deploy] [${label}] git status:\n${statusOut || '(변경 없음)'}`);
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[${label}] git status: ${statusOut || 'clean'}` });

      const addRes = spawnSync('git', ['add', '--', stageTarget], { cwd: gitRoot, encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
      if (addRes.error || addRes.status !== 0) {
        const addStderr = (addRes.stderr || '').trim();
        const addStdout = (addRes.stdout || '').trim();
        console.error(`[deploy] [${label}] git add 실패: stderr=${addStderr} | stdout=${addStdout}`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error', content: `[commit ${label} add 실패] stderr=${addStderr} | stdout=${addStdout}`.substring(0, 1000) });
        return null;
      }

      const stagedRes = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: gitRoot, encoding: 'utf8', timeout: 5_000, stdio: 'pipe' });
      const stagedOut = (stagedRes.stdout || '').trim();
      console.log(`[deploy] [${label}] staged files: ${stagedOut || '(없음)'}`);
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[${label}] staged: ${stagedOut || 'none'}` });

      if (!stagedOut) {
        console.log(`[deploy] [${label}] 스테이징된 변경사항 없음 — 커밋 건너뜀`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[commit ${label}] nothing staged — skipped` });
        return null;
      }

      const commitRes = spawnSync('git', ['commit', '-m', commitMsg], { cwd: gitRoot, encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
      if (commitRes.error || commitRes.status !== 0) {
        const cStderr = (commitRes.stderr || '').trim();
        const cStdout = (commitRes.stdout || '').trim();
        const cMsg = cStderr || cStdout || (commitRes.error?.message ?? 'git commit 실패');
        if (cMsg.includes('nothing to commit') || cMsg.includes('nothing added to commit')) {
          console.log(`[deploy] [${label}] 커밋할 변경사항 없음 — 건너뜀`);
          await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[commit ${label}] nothing to commit — skipped` });
          return null;
        }
        console.error(`[deploy] [${label}] commit 실패: stderr=${cStderr} | stdout=${cStdout}`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error', content: `[commit ${label} 실패] stderr=${cStderr} | stdout=${cStdout}`.substring(0, 1000) });
        return null;
      }

      const cSuccessStdout = (commitRes.stdout || '').trim();
      const cSuccessStderr = (commitRes.stderr || '').trim();
      if (cSuccessStdout) await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[commit ${label} stdout] ${cSuccessStdout}`.substring(0, 1000) });
      if (cSuccessStderr) await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[commit ${label} stderr] ${cSuccessStderr}`.substring(0, 1000) });

      const shaRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, encoding: 'utf8', timeout: 5_000, stdio: 'pipe' });
      const sha = (shaRes.stdout || '').trim();
      console.log(`[deploy] [${label}] commit 완료: ${sha}`);
      await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[commit ${label}] sha=${sha}` });

      const pushRes = spawnSync('git', ['push'], { cwd: gitRoot, encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
      const pushStdout = (pushRes.stdout || '').trim();
      const pushStderr = (pushRes.stderr || '').trim();
      if (pushRes.error || pushRes.status !== 0) {
        console.error(`[deploy] [${label}] git push 실패: stderr=${pushStderr} | stdout=${pushStdout}`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error', content: `[push ${label} 실패] stderr=${pushStderr} | stdout=${pushStdout}`.substring(0, 1000) });
      } else {
        console.log(`[deploy] [${label}] git push 완료: ${pushStderr || pushStdout || 'ok'}`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[push ${label}] stdout=${pushStdout} | stderr=${pushStderr}`.substring(0, 1000) });
      }

      return sha;
    };

    let harnessGitRoot = null;
    let projectGitRoot = null;

    {
      const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: harnessAbsPath, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
      if (res.error || res.status !== 0) {
        const errMsg = (res.stderr || '').trim() || (res.error?.message ?? 'git rev-parse 실패');
        console.error(`[deploy] harness git root 탐색 실패: stderr=${errMsg}`);
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error', content: `[deploy] harness git root 탐색 실패: ${errMsg}` });
      } else {
        harnessGitRoot = (res.stdout || '').trim();
      }
    }

    {
      const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: safeCwdReal, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
      if (res.error || res.status !== 0) {
        const errMsg = (res.stderr || '').trim() || (res.error?.message ?? 'git rev-parse 실패');
        if (!errMsg.includes('not a git repository')) {
          console.error(`[deploy] project git root 탐색 실패: stderr=${errMsg}`);
          await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error', content: `[deploy] project git root 탐색 실패: ${errMsg}` });
        } else {
          console.log(`[deploy] project(${safeCwdReal}): git 저장소 아님 — 건너뜀`);
        }
      } else {
        projectGitRoot = (res.stdout || '').trim();
      }
    }

    const sameRepo = harnessGitRoot && projectGitRoot && harnessGitRoot === projectGitRoot;
    console.log(`[deploy] sameRepo=${sameRepo}, harnessGitRoot=${harnessGitRoot}, projectGitRoot=${projectGitRoot}`);

    // 프로젝트 파일만 커밋 — 하네스 자체 변경은 커밋 대상에서 제외
    // sameRepo인 경우에도 프로젝트 하위 경로만 스테이징
    const targetGitRoot = sameRepo ? harnessGitRoot : projectGitRoot;
    if (targetGitRoot) {
      const projectRelPath = path.relative(targetGitRoot, safeCwdReal);
      const projectStageTarget = projectRelPath === '' ? '.' : projectRelPath;
      if (!projectStageTarget.startsWith('..')) {
        const sha = await doCommit('project', targetGitRoot, projectStageTarget);
        if (sha) { commitSha = sha; await taskQueries.updateCommit(task.id, commitSha); }
      } else {
        console.error(`[deploy] safeCwdReal이 gitRoot 외부 — 건너뜀: ${projectRelPath}`);
      }
    } else {
      console.log('[deploy] 프로젝트 git root 없음 — 커밋 건너뜀');
    }

    console.log(`[deploy] 커밋 단계 완료. commitSha=${commitSha || '(없음)'}`);
    await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[deploy] 커밋 완료. sha=${commitSha || 'none'}` });

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
    await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[deploy] 배포 실행: ${deployScript.cmd}` });

    let deployFailed = false;
    {
      const deployArgs = deployScript.cmd.split(/\s+/);
      const deployCli = deployArgs[0];
      const deployCliArgs = deployArgs.slice(1);
      const deployRes = spawnSync(deployCli, deployCliArgs, { cwd: deployScript.cwd, encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
      const deployStdout = (deployRes.stdout || '').trim();
      const deployStderr = (deployRes.stderr || '').trim();
      if (deployRes.error || deployRes.status !== 0) {
        const deployMsg = deployStderr || deployStdout || (deployRes.error?.message ?? 'deploy 실패');
        await taskQueries.updateDeploy(task.id, 'failed');
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'error', content: `[deploy 실패] stderr=${deployStderr} | stdout=${deployStdout}`.substring(0, 500) });
        console.error(`[deploy] 배포 실패: ${deployMsg}`);
        deployFailed = true;
      } else {
        await taskQueries.updateDeploy(task.id, 'success');
        await logQueries.append({ task_id: task.id, phase: 'deploy', round, level: 'info', content: `[deploy 성공] stdout=${deployStdout} | stderr=${deployStderr}`.substring(0, 500) });
        console.log(`[deploy] 배포 성공: ${deployScript.cmd}`);
      }
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
      const scoreMatch = output.match(/"score"\s*:\s*(\d+)/);
      const passedMatch = output.match(/"passed"\s*:\s*(true|false)/);
      const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
      const passed = passedMatch ? passedMatch[1] === 'true' : false;

      let issues = null;
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
          } else { issuesParseFailed = true; }
        } else { issuesParseFailed = true; }
      } else { issuesParseFailed = true; }

      const suggestionsMatch = output.match(/"suggestions"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/s);
      const summaryMatch = output.match(/"summary"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/s);
      const suggestions = suggestionsMatch ? suggestionsMatch[1] : output.substring(0, 500);
      const summary = summaryMatch ? summaryMatch[1] : '';

      if (issues === null) {
        if (passed) {
          issues = [];
        } else if (issuesParseFailed) {
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

  // ── Rate Limit 체크포인트 저장 ─────────────────────────────
  async _saveRateLimitCheckpoint(taskId, task, resetAtIso) {
    try {
      const plan = task?.plan ? JSON.parse(task.plan) : null;
      const round = task?.round || 0;
      const maxRounds = task?.max_rounds || 10;

      const summary = plan
        ? `[rate_limited] ${plan.title || plan.summary || task?.prompt?.slice(0, 80) || taskId} — Round ${round}/${maxRounds}`
        : `[rate_limited] ${task?.prompt?.slice(0, 80) || taskId} — Round ${round}/${maxRounds}`;

      const completedTodos = [];
      const remainingTodos = [];

      if (plan) {
        // 완료된 라운드를 completed로 표시
        if (round > 0) {
          completedTodos.push(`Plan 단계 완료`);
          for (let r = 1; r <= round; r++) {
            completedTodos.push(`Round ${r} Build 완료`);
          }
        }
        // 남은 라운드를 remaining으로 표시
        for (let r = round + 1; r <= maxRounds; r++) {
          remainingTodos.push(`Round ${r} Build & Eval`);
        }
        remainingTodos.push(`최종 배포 및 완료`);
      }

      const AGENT_HUB_ROOT = path.resolve(__dirname, '../../..');
      const checkpointScript = path.join(AGENT_HUB_ROOT, 'execution', 'save_checkpoint.py');

      if (!fs.existsSync(checkpointScript)) {
        console.warn(`[rate_limit_checkpoint] save_checkpoint.py 없음: ${checkpointScript}`);
        return { summary, completedTodos, remainingTodos, checkpointPath: null };
      }

      const completedArgs = completedTodos.map(t => `"${t.replace(/"/g, '\\"')}"`);
      const remainingArgs = remainingTodos.map(t => `"${t.replace(/"/g, '\\"')}"`);
      const contextJson = JSON.stringify({
        taskId,
        project_id: task?.project_id,
        round,
        maxRounds,
        trigger: 'rate_limit',
        prompt: task?.prompt?.slice(0, 200) || '',
      }).replace(/'/g, "'\\''");

      const args = [
        checkpointScript,
        '--summary', summary,
        '--task-id', taskId,
        '--last-step', `Round ${round} 완료 후 토큰 리미트 도달`,
        '--context', contextJson,
      ];
      if (completedTodos.length > 0) args.push('--completed', ...completedTodos);
      if (remainingTodos.length > 0) args.push('--remaining', ...remainingTodos);

      const result = spawnSync('python3', args, {
        cwd: AGENT_HUB_ROOT,
        encoding: 'utf8',
        timeout: 10_000,
        stdio: 'pipe',
      });

      if (result.status === 0) {
        const checkpointPath = path.join(AGENT_HUB_ROOT, '.tmp', 'interrupted_task.json');
        console.log(`[rate_limit_checkpoint] 저장 완료: ${checkpointPath}`);
        return { summary, completedTodos, remainingTodos, checkpointPath };
      } else {
        console.error(`[rate_limit_checkpoint] 저장 실패: ${result.stderr || result.stdout}`);
        return { summary, completedTodos, remainingTodos, checkpointPath: null };
      }
    } catch (err) {
      console.error(`[rate_limit_checkpoint] 예외: ${err.message}`);
      return null;
    }
  }

  // ── Claude CLI 실행 ────────────────────────────────────────
  // --setting-sources user 제거: CLAUDE_CONFIG_DIR(harness 전용)을 우선 사용
  // hasTrustDialogAccepted는 .claude.json의 projects 항목에서 true로 설정 필요

  _isCodexAvailable() {
    try {
      const res = spawnSync(CODEX_CLI, ['--version'], { timeout: 3000, stdio: 'pipe' });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  async _runCodexFallback(taskId) {
    const task    = await taskQueries.get(taskId);
    const project = await projectQueries.get(task.project_id);
    const safeCwd = this._validateProjectPath(project.path);
    const plan    = task.plan
      ? JSON.parse(task.plan)
      : { title: task.prompt.slice(0, 60), features: [], acceptance_criteria: [] };
    const round    = (task.round || 0) + 1;
    const prevEval = task.eval_result ? JSON.parse(task.eval_result) : null;
    console.log(`[codex] fallback taskId=${taskId}, round=${round}`);
    this._running.set(taskId, { process: null, phase: 'building', round });
    try {
      await taskQueries.updateStatus(taskId, 'fallback_running');
      await taskQueries.updateProvider(taskId, 'codex');
      this.emit('task:paused', { taskId, reason: 'fallback_running', provider: 'codex' });
      const handoffPrompt = this._buildHandoffPrompt(task, plan, round, prevEval);
      await logQueries.append({ task_id: taskId, phase: 'build', round, level: 'info', content: `[codex fallback] round=${round}` });
      await this._codexRun({ taskId, phase: 'build', round, cwd: safeCwd, prompt: handoffPrompt });
      await taskQueries.updateStatus(taskId, PHASE.EVAL);
      await taskQueries.incrementRound(taskId);
      this.emit('phase:start', { taskId, phase: PHASE.EVAL, round });
      const evalResult = await this._runEvaluator(task, project, plan, round, safeCwd);
      this.emit('phase:complete', { taskId, phase: PHASE.EVAL, round });
      await taskQueries.updateStatus(taskId, PHASE.EVAL, { eval_result: JSON.stringify(evalResult) });
      if (this._isEvalPassed(evalResult)) {
        let deployResult = 'skipped';
        try { deployResult = await this._runCommitAndDeploy(task, project, plan, round, safeCwd); } catch {}
        await taskQueries.updateStatus(taskId, PHASE.DONE);
        this.emit('task:complete', { taskId, projectId: task.project_id, round, evalResult, provider: 'codex', deployFailed: deployResult === 'deploy_failed' });
      } else {
        await taskQueries.updateStatus(taskId, PHASE.PAUSED, { error: 'codex_eval_failed' });
        this.emit('task:paused', { taskId, reason: 'codex_eval_failed', provider: 'codex', evalResult });
      }
    } catch (err) {
      console.error(`[codex fallback] failed: ${err.message}`);
      await taskQueries.updateStatus(taskId, PHASE.PAUSED, { error: `codex_failed: ${err.message.slice(0, 200)}` });
      this.emit('task:paused', { taskId, reason: 'codex_failed' });
    } finally {
      this._running.delete(taskId);
      this._drainQueue();
    }
  }

  _buildHandoffPrompt(task, plan, round, prevEval) {
    const lines = [
      '[Codex Handoff]',
      `## task: ${plan.title || task.prompt.slice(0, 80)}`,
      `## summary: ${plan.summary || plan.title || ''}`,
      '',
      '## features',
      ...(plan.features || []).map((f, i) => `${i + 1}. ${f}`),
      '',
      '## acceptance_criteria (all must be met)',
      ...(plan.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`),
    ];
    if (prevEval) {
      const issues = Array.isArray(prevEval.issues) ? prevEval.issues : [];
      lines.push('', `## prev eval round=${round - 1} score=${prevEval.score ?? '?'}/100`, '## unresolved issues', ...issues.map((x, i) => `${i + 1}. ${x}`), `## suggestions: ${prevEval.suggestions || 'none'}`);
    }
    lines.push('', `Round ${round}: implement all acceptance_criteria above.`, 'WARNING: do NOT git commit or deploy. Only implement.');
    return lines.join('\n');
  }

  _codexRun({ taskId, phase, round, cwd, prompt }) {
    return new Promise((resolve, reject) => {
      const proc = spawn(CODEX_CLI, ['exec', prompt], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      const entry = this._running.get(taskId) || { process: null, phase, round };
      entry.process = proc;
      this._running.set(taskId, entry);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', chunk => {
        const text = chunk.toString();
        stdout += text;
        logQueries.append({ task_id: taskId, phase, round, level: 'info', content: text.slice(0, 1000) });
        this.emit('agent:text', { taskId, phase, round, content: text, provider: 'codex' });
      });
      proc.stderr.on('data', chunk => {
        stderr += chunk.toString();
        logQueries.append({ task_id: taskId, phase, round, level: 'error', content: chunk.toString().slice(0, 500) });
      });
      proc.on('close', code => {
        console.log(`[codex close:${phase}] code=${code} len=${stdout.length}`);
        if (code !== 0 && !stdout.trim()) reject(new Error(`Codex exit ${code}: ${stderr.slice(0, 200)}`));
        else resolve(stdout.trim());
      });
      proc.on('error', err => reject(new Error(`Codex spawn failed: ${err.message}`)));
    });
  }

  _claudeRun({ taskId, phase, round, cwd, prompt }) {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--model', CLAUDE_MODEL,
        '--dangerously-skip-permissions',
        // '--setting-sources user' 제거 — CLAUDE_CONFIG_DIR의 harness 전용 설정 사용
        prompt,
      ];

      console.log(`[CLI spawn:${phase}] round=${round} cwd=${cwd}`);

      if (this._deleted.has(taskId)) {
        resolve('');
        return;
      }

      const entry = { process: null, phase, round };
      this._running.set(taskId, entry);

      // CLAUDE_CONFIG_DIR을 명시적으로 env에 포함하여 harness 전용 설정 사용
      const spawnEnv = {
        ...process.env,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      };

      const proc = spawn(CLAUDE_CLI, args, {
        cwd,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.process = proc;

      let finalResult    = null;
      let assistantTexts = [];
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
            // stream-json result 메시지에서 rate limit 감지
            if (!rejected && msg.type === 'result' && msg.is_error) {
              const errText = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result || '');
              if (errText.includes('rate limit') || errText.includes('429') ||
                  errText.toLowerCase().includes('usage limit') || errText.includes('overloaded') ||
                  errText.includes("You've hit the limit") || errText.includes("hit the limit") ||
                  errText.includes("You have reached")) {
                rejected = true;
                proc.kill('SIGTERM');
                reject(new Error('RATE_LIMIT'));
                break;
              }
            }
            // assistant 메시지에서 rate limit 감지 (claude가 텍스트로 알릴 때)
            if (!rejected && msg.type === 'assistant' && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'text') {
                  const t = block.text || '';
                  if (t.includes("You've hit the limit") || t.includes("hit the limit") ||
                      t.includes("You have reached your") || t.includes("usage limit")) {
                    rejected = true;
                    proc.kill('SIGTERM');
                    reject(new Error('RATE_LIMIT'));
                    break;
                  }
                }
              }
            }
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
        if (!rejected && (
          text.includes('rate limit') ||
          text.includes('Rate limit') ||
          text.includes('429') ||
          text.includes('overloaded') ||
          text.includes('Claude AI usage limit') ||
          text.toLowerCase().includes('usage limit') ||
          text.includes("You've hit the limit") ||
          text.includes("You have reached") ||
          text.includes("hit the limit")
        )) {
          rejected = true;
          proc.kill('SIGTERM');
          reject(new Error('RATE_LIMIT'));
        }
        logQueries.append({ task_id: taskId, phase, round, level: 'error', content: text.substring(0, 500) });
      });

      proc.on('close', (code) => {
        const output = (finalResult && finalResult.trim())
          ? finalResult
          : assistantTexts.join('\n').trim();
        console.log(`[CLI close:${phase}] code=${code} outputLen=${output.length} source=${finalResult ? 'result' : 'assistant'}`);
        if (rejected) return;
        if (this._deleted.has(taskId)) {
          resolve(output.trim());
          return;
        }
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
          this.emit('agent:text', { taskId, phase, round, content: block.text, text: block.text });
          if (onAssistantText) onAssistantText(block.text);
        } else if (block.type === 'tool_use') {
          logQueries.append({ task_id: taskId, phase, round, level: 'tool', content: `[도구: ${block.name}]` });
          this.emit('agent:tool', { taskId, phase, round, tool: block.name });
        }
      }
    } else if (msg.type === 'result') {
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
function _findDeployScript(cwd, harnessAbsPath) {
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

    // ecosystem.config.js는 VPS 전용 설정이므로 배포 트리거로 사용하지 않음
    // (pm2가 없는 로컬 환경에서 non-zero exit code로 실패하는 원인)

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
