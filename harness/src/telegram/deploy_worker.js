// src/telegram/deploy_worker.js
// 하네스 self-kill 방지용 분리 배포 워커
//
// 문제: harness 프로세스가 자기 자신을 pm2 reload/kill 하면 self-kill 발생
// 해결: spawn with detached:true 로 완전히 분리된 자식 프로세스가 배포를 처리
//       → harness가 종료되어도 자식 프로세스는 계속 실행됨

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.resolve(__dirname, '../..');
const LOG_DIR = path.join(HARNESS_ROOT, 'logs');

/**
 * 완전히 분리된 배포 스크립트를 백그라운드에서 실행
 * @returns {Promise<string>} 로그 파일 경로
 */
export function spawnDetached() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(LOG_DIR, `deploy-${timestamp}.log`);
    const scriptPath = path.join(HARNESS_ROOT, 'scripts', 'deploy_detached.sh');

    // 로그 파일을 stdio로 연결하여 분리 프로세스 실행
    const logFd = fs.openSync(logPath, 'w');

    const child = spawn('bash', [scriptPath], {
      cwd: HARNESS_ROOT,
      env: { ...process.env },
      stdio: ['ignore', logFd, logFd],
      detached: true,  // 부모(harness)와 완전히 분리
    });

    child.unref(); // harness가 종료되어도 자식 프로세스는 계속 실행
    fs.closeSync(logFd);

    // 프로세스 시작 오류만 잡음 (시작 후 오류는 로그에서 확인)
    child.on('error', (err) => {
      reject(new Error(`배포 프로세스 시작 실패: ${err.message}`));
    });

    // spawn 성공 시 즉시 로그 경로 반환 (프로세스 완료 대기 안 함)
    setImmediate(() => resolve(logPath));
  });
}
