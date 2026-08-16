// src/telegram/bot.js
// Telegram 봇 — 명령 수신 + 이벤트 알림

import TelegramBot from 'node-telegram-bot-api';
import { projectQueries, taskQueries, backlogQueries } from '../db/db.js';
import { spawnDetached } from './deploy_worker.js';
import { runManagerScan, formatScanDigest } from '../agent/manager.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { spawnSync } from 'child_process';

// 매니저 루프 (백로그 제안→승인→실행, 기본 off — MULTI_PROVIDER와 동일한 플래그 패턴)
const MANAGER_LOOP = process.env.MANAGER_LOOP === 'true';
const MANAGER_MAX_CONCURRENT = parseInt(process.env.MANAGER_MAX_CONCURRENT || '1', 10);
const MANAGER_MAX_APPROVALS_PER_DAY = parseInt(process.env.MANAGER_MAX_APPROVALS_PER_DAY || '3', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.resolve(__dirname, '../..');

// ── 쿨다운 영속화 파일 경로 ────────────────────────────────────
const COOLDOWN_FILE = path.join(HARNESS_ROOT, 'data', 'fail_notify_cooldown.json');

// 쿨다운 데이터 로드 (재시작 시에도 유지)
function loadCooldownData() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      const raw = fs.readFileSync(COOLDOWN_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Map으로 변환
      return new Map(Object.entries(parsed));
    }
  } catch (err) {
    console.warn('[Telegram] 쿨다운 파일 로드 실패 (초기화):', err.message);
  }
  return new Map();
}

