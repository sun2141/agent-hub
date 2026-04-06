// src/index.js
// 하네스 진입점 — 시작 시 환경변수 필수값 검증 포함

import 'dotenv/config';
import { projectQueries } from './db/db.js';
import { PROJECTS } from './projects.js';
import { AgentRunner } from './agent/runner.js';
import { createApiServer } from './api/server.js';
import { createTelegramBot } from './telegram/bot.js';

// ── 환경변수 필수값 검증 ──────────────────────────────────
function validateEnv() {
  const required = {
    API_KEY:              '최소 32자 랜덤 문자열',
    TELEGRAM_BOT_TOKEN:   '텔레그램 봇 토큰 (BotFather에서 발급)',
    TELEGRAM_CHAT_ID:     '텔레그램 채팅 ID (숫자)',
  };

  const errors = [];

  for (const [key, desc] of Object.entries(required)) {
    const val = process.env[key];
    if (!val || val.trim() === '') {
      errors.push(`  • ${key}: ${desc}`);
    }
  }

  // API_KEY 최소 길이 검증
  const apiKey = process.env.API_KEY;
  if (apiKey && apiKey.length < 32) {
    errors.push(`  • API_KEY: 최소 32자 이상이어야 합니다 (현재 ${apiKey.length}자)`);
  }

  if (errors.length > 0) {
    console.error('\n[Boot] ❌ 필수 환경변수 누락:\n');
    errors.forEach(e => console.error(e));
    console.error('\n  .env 파일을 확인하세요: nano .env\n');
    process.exit(1);
  }
}

validateEnv();

console.log('═══════════════════════════════════════');
console.log('  Agent Harness v1.0.0');
console.log('  Plan → Build → Eval');
console.log('═══════════════════════════════════════');

// 프로젝트 목록 DB에 동기화
projectQueries.seed(PROJECTS);
console.log(`[Boot] 프로젝트 ${PROJECTS.length}개 등록됨`);

// Agent Runner
const agent = new AgentRunner();
console.log('[Boot] Agent runner 준비');

// API 서버
const { server } = createApiServer(agent);
const PORT = parseInt(process.env.PORT || '3000', 10);

server.listen(PORT, '127.0.0.1', () => {
  // 로컬호스트에만 바인딩 — 외부 직접 접근 차단 (Nginx가 앞단에서 처리)
  console.log(`[Boot] API 서버 127.0.0.1:${PORT} (localhost only)`);
  console.log(`[Boot] WebSocket ws://127.0.0.1:${PORT}/ws`);
});

// Telegram 봇
const { notify } = createTelegramBot(agent);
console.log('[Boot] Telegram 봇 준비');

notify('🟢 <b>하네스 시작됨</b>\n/help 로 명령어 확인');

// 콘솔 로그 (phase 레벨만, 상세 내용 제외)
agent.on('phase:start', ({ taskId, phase, round }) => {
  console.log(`[${phase.toUpperCase()}] ${taskId} Round ${round} 시작`);
});

agent.on('phase:complete', ({ taskId, phase, round }) => {
  console.log(`[${phase.toUpperCase()}] ${taskId} Round ${round} 완료`);
});

agent.on('task:complete', ({ taskId, round }) => {
  console.log(`[DONE] ${taskId} — ${round} 라운드`);
});

agent.on('task:failed', ({ taskId, error }) => {
  console.error(`[FAILED] ${taskId} — ${error}`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[종료] ${signal} 수신...`);
  notify('🔴 <b>하네스 종료됨</b>');
  server.close(() => process.exit(0));
  // 5초 후 강제 종료
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// 처리되지 않은 예외 — 프로세스 종료하지 않고 로그만
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
