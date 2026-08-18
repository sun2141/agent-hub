// src/index.js
// 하네스 진입점

import 'dotenv/config';
// ↓ 네트워크 기본값은 어떤 HTTP 클라이언트보다 먼저 잡혀야 한다 (WSL2 IPv6 대응)
import { netDefaultsSummary } from './util/netdefaults.js';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, projectQueries, taskQueries, logQueries } from './db/db.js';
import { PROJECTS } from './projects.js';
import { AgentRunner } from './agent/runner.js';
import { reclaimExpired } from './agent/dispatcher.js';
import { createApiServer } from './api/server.js';
import { createTelegramBot } from './telegram/bot.js';
import { startManagerScanScheduler } from './agent/scanScheduler.js';

// 멀티 프로바이더 자동 회수/재개 (기본 off — off면 기존 수동 재개 방식 유지).
const MULTI_PROVIDER = process.env.MULTI_PROVIDER === 'true';

// ── PID 락 파일 (중복 실행 방지) ─────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(__dirname, '../../harness.pid');

function acquireLock() {
  if (fs.existsSync(PID_FILE)) {
    const existingPid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    // 해당 PID가 실제로 살아있는지 확인
    try {
      process.kill(Number(existingPid), 0); // signal 0 = 존재 확인만
      console.error(`\n[Boot] ❌ 이미 실행 중인 하네스가 있습니다 (PID: ${existingPid})`);
      console.error(`       종료하려면: kill ${existingPid}`);
      console.error(`       강제 시작: rm ${PID_FILE}\n`);
      process.exit(1);
    } catch {
      // PID가 없는 프로세스 → 스테일 락 파일 정리 후 계속
      console.warn(`[Boot] 스테일 락 파일 제거 (PID ${existingPid} 없음)`);
      fs.unlinkSync(PID_FILE);
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function releaseLock() {
  try { fs.unlinkSync(PID_FILE); } catch { /* 무시 */ }
}

// ── 포트 사용 여부 확인 ────────────────────────────────────
function checkPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `포트 ${port}가 이미 사용 중입니다.\n` +
          `점유 프로세스 확인: lsof -i :${port}\n` +
          `종료 후 다시 시작해주세요.`
        ));
      } else {
        reject(err);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(port, '0.0.0.0');
  });
}

function validateEnv() {
  const required = {
    NEON_DATABASE_URL:   'Neon pooled PostgreSQL URL (-pooler 호스트 권장)',
    API_KEY:            '최소 32자 랜덤 문자열 (openssl rand -hex 32)',
    TELEGRAM_BOT_TOKEN: '텔레그램 봇 토큰 (BotFather에서 발급)',
    TELEGRAM_CHAT_ID:   '텔레그램 채팅 ID (숫자)',
    DASHBOARD_PASSWORD: '대시보드 로그인 비밀번호 (없으면 /api/* 가 503 반환)',
  };
  const errors = [];
  const warnings = [];

  for (const [key, desc] of Object.entries(required)) {
    if (!process.env[key]?.trim()) errors.push(`  • ${key}: ${desc}`);
  }
  if (process.env.API_KEY?.length < 32) {
    errors.push(`  • API_KEY: 최소 32자 이상 (현재 ${process.env.API_KEY.length}자)`);
  }

  // CLAUDE_CLI_PATH: 절대경로면 파일 존재/실행 권한 검증
  const claudeCli = process.env.CLAUDE_CLI_PATH?.trim();
  if (!claudeCli) {
    warnings.push(`  • CLAUDE_CLI_PATH 미설정 → PATH의 'claude' 사용 (절대경로 권장)`);
  } else if (path.isAbsolute(claudeCli)) {
    if (!fs.existsSync(claudeCli)) {
      warnings.push(`  • CLAUDE_CLI_PATH=${claudeCli} 파일이 존재하지 않습니다`);
    } else {
      try {
        fs.accessSync(claudeCli, fs.constants.X_OK);
      } catch {
        warnings.push(`  • CLAUDE_CLI_PATH=${claudeCli} 실행 권한 없음`);
      }
    }
  }

  // CLAUDE_CONFIG_DIR: 디렉토리 존재 검증 (없으면 전역 ~/.claude/ hooks가 지연 유발)
  const claudeCfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!claudeCfg) {
    warnings.push(`  • CLAUDE_CONFIG_DIR 미설정 → 기본 ~/.claude/ 사용 (전역 hooks/MCP가 큰 지연 유발 가능)`);
  } else if (!fs.existsSync(claudeCfg)) {
    warnings.push(`  • CLAUDE_CONFIG_DIR=${claudeCfg} 디렉토리가 존재하지 않습니다`);
  }

  // PROJECTS_ROOT: 쉼표로 구분된 모든 경로 존재 검증
  const projRoot = process.env.PROJECTS_ROOT?.trim();
  if (!projRoot) {
    warnings.push(`  • PROJECTS_ROOT 미설정 → 기본 폴백 사용`);
  } else {
    const roots = projRoot.split(',').map(r => r.trim()).filter(Boolean);
    for (const root of roots) {
      if (!fs.existsSync(root)) warnings.push(`  • PROJECTS_ROOT 경로 없음: ${root}`);
    }
  }

  if (warnings.length > 0) {
    console.warn('\n[Boot] ⚠️  환경변수 경고:\n');
    warnings.forEach(w => console.warn(w));
    console.warn('');
  }
  if (errors.length > 0) {
    console.error('\n[Boot] ❌ 필수 환경변수 누락:\n');
    errors.forEach(e => console.error(e));
    console.error('\n  nano .env 로 수정하세요\n');
    process.exit(1);
  }
}