// 쿨다운 데이터 저장
function saveCooldownData(map) {
  try {
    const dir = path.dirname(COOLDOWN_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj = Object.fromEntries(map.entries());
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[Telegram] 쿨다운 파일 저장 실패:', err.message);
  }
}

const PHASE_EMOJI = {
  planning:     '📋',
  building:     '🔨',
  evaluating:   '🔍',
  done:         '✅',
  failed:       '❌',
  paused:       '⏸',
  needs_review: '⚠️',
};

export function createTelegramBot(agentRunner) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[Telegram] 환경변수 미설정 — 봇 비활성화');
    return { notify: () => {} };
  }

  // TELEGRAM_CHAT_ID는 숫자여야 함
  if (!/^-?\d+$/.test(chatId)) {
    throw new Error('TELEGRAM_CHAT_ID는 숫자 형식이어야 합니다');
  }

  // ── 폴링 에러 자동 재연결 (지수 백오프) ───────────────────
  // ENOTFOUND, ECONNRESET 등 네트워크 일시 단절 시 자동 재연결
  let reconnectAttempt = 0;
  const MAX_RECONNECT_DELAY_MS = 60000;
  const BASE_RECONNECT_DELAY_MS = 2000;
  let bot = null;
  let reconnectTimer = null;

  // ── 화이트리스트 검증 ─────────────────────────────────────
  function isAuthorized(msg) {
    return String(msg.chat.id) === String(chatId);
  }

  // ── 알림 헬퍼 ─────────────────────────────────────────────
  function notify(text) {
    if (!bot) return Promise.resolve();
    const safeText = String(text).substring(0, 4000);
    return bot.sendMessage(chatId, safeText, { parse_mode: 'HTML' })
      .catch(err => console.error('[Telegram] 전송 실패:', err.message));
  }

  // ── 인증된 요청에만 명령어 실행 ───────────────────────────
  function onCommand(pattern, handler) {
    bot.onText(pattern, (msg, match) => {
      if (!isAuthorized(msg)) {
        console.warn(`[Telegram] 미인가 접근 시도: chat_id=${msg.chat.id}`);
        return;
      }
      handler(msg, match);
    });
  }

  // ── 명령어 등록 ───────────────────────────────────────────
  function registerCommands() {
    onCommand(/\/help/, () => {
      notify(
        '<b>🤖 하네스 명령어</b>\n\n' +
        '/status — 시스템 상태\n' +
        '/projects — 프로젝트 목록\n' +
        '/run &lt;project&gt; [rounds:N] &lt;작업내용&gt; — 파이프라인 시작\n' +
        '/resume &lt;taskId&gt; — 일시정지 재개\n' +
        '/stop &lt;taskId&gt; — 작업 중지\n' +
        '/tasks — 최근 작업 이력\n' +
        '/restart — 하네스 프로세스 재시작\n' +
        '/deploy — git push + harness 재시작 (분리 프로세스)\n\n' +
        '<b>파이프라인:</b> 📋 Plan → 🔨 Build → 🔍 Eval → ✅\n\n' +
        '<b>rounds 예시:</b> /run facepick rounds:15 얼굴 인식 개선\n\n' +
        (MANAGER_LOOP
          ? '<b>매니저 루프</b>\n' +
            '/scan — 백로그 신호 스캔 + 제안\n' +
            '/backlog — 대기 중인 제안 목록\n' +
            '/approve &lt;id&gt; — 제안 승인 → 브랜치+PR 모드로 실행\n' +
            '/reject &lt;id&gt; — 제안 거절\n' +
            '/rollback &lt;projectId&gt; — 최근 완료 커밋 되돌리기(revert)\n'
          : '<i>매니저 루프 비활성화 상태 (.env MANAGER_LOOP=true 로 활성화)</i>\n')
      );
    });

    onCommand(/\/status/, () => {
      const s = agentRunner.getStatus();
      let msg = '<b>📊 하네스 상태</b>\n\n';
      msg += `PID: <code>${process.pid}</code>\n`;
      msg += `업타임: ${Math.floor(process.uptime())}초\n\n`;

      if (s.running.length === 0) {
        msg += '⚪ 실행 중인 작업 없음\n';
      } else {
        msg += '<b>실행 중:</b>\n';
        msg += s.running.map(r =>
          `${PHASE_EMOJI[r.phase] || '▶'} <code>${r.taskId}</code>\n` +
          `   ${r.phase} (Round ${r.round})`
        ).join('\n') + '\n';
      }

      if (s.queued > 0) msg += `\n⏳ 대기 중: ${s.queued}개\n`;
      notify(msg);
    });

    onCommand(/\/projects/, async () => {
      const list = await projectQueries.list();
      const msg = '<b>📁 프로젝트 목록</b>\n\n' +
        list.map(p =>
          `• <b>${p.name}</b> (<code>${p.id}</code>)\n` +
          `  ${p.stack || '스택미정'} | 최근: ${p.last_task_status || '없음'}`
        ).join('\n\n');
      notify(msg);
    });

    // /run <projectId> [rounds:N] <prompt>
    onCommand(/\/run (.+)/, async (msg, match) => {
      const parts = match[1].trim().split(' ');
      const projectId = parts[0];

      if (!/^[a-z0-9-]{1,50}$/.test(projectId)) {
        notify('❌ 프로젝트 ID는 영문 소문자/숫자/하이픈만 허용됩니다');
        return;
      }

      let maxRounds;
      let promptStartIdx = 1;
      if (parts.length > 1 && /^rounds:\d+$/i.test(parts[1])) {
        const n = parseInt(parts[1].split(':')[1], 10);
        if (!isNaN(n) && n >= 1 && n <= 20) {
          maxRounds = n;
        }
        promptStartIdx = 2;
      }

      const prompt = parts.slice(promptStartIdx).join(' ');

      if (!prompt || prompt.length > 1000) {
        notify('사용법: /run &lt;projectId&gt; [rounds:N] &lt;작업내용(1000자 이하)&gt;\n예: /run palmoni 기도 목록 페이지 추가\n예: /run facepick rounds:15 얼굴 인식 개선');
        return;
      }

      const project = await projectQueries.get(projectId);
      if (!project) {
        notify(`❌ 프로젝트 없음: <code>${projectId}</code>\n/projects 로 목록 확인`);
        return;
      }

      try {
        const taskId = await agentRunner.run({ projectId, prompt, maxRounds });
        notify(
          `📋 <b>파이프라인 시작</b>\n\n` +
          `ID: <code>${taskId}</code>\n` +
          `프로젝트: ${project.name}\n` +
          `작업: ${prompt.substring(0, 100)}`
        );
      } catch (err) {
        notify(`❌ 시작 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // /resume <taskId>
    onCommand(/\/resume (.+)/, async (msg, match) => {
      const taskId = match[1].trim();
      if (!/^task_[0-9]+_[a-z0-9]+$/.test(taskId)) {
        notify('❌ 잘못된 taskId 형식');
        return;
      }
      try {
        await agentRunner.resume(taskId);
        notify(`▶ 재개: <code>${taskId}</code>`);
      } catch (err) {
        notify(`❌ 재개 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // /stop <taskId>
    onCommand(/\/stop (.+)/, (msg, match) => {
      const taskId = match[1].trim();
      if (!/^task_[0-9]+_[a-z0-9]+$/.test(taskId)) {
        notify('❌ 잘못된 taskId 형식');
        return;
      }
      try {
        agentRunner.stop(taskId);
        notify(`⏹ 중지: <code>${taskId}</code>`);
      } catch (err) {
        notify(`❌ 중지 실패: ${err.message.substring(0, 200)}`);
      }
    });

    onCommand(/\/tasks/, async () => {
      const list = await taskQueries.list(10);
      if (!list.length) { notify('최근 작업 없음'); return; }

      const msg = '<b>📋 최근 작업</b>\n\n' +
        list.map(t =>
          `${PHASE_EMOJI[t.status] || '❓'} <code>${t.id}</code>\n` +
          `   ${t.project_name} | ${t.prompt.substring(0, 40)}...`
        ).join('\n\n');
      notify(msg);
    });

    // /restart — 하네스 프로세스 재시작 (분리 프로세스를 통해 self-kill 방지)
    onCommand(/\/restart/, async () => {
      notify('🔄 <b>하네스 재시작 중...</b>\n\n잠시 후 다시 연결됩니다.');

      const scriptPath = path.join(HARNESS_ROOT, 'scripts', 'deploy_detached.sh');
      if (!fs.existsSync(scriptPath)) {
        // deploy_detached.sh가 없으면 start.sh를 통해 재시작
        try {
          const logPath = await spawnDetached();
          notify(
            `✅ <b>재시작 프로세스 시작됨</b>\n\n` +
            `로그: <code>${logPath}</code>\n` +
            `약 10초 후 하네스가 재시작됩니다.`
          );
        } catch (err) {
          notify(`❌ 재시작 실패: ${err.message.substring(0, 200)}`);
        }
        return;
      }

      try {
        const logPath = await spawnDetached();
        notify(
          `✅ <b>재시작 프로세스 시작됨</b>\n\n` +
          `로그: <code>${logPath}</code>\n` +
          `약 10초 후 하네스가 재시작됩니다.`
        );
      } catch (err) {
        notify(`❌ 재시작 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // /deploy — 별도 자식 프로세스로 git push + 하네스 재시작
    onCommand(/\/deploy(?:\s+(.+))?/, async (msg, match) => {
      const targetArg = match[1]?.trim() || '';

      if (targetArg && !/^[a-z0-9-]{0,30}$/.test(targetArg)) {
        notify('❌ 잘못된 인자. 예: /deploy 또는 /deploy harness');
        return;
      }

      notify('🔄 <b>배포 시작</b>\n\ngit push + harness 재시작 중...');

      try {
        const logPath = await spawnDetached();
        notify(
          `✅ <b>배포 프로세스 시작됨</b>\n\n` +
          `로그: <code>${logPath}</code>\n` +
          `약 10초 후 하네스가 재시작됩니다.`
        );
      } catch (err) {
        notify(`❌ 배포 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // ── 매니저 루프 (백로그 제안→승인→실행) — MANAGER_LOOP=true 일 때만 동작 ──
    function requireManagerLoop() {
      if (!MANAGER_LOOP) {
        notify('⚠️ 매니저 루프가 비활성화되어 있습니다. .env에 MANAGER_LOOP=true 설정 후 재시작하세요.');
        return false;
      }
      return true;
    }

    // /scan — 등록된 프로젝트를 신호 스캔하고 새 제안을 백로그에 저장
    onCommand(/\/scan/, async () => {
      if (!requireManagerLoop()) return;
      notify('🔍 스캔 시작... (프로젝트별 LLM 호출 — 다소 시간이 걸릴 수 있습니다)');
      try {
        const scanResult = await runManagerScan();
        notify(formatScanDigest(scanResult));
      } catch (err) {
        notify(`❌ 스캔 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // /backlog — 대기 중(proposed)인 제안 목록
    onCommand(/\/backlog/, async () => {
      if (!requireManagerLoop()) return;
      const items = await backlogQueries.listPending();
      if (!items.length) { notify('대기 중인 백로그 제안 없음. /scan 으로 새로 찾아보세요.'); return; }
      const msg = '<b>📥 대기 중인 백로그 제안</b>\n\n' +
        items.map(it => `• <code>${it.id}</code> [${it.project_name}] ${it.title}\n  └ ${it.rationale || '-'}`).join('\n\n');
      notify(msg);
    });

    // /approve <backlogId> — 상한 체크 후 branchMode:true로 파이프라인 시작
    onCommand(/\/approve (\S+)/, async (msg, match) => {
      if (!requireManagerLoop()) return;
      const id = match[1].trim();
      if (!/^backlog_[0-9]+_[a-z0-9]+$/.test(id)) { notify('❌ 잘못된 백로그 ID 형식'); return; }

      const item = await backlogQueries.get(id);
      if (!item) { notify(`❌ 백로그 항목 없음: <code>${id}</code>`); return; }
      if (item.status !== 'proposed') { notify(`❌ 이미 처리된 항목입니다 (상태: ${item.status})`); return; }

      const activeManager = await backlogQueries.countActiveManagerTasks();
      if (activeManager >= MANAGER_MAX_CONCURRENT) {
        notify(`❌ 매니저 작업 동시 실행 상한(${MANAGER_MAX_CONCURRENT}) 도달. 진행 중인 작업 완료 후 재시도하세요.`);
        return;
      }
      const approvedToday = await backlogQueries.countApprovedToday();
      if (approvedToday >= MANAGER_MAX_APPROVALS_PER_DAY) {
        notify(`❌ 오늘 승인 상한(${MANAGER_MAX_APPROVALS_PER_DAY}건) 도달. 내일 다시 시도하세요.`);
        return;
      }

      const prompt = `${item.title}\n\n${item.description || ''}`.trim();
      try {
        const taskId = await agentRunner.run({ projectId: item.project_id, prompt, branchMode: true, backlogItemId: id });
        await backlogQueries.markApproved(id, taskId);
        notify(`✅ <b>승인됨</b>\n<code>${id}</code> → <code>${taskId}</code>\n브랜치+PR 모드로 실행됩니다. 완료 시 PR 링크를 알려드립니다(자동 병합 없음).`);
      } catch (err) {
        notify(`❌ 실행 시작 실패: ${err.message.substring(0, 200)}`);
      }
    });

    // /reject <backlogId>
    onCommand(/\/reject (\S+)/, async (msg, match) => {
      if (!requireManagerLoop()) return;
      const id = match[1].trim();
      if (!/^backlog_[0-9]+_[a-z0-9]+$/.test(id)) { notify('❌ 잘못된 백로그 ID 형식'); return; }
      const item = await backlogQueries.get(id);
      if (!item) { notify(`❌ 백로그 항목 없음: <code>${id}</code>`); return; }
      if (item.status !== 'proposed') { notify(`❌ 이미 처리된 항목입니다 (상태: ${item.status})`); return; }
      await backlogQueries.markRejected(id);
      notify(`🗑 거절됨: <code>${id}</code>`);
    });

    // /rollback <projectId> — 가장 최근 완료(done) 작업의 커밋을 git revert + push (break-glass, 직접 실행)
    onCommand(/\/rollback (.+)/, async (msg, match) => {
      if (!requireManagerLoop()) return;
      const projectId = match[1].trim();
      if (!/^[a-z0-9-]{1,50}$/.test(projectId)) { notify('❌ 프로젝트 ID는 영문 소문자/숫자/하이픈만 허용됩니다'); return; }

      const project = await projectQueries.get(projectId);
      if (!project) { notify(`❌ 프로젝트 없음: <code>${projectId}</code>`); return; }

      // branch_mode(매니저 승인) 작업은 제외 — 그 커밋은 미병합 task 브랜치에만 있어서
      // 기본 브랜치에서 revert할 수 없다. 취소하려면 PR을 닫으면 된다.
      const lastDone = await taskQueries.getLastDoneWithCommit(projectId);
      if (!lastDone?.commit_sha) {
        notify(`❌ 롤백할 커밋을 찾지 못했습니다 (direct push로 완료된 작업 없음): <code>${projectId}</code>\n매니저 승인 작업은 PR을 닫아서 취소하세요.`);
        return;
      }

      // 진행 중인 작업이 있으면 롤백 금지 — 에이전트가 쓰고 있는 워킹트리를 건드리게 된다.
      const activeTask = await taskQueries.getActiveForProject(projectId);
      if (activeTask) {
        notify(`❌ 실행 중인 작업이 있어 롤백할 수 없습니다: <code>${activeTask.id}</code> (${activeTask.status})`);
        return;
      }

      notify(`⏪ <b>롤백 시작</b>\n프로젝트: ${project.name}\n대상 커밋: <code>${lastDone.commit_sha.slice(0, 10)}</code> (task=<code>${lastDone.id}</code>)`);
      try {
        const rootRes = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: project.path, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
        if (rootRes.error || rootRes.status !== 0) throw new Error('git 저장소를 찾을 수 없습니다');
        const gitRoot = rootRes.stdout.trim();

        // 사전 체크 1: 워킹트리가 clean해야 한다. dirty면 revert가 사용자의 미커밋 변경과
        // 섞이거나 중간 상태로 멈춘다.
        const dirtyRes = spawnSync('git', ['status', '--porcelain'], { cwd: gitRoot, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
        const dirty = (dirtyRes.stdout || '').trim();
        if (dirty) {
          throw new Error(`워킹트리에 커밋되지 않은 변경이 있습니다. 정리 후 재시도하세요:\n${dirty.split('\n').slice(0, 8).join('\n')}`);
        }

        // 사전 체크 2: 현재 브랜치가 task/* 면 중단 — 롤백은 기본 브랜치에서만.
        const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: gitRoot, encoding: 'utf8', timeout: 5_000, stdio: 'pipe' });
        const currentBranch = (branchRes.stdout || '').trim();
        if (currentBranch.startsWith('task/')) {
          throw new Error(`현재 브랜치가 <code>${currentBranch}</code> 입니다. 기본 브랜치로 전환 후 재시도하세요.`);
        }

        // 사전 체크 3: 대상 커밋이 현재 HEAD의 조상이어야 revert가 의미를 갖는다.
        const ancestorRes = spawnSync('git', ['merge-base', '--is-ancestor', lastDone.commit_sha, 'HEAD'], { cwd: gitRoot, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
        if (ancestorRes.status !== 0) {
          throw new Error(`대상 커밋이 현재 브랜치(${currentBranch}) 히스토리에 없습니다. 이미 되돌렸거나 다른 브랜치의 커밋입니다.`);
        }

        const revertRes = spawnSync('git', ['revert', '--no-edit', lastDone.commit_sha], { cwd: gitRoot, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' });
        if (revertRes.error || revertRes.status !== 0) {
          // 충돌 등으로 중간 상태에 멈췄으면 되돌려서 저장소를 원상 복구한다.
          spawnSync('git', ['revert', '--abort'], { cwd: gitRoot, encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
          throw new Error((revertRes.stderr || revertRes.stdout || 'git revert 실패').trim().slice(0, 300));
        }

        const pushRes = spawnSync('git', ['push'], { cwd: gitRoot, encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
        if (pushRes.error || pushRes.status !== 0) {
          const pushErr = (pushRes.stderr || pushRes.stdout || 'git push 실패').trim().slice(0, 300);
          throw new Error(`revert 커밋은 로컬에 생성됐지만 push에 실패했습니다 (${currentBranch}):\n${pushErr}`);
        }

        notify(`✅ <b>롤백 완료</b>\n${project.name} (${currentBranch})에서 <code>${lastDone.commit_sha.slice(0, 10)}</code>를 되돌리고 push했습니다.`);
      } catch (err) {
        notify(`❌ 롤백 실패: ${err.message.substring(0, 400)}`);
      }
    });
  }

  // ── 에이전트 이벤트 → 텔레그램 알림 ───────────────────────
  // 프로젝트별 마지막 실패 알림 시간 (알림 쿨다운 추적용)
  // 파일에서 로드하여 하네스 재시작 시에도 쿨다운 유지
  const _lastFailNotify = loadCooldownData(); // projectId → { lastNotify, failCount }
  const FAIL_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000; // 10분 쿨다운
  // 연속 실패 횟수가 이 이상이면 알림 완전 억제 (빌드 실패 반복 방지)
  const MAX_CONSECUTIVE_FAIL_NOTIFY = 3;

  function registerAgentEvents() {
    agentRunner.on('phase:start', ({ taskId, phase, round }) => {
      // planning 시작만 알림 (building/evaluating은 중간 단계라 생략)
      if (phase === 'planning') {
        notify(`${PHASE_EMOJI[phase] || '▶'} <b>${phase}</b>\n<code>${taskId}</code>`);
      }
    });

    agentRunner.on('task:complete', ({ taskId, round, evalResult, maxRoundsReached, projectId, reportInfo, prUrl }) => {
      const flag = maxRoundsReached ? ' (최대 라운드 도달)' : '';
      // 작업 완료 시 해당 프로젝트의 연속 실패 카운터 리셋
      const pid = projectId || taskId;
      if (_lastFailNotify.has(pid)) {
        const entry = _lastFailNotify.get(pid);
        entry.failCount = 0;
        saveCooldownData(_lastFailNotify);
      }
      const prNote = prUrl ? `\n\n🔀 <b>PR:</b> ${prUrl}\n(자동 병합 없음 — 확인 후 직접 병합하세요)` : '';
      if (reportInfo?.telegramSummary) {
        notify(`✅ <b>완료</b>${flag}\n\n${reportInfo.telegramSummary}${prNote}`);
      } else {
        notify(
          `✅ <b>완료</b>${flag}\n\n` +
          `ID: <code>${taskId}</code>\n` +
          `총 라운드: ${round}\n` +
          `평가 점수: ${evalResult?.score ?? '-'}/100` +
          prNote
        );
      }
    });

    agentRunner.on('task:needs_review', ({ taskId, round, evalResult, unresolvedIssues, reportInfo, projectId }) => {
      // 완료가 아니므로 실패 카운터는 건드리지 않음 (알림 억제 대상도 아님 — 검토는 사용자 액션 필요)
      const issuePreview = Array.isArray(evalResult?.issues)
        ? evalResult.issues.slice(0, 3).map(x => `• ${String(x).substring(0, 80)}`).join('\n')
        : '';
      if (reportInfo?.telegramSummary) {
        notify(`⚠️ <b>검토 필요</b> — 최대 라운드 도달, 기준 미충족\n\n${reportInfo.telegramSummary}\n\n커밋·배포는 보류됨. 대시보드에서 리포트 확인 후 새 작업으로 재시도하세요.`);
      } else {
        notify(
          `⚠️ <b>검토 필요</b> — 최대 라운드 도달, 기준 미충족\n\n` +
          `ID: <code>${taskId}</code>\n` +
          `라운드: ${round} | 점수: ${evalResult?.score ?? '-'}/100 | 미해결: ${unresolvedIssues ?? '-'}개\n` +
          (issuePreview ? `\n<b>미해결 항목:</b>\n${issuePreview}\n` : '') +
          `\n커밋·배포는 보류됨. 대시보드에서 리포트 확인 후 새 작업으로 재시도하세요.`
        );
      }
    });

    agentRunner.on('task:paused', ({ taskId, reason }) => {
      const label = reason === 'rate_limit' ? '사용량 한도 도달' : '수동 중지';
      notify(
        `⏸ <b>일시정지</b>\n\n` +
        `ID: <code>${taskId}</code>\n` +
        `사유: ${label}\n\n` +
        (reason === 'rate_limit' ? `/resume ${taskId} 으로 재개` : '')
      );
    });

    agentRunner.on('task:failed', ({ taskId, error, projectId }) => {
      const now = Date.now();
      const pid = projectId || taskId;

      // 기존 쿨다운 항목 읽기
      const entry = _lastFailNotify.get(pid) || { lastNotify: 0, failCount: 0 };
      const lastNotify = entry.lastNotify || 0;
      const failCount = (entry.failCount || 0) + 1;

      // 연속 실패 횟수가 MAX_CONSECUTIVE_FAIL_NOTIFY 초과 시 알림 완전 억제
      if (failCount > MAX_CONSECUTIVE_FAIL_NOTIFY) {
        console.log(`[Telegram] task:failed 연속 실패 ${failCount}회 — 알림 완전 억제 (${pid})`);
        // 카운트만 업데이트, lastNotify는 갱신 안 함
        _lastFailNotify.set(pid, { lastNotify, failCount });
        saveCooldownData(_lastFailNotify);
        return;
      }

      // 10분 쿨다운: 같은 프로젝트 실패 알림이 10분 내 반복되면 생략
      if (now - lastNotify < FAIL_NOTIFY_COOLDOWN_MS) {
        console.log(`[Telegram] task:failed 알림 쿨다운 중 (${pid}, failCount=${failCount}) — 생략`);
        _lastFailNotify.set(pid, { lastNotify, failCount });
        saveCooldownData(_lastFailNotify);
        return;
      }

      // 알림 발송
      _lastFailNotify.set(pid, { lastNotify: now, failCount });
      saveCooldownData(_lastFailNotify);

      const suppressNote = failCount >= MAX_CONSECUTIVE_FAIL_NOTIFY
        ? `\n⚠️ 연속 ${failCount}회 실패. 이후 알림이 억제됩니다.`
        : '';

      notify(
        `❌ <b>실패</b>\n\n` +
        `ID: <code>${taskId}</code>\n` +
        `오류: ${(error || '').substring(0, 200)}` +
        suppressNote
      );
    });
  }

  // ── 봇 인스턴스 생성 함수 ─────────────────────────────────
  function initBot() {
    if (bot) {
      try { bot.stopPolling(); } catch { /* 무시 */ }
    }

    bot = new TelegramBot(token, {
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 },
      },
    });

    // 텔레그램 API가 거절한 이유(409/401 등)는 err.response.body 에만 들어 있다.
    // err.code는 API 오류면 전부 'ETELEGRAM'이라, 그것만 찍으면 "다른 인스턴스가 폴링 중"인지
    // "토큰이 틀렸는지" 구분이 안 된다 — 무인 운영에서 원인 파악이 불가능해진다.
    function describeTelegramError(err) {
      const code = err?.code || 'unknown';
      const apiCode = err?.response?.body?.error_code;
      const desc = err?.response?.body?.description || err?.message || '';
      if (!apiCode && !desc) return code;
      return `${code}${apiCode ? ` ${apiCode}` : ''}${desc ? `: ${desc}` : ''}`;
    }

    // 같은 원인으로 폴링(7초)마다 로그가 쌓이면 journal이 금방 못 쓰게 된다.
    // 동일 오류는 처음 한 번, 이후 5분 간격으로만 남기고 생략 횟수를 함께 표시한다.
    let lastPollErrKey = null;
    let lastPollErrAt = 0;
    let pollErrRepeat = 0;
    const POLL_ERR_LOG_INTERVAL_MS = 5 * 60 * 1000;

    // 네트워크 에러 자동 재연결
    bot.on('polling_error', (err) => {
      const errStr = err.code || err.message || String(err);
      const isNetworkError = /ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network/i.test(errStr);

      if (!isNetworkError) {
        const detail = describeTelegramError(err);
        const now = Date.now();
        if (detail === lastPollErrKey && now - lastPollErrAt < POLL_ERR_LOG_INTERVAL_MS) {
          pollErrRepeat++;
          return;
        }
        const repeated = pollErrRepeat > 0 ? ` (동일 오류 ${pollErrRepeat}회 생략됨)` : '';
        lastPollErrKey = detail; lastPollErrAt = now; pollErrRepeat = 0;

        console.error(`[Telegram] 폴링 오류: ${detail}${repeated}`);
        const apiCode = err?.response?.body?.error_code;
        if (apiCode === 409) {
          console.error('[Telegram] → 같은 봇 토큰을 다른 인스턴스가 폴링 중입니다.');
          console.error('[Telegram]   맥/VPS 등 다른 하네스를 정지하세요 — 한 번에 한 대만 가능합니다.');
        } else if (apiCode === 401) {
          console.error('[Telegram] → 토큰이 유효하지 않습니다. .env의 TELEGRAM_BOT_TOKEN을 확인하세요.');
          console.error('[Telegram]   (.env를 옮기는 과정에서 값이 잘렸을 수 있습니다.)');
        }
        return;
      }

      if (isNetworkError) {
        reconnectAttempt++;
        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt - 1),
          MAX_RECONNECT_DELAY_MS
        );
        console.warn(`[Telegram] 네트워크 오류 (${errStr}) — ${delay}ms 후 재연결 (시도 #${reconnectAttempt})`);

        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          console.log('[Telegram] 재연결 중...');
          initBot();
        }, delay);
      } else {
        console.error('[Telegram] 폴링 오류:', errStr);
      }
    });

    // 메시지 수신 시 재연결 카운터 리셋
    bot.on('message', () => {
      if (reconnectAttempt > 0) {
        console.log('[Telegram] 연결 복구됨');
        reconnectAttempt = 0;
      }
    });

    registerCommands();
    console.log('[Telegram] 봇 시작됨');
  }

  // agentRunner 이벤트 핸들러는 initBot() 밖에서 한 번만 등록
  // (initBot은 재연결 시에도 호출되므로 중복 등록 방지)
  registerAgentEvents();

  initBot();

  return { get bot() { return bot; }, notify };
}
