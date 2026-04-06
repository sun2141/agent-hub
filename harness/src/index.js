// src/index.js
// 하네스 진입점

import 'dotenv/config';
import { projectQueries } from './db/db.js';
import { PROJECTS } from './projects.js';
import { AgentRunner } from './agent/runner.js';
import { createApiServer } from './api/server.js';
import { createTelegramBot } from './telegram/bot.js';

console.log('═══════════════════════════════════════');
console.log('  Agent Harness v1.0.0');
console.log('  Plan → Build → Eval');
console.log('═══════════════════════════════════════');

// 1. 프로젝트 목록 DB에 동기화
projectQueries.seed(PROJECTS);
console.log(`[Boot] 프로젝트 ${PROJECTS.length}개 등록됨`);

// 2. Agent Runner (파이프라인 엔진)
const agent = new AgentRunner();
console.log('[Boot] Agent runner 준비');

// 3. API 서버 시작
const { server } = createApiServer(agent);
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`[Boot] API 서버 :${PORT}`);
  console.log(`[Boot] WebSocket ws://localhost:${PORT}/ws`);
});

// 4. Telegram 봇 시작
const { notify } = createTelegramBot(agent);
console.log('[Boot] Telegram 봇 준비');

// 5. 시작 알림
notify('🟢 <b>하네스 시작됨</b>\n/help 로 명령어 확인');

// 6. 콘솔 로그 (디버깅용)
agent.on('agent:text', ({ taskId, phase, content }) => {
  const preview = content.substring(0, 80).replace(/\n/g, ' ');
  console.log(`[${phase}:${taskId}] ${preview}`);
});

agent.on('agent:tool', ({ taskId, phase, tool }) => {
  console.log(`[${phase}:${taskId}] 🔧 ${tool}`);
});

agent.on('task:complete', ({ taskId, round }) => {
  console.log(`[완료] ${taskId} — ${round} 라운드`);
});

agent.on('task:failed', ({ taskId, error }) => {
  console.error(`[실패] ${taskId} — ${error}`);
});

// Graceful shutdown
function shutdown() {
  console.log('\n[종료] 신호 수신...');
  notify('🔴 <b>하네스 종료됨</b>');
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