async function main() {
  acquireLock();
  validateEnv();

  console.log('═══════════════════════════════════════');
  console.log('  Agent Harness v1.0.0');
  console.log('  Plan → Build → Eval');
  console.log('═══════════════════════════════════════');
  console.log(`[Boot] CLAUDE_CLI_PATH=${process.env.CLAUDE_CLI_PATH}`);
  console.log(`[Boot] CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}`);
  console.log(`[Boot] CLAUDE_MODEL=${process.env.CLAUDE_MODEL}`);

  // 1. DB 초기화 (비동기)
  await initDb();
  await projectQueries.seed(PROJECTS);
  console.log(`[Boot] 프로젝트 ${PROJECTS.length}개 등록됨`);
  console.log(`[Boot] 네트워크 기본값 — ${netDefaultsSummary()}`);

  const recoveredTasks = await taskQueries.pauseInterruptedActiveTasks();
  if (recoveredTasks.length > 0) {
    console.warn(`[Boot] 재시작 중단 작업 ${recoveredTasks.length}개를 paused로 복구`);
    for (const task of recoveredTasks) {
      await logQueries.append({
        task_id: task.id,
        phase: 'system',
        round: task.round || 0,
        level: 'warn',
        content: `[startup_recovery] 하네스 재시작 감지: ${task.previous_status} 상태 작업을 paused로 전환했습니다. round ${task.previous_round ?? task.round} → ${task.round}. 필요하면 대시보드에서 계속하기로 재개하세요.`,
      });
    }
  }

  // 2. Agent Runner
  const agent = new AgentRunner();
  console.log('[Boot] Agent runner 준비');

  // 3. API 서버
  const PORT = parseInt(process.env.PORT || '3000', 10);

  // 포트 충돌 사전 감지 — 다른 프로세스가 점유 중이면 즉시 종료
  try {
    await checkPortAvailable(PORT);
  } catch (err) {
    console.error(`\n[Boot] ❌ ${err.message}\n`);
    releaseLock();
    process.exit(1);
  }

  const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
  const { server } = createApiServer(agent);
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[Boot] API 서버 ${BIND_HOST}:${PORT}`);
    console.log(`[Boot] WebSocket ws://${BIND_HOST}:${PORT}/ws`);
    console.log(`[Boot] 헬스체크: http://${BIND_HOST}:${PORT}/health`);
    console.log('');
    console.log('  대시보드 외부 접근:');
    console.log('    Vercel rewrite -> http://91.99.58.70/{health,auth,api,ws}');
    console.log('    로컬/임시 터널 사용 시 VITE_API_BASE_URL을 터널 URL로 설정');
    console.log('');
  });

  // 4. Telegram 봇
  const { notify } = createTelegramBot(agent);
  console.log('[Boot] Telegram 봇 준비');

  notify('🟢 <b>하네스 시작됨</b>\n/help 로 명령어 확인');
  if (recoveredTasks.length > 0) {
    notify(
      `⚠️ <b>하네스 재시작 복구</b>\n` +
      `${recoveredTasks.length}개 작업을 <code>paused</code>로 전환했습니다.\n` +
      recoveredTasks.slice(0, 5).map(t => `• <code>${t.id}</code> (${t.previous_status}, round ${t.previous_round ?? t.round}→${t.round})`).join('\n')
    );
  }

  // 5. rate_limited 작업은 대시보드 '계속하기' 버튼으로 수동 재개 (자동 재개 스케줄러 제거)

  agent.on('phase:start',    ({ taskId, phase, round }) =>
    console.log(`[${phase.toUpperCase()}] ${taskId} Round ${round} 시작`));
  agent.on('phase:complete', ({ taskId, phase, round }) =>
    console.log(`[${phase.toUpperCase()}] ${taskId} Round ${round} 완료`));
  agent.on('task:complete',  ({ taskId, round }) =>
    console.log(`[DONE] ${taskId} — ${round} 라운드`));
  agent.on('task:failed',    ({ taskId, error }) =>
    console.error(`[FAILED] ${taskId} — ${error}`));

  // 쿨다운 진입 알림은 bot.js의 task:rate_limited 핸들러가 담당한다.
  //   - 예약 재개(resumeAt 있음)와 수동 재개(resumeAt 없음)를 모두 커버하기 위해 한곳으로 모았다.
  //   - 재개 성공 알림도 예고가 아니라 task:resuming 이벤트(= 실제 파이프라인 시작) 기준이다.

  // 멀티 프로바이더: 주기적으로 쿨다운 해제 프로바이더를 회수하고,
  // 예약 시각이 지난 rate_limited 작업을 자동 재개한다. (watchdog가 프로세스 유지)
  if (MULTI_PROVIDER) {
    const RECLAIM_MS = parseInt(process.env.PROVIDER_RECLAIM_INTERVAL_MS || '60000', 10);
    // 재개가 실패하면 scheduled_resume_at이 그대로 남아 매 틱마다 재시도되므로,
    // 작업별 지수 백오프로 알림/재시도 폭주를 막는다.
    const resumeFailures = new Map();   // taskId -> { count, nextAttemptAt }

    const timer = setInterval(async () => {
      try {
        const reclaimed = await reclaimExpired();
        if (reclaimed.length) console.log(`[reclaim] available 복귀: ${reclaimed.join(', ')}`);

        const due = await taskQueries.getPendingRateLimitedTasks();
        for (const t of due) {
          const prev = resumeFailures.get(t.id);
          if (prev && Date.now() < prev.nextAttemptAt) continue;   // 백오프 대기 중

          console.log(`[reclaim] 예약 재개 시도: ${t.id}`);
          try {
            // resume()이 task:resuming을 emit하고, 그 시점에 텔레그램 ▶️ 알림이 나간다.
            await agent.resume(t.id, { auto: true });
            resumeFailures.delete(t.id);
          } catch (e) {
            const count = (prev?.count || 0) + 1;
            const backoffMin = Math.min(2 ** count, 30);
            resumeFailures.set(t.id, { count, nextAttemptAt: Date.now() + backoffMin * 60_000 });
            console.error(`[reclaim] resume 실패 ${t.id} (${count}회): ${e.message}`);
            // 매번 알리면 시끄럽고, 아예 안 알리면 지금처럼 무음이 된다 → 1회차와 5회차만.
            if (count === 1 || count === 5) {
              notify(
                `❌ <b>자동 재개 실패</b> (${count}회째)\n` +
                `<code>${t.id}</code>\n${String(e.message).slice(0, 200)}\n\n` +
                `${backoffMin}분 뒤 다시 시도합니다. 수동 재개: <code>/resume ${t.id}</code>`
              );
            }
          }
        }
      } catch (e) { console.error(`[reclaim] 오류: ${e.message}`); }
    }, RECLAIM_MS);
    timer.unref?.();
    console.log(`[Boot] 멀티 프로바이더 자동 회수 타이머 활성 (${RECLAIM_MS}ms)`);
  } else {
    // MULTI_PROVIDER=off면 자동 재개 타이머 자체가 없다. rate_limited 작업은 영원히 대기하므로
    // 부팅 시 한 번은 명확히 알려준다 (예전엔 아무 표시도 없었다).
    console.warn('[Boot] ⚠️ MULTI_PROVIDER=off — 자동 재개 타이머 비활성. rate_limited 작업은 /resume 으로만 재개됩니다.');
  }

  // 6. 매니저 루프 자동 스캔 (MANAGER_LOOP=true + MANAGER_SCAN_INTERVAL_MIN>0 일 때만).
  //    자동화 범위는 "제안"까지 — 승인은 /approve, 병합은 GitHub에서 사람이 한다.
  const scanScheduler = startManagerScanScheduler({ notify });
  if (scanScheduler.active) {
    notify(
      `🕒 <b>자동 스캔 활성</b>\n${scanScheduler.config.intervalMin}분 주기로 백로그를 스캔합니다.\n` +
      `승인은 여전히 /approve 로 직접 하셔야 합니다.`
    );
  }

  function shutdown(signal) {
    console.log(`\n[종료] ${signal} 수신...`);
    scanScheduler.stop();
    releaseLock();
    notify('🔴 <b>하네스 종료됨</b>');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException',  (err)    => { releaseLock(); console.error('[uncaughtException]', err.message); process.exit(1); });
  process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
}

main().catch(err => {
  releaseLock();
  console.error('[Boot] 시작 실패:', err.message);
  process.exit(1);
});
