// src/watchdog.js
// 하네스 감시(watchdog) 프로세스

import 'dotenv/config';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 레포 구조: harness-dashboard/harness/src/watchdog.js
// HARNESS_ROOT = harness-dashboard/harness/
// REPO_ROOT    = harness-dashboard/
const HARNESS_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT    = path.resolve(HARNESS_ROOT, '..');
const PID_FILE          = path.join(REPO_ROOT, 'harness.pid');
const WATCHDOG_PID_FILE = path.join(REPO_ROOT, 'watchdog.pid');
const LOG_DIR  = path.join(HARNESS_ROOT, 'logs');
const NODE_BIN = process.execPath;

// ── 설정 ──────────────────────────────────────────────────
const RESTART_DELAY_MS       = 5000;
const MAX_RESTART_BACKOFF_MS = 60000;
const CRASH_THRESHOLD_MS     = 10000;
const MAX_QUICK_RESTARTS     = 5;

let harness          = null;
let restartCount     = 0;
let quickRestartCount = 0;
let lastStartTime    = 0;
let shuttingDown     = false;

// ── PID 파일 관리 ─────────────────────────────────────────
function acquireWatchdogLock() {
  if (fs.existsSync(WATCHDOG_PID_FILE)) {
    const existingPid = fs.readFileSync(WATCHDOG_PID_FILE, 'utf-8').trim();
    try {
      process.kill(Number(existingPid), 0);
      console.error(`[Watchdog] ❌ 이미 실행 중인 watchdog가 있습니다 (PID: ${existingPid})`);
      console.error(`           종료하려면: kill ${existingPid}`);
      process.exit(1);
    } catch {
      console.warn(`[Watchdog] 스테일 watchdog PID 파일 제거 (PID ${existingPid} 없음)`);
      fs.unlinkSync(WATCHDOG_PID_FILE);
    }
  }
  fs.writeFileSync(WATCHDOG_PID_FILE, String(process.pid));
}

function releaseWatchdogLock() {
  try { fs.unlinkSync(WATCHDOG_PID_FILE); } catch { /* 무시 */ }
}

function readHarnessPid() {
  try {
    const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    return Number(pid) || null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function newLogPath() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(LOG_DIR, `harness-${ts}.log`);
}

function startHarness() {
  if (shuttingDown) return;

  lastStartTime = Date.now();
  restartCount++;
  const logPath = newLogPath();

  console.log(`[Watchdog] 하네스 시작 (재시작 #${restartCount})`);
  console.log(`[Watchdog] 로그: ${logPath}`);

  const logFd = fs.openSync(logPath, 'w');

  harness = spawn(NODE_BIN, [path.join(HARNESS_ROOT, 'src', 'index.js')], {
    cwd: HARNESS_ROOT,
    env: { ...process.env },
    stdio: ['ignore', logFd, logFd],
    detached: false,
  });

  fs.closeSync(logFd);

  harness.on('error', (err) => {
    console.error(`[Watchdog] 하네스 프로세스 오류: ${err.message}`);
  });

  harness.on('exit', (code, signal) => {
    if (shuttingDown) {
      console.log('[Watchdog] 정상 종료 감지 — 재시작 안 함');
      return;
    }

    const elapsed = Date.now() - lastStartTime;
    const exitInfo = signal ? `signal=${signal}` : `code=${code}`;
    console.log(`[Watchdog] 하네스 종료 감지 (${exitInfo}, 실행시간=${elapsed}ms)`);

    if (code === 0) {
      console.log('[Watchdog] 정상 종료(코드 0) — 재시작 안 함');
      return;
    }

    let delay = RESTART_DELAY_MS;
    if (elapsed < CRASH_THRESHOLD_MS) {
      quickRestartCount++;
      if (quickRestartCount > MAX_QUICK_RESTARTS) {
        delay = Math.min(
          RESTART_DELAY_MS * Math.pow(2, quickRestartCount - MAX_QUICK_RESTARTS - 1),
          MAX_RESTART_BACKOFF_MS
        );
        console.warn(`[Watchdog] 빠른 재시작 반복 — 백오프 ${delay}ms 대기`);
      }
    } else {
      quickRestartCount = 0;
    }

    console.log(`[Watchdog] ${delay}ms 후 재시작...`);
    setTimeout(startHarness, delay);
  });

  console.log(`[Watchdog] 하네스 PID: ${harness.pid}`);
}

// ── 메인 ──────────────────────────────────────────────────
acquireWatchdogLock();

console.log('═══════════════════════════════════════');
console.log('  Harness Watchdog');
console.log(`  PID: ${process.pid}`);
console.log('═══════════════════════════════════════');

const existingPid = readHarnessPid();
if (existingPid && isAlive(existingPid)) {
  console.log(`[Watchdog] 기존 하네스 감지 (PID: ${existingPid}) — 감시 시작`);
  function pollExisting() {
    if (shuttingDown) return;
    if (!isAlive(existingPid)) {
      console.log(`[Watchdog] 기존 하네스 (PID: ${existingPid}) 종료 감지 — 새로 시작`);
      startHarness();
    } else {
      setTimeout(pollExisting, 2000);
    }
  }
  setTimeout(pollExisting, 2000);
} else {
  startHarness();
}

function shutdown(signal) {
  console.log(`\n[Watchdog] ${signal} 수신 — 종료 중...`);
  shuttingDown = true;
  releaseWatchdogLock();

  if (harness && !harness.killed) {
    console.log('[Watchdog] 하네스 프로세스 종료 중...');
    harness.kill('SIGTERM');
    setTimeout(() => {
      if (harness && !harness.killed) harness.kill('SIGKILL');
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[Watchdog] 치명적 오류:', err.message);
  releaseWatchdogLock();
  process.exit(1);
});
