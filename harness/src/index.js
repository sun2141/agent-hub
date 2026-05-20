// src/index.js
// 하네스 진입점

import 'dotenv/config';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, projectQueries, taskQueries } from './db/db.js';
import { PROJECTS } from './projects.js';
import { AgentRunner } from './agent/runner.js';
import { createApiServer } from './api/server.js';
import { createTelegramBot } from './telegram/bot.js';

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
  };
  const errors = [];
  for (const [key, desc] of Object.entries(required)) {
    if (!process.env[key]?.trim()) errors.push(`  • ${key}: ${desc}`);
  }
  if (process.env.API_KEY?.length < 32) {
    errors.push(`  • API_KEY: 최소 32자 이상 (현재 ${process.env.API_KEY.length}자)`);
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
    console.log('  대시보드 외부 접근을 위해 SSH 터널을 시작하세요:');
    console.log('    npm run tunnel');
    console.log('  접속 주소: http://91.99.58.70:9091');
    console.log('');
  });

  // 4. Telegram 봇
  const { notify } = createTelegramBot(agent);
  console.log('[Boot] Telegram 봇 준비');

  notify('🟢 <b>하네스 시작됨</b>\n/help 로 명령어 확인');

  // 5. rate_limited 작업은 대시보드 '계속하기' 버튼으로 수동 재개 (자동 재개 스케줄러 제거)

  agent.on('phase:start',    ({ taskId, phase, round }) =>
    console.log(`[${phase.toUpperCase()}] ${taskId} Round ${round} 시작`));
  agent.on('phase:complete', ({ taskId, phase, round }) =>
    console.log(`[${phase.toUpperCase()}] ${taskId} Round ${round} 완료`));
  agent.on('task:complete',  ({ taskId, round }) =>
    console.log(`[DONE] ${taskId} — ${round} 라운드`));
  agent.on('task:failed',    ({ taskId, error }) =>
    console.error(`[FAILED] ${taskId} — ${error}`));

  function shutdown(signal) {
    console.log(`\n[종료] ${signal} 수신...`);
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
