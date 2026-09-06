// tests/provider_watchdog.test.js
// CLI 행(hang) 감시기 — 실제 프로세스를 띄워서 검증한다.
//
// 이 테스트가 중요한 이유: 감시기가 "있다"는 것과 "실제로 죽인다"는 것은 다르다.
// 목업으로는 그 차이를 못 잡는다. 그래서 진짜 node 프로세스를 띄운다.
// 실행: node tests/provider_watchdog.test.js

import assert from 'assert';
import { spawn } from 'child_process';
import { attachWatchdog, spawnCollect } from '../src/agent/providers/base.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

function waitClose(proc) {
  return new Promise((resolve) => proc.on('close', (code, signal) => resolve({ code, signal })));
}

console.log('\n[1] 출력 없이 매달린 프로세스를 죽인다');
{
  // 아무것도 출력하지 않고 영원히 사는 프로세스 — 물린 CLI의 모습이다.
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wd = attachWatchdog(proc, { idleTimeoutMs: 400, hardTimeoutMs: 60_000, label: '테스트CLI' });

  const started = Date.now();
  const { signal } = await waitClose(proc);
  const elapsed = Date.now() - started;
  wd.clear();

  assert.ok(wd.reason(), '감시기가 종료 사유를 남겨야 한다');
  assert.ok(/행\(hang\)/.test(wd.reason()), `사유에 행 판단이 드러나야 한다: ${wd.reason()}`);
  assert.ok(elapsed < 5000, `idle 타임아웃 근처에서 죽어야 한다 (실제 ${elapsed}ms)`);
  assert.ok(signal === 'SIGTERM' || signal === 'SIGKILL', `시그널로 종료되어야 한다 (실제 ${signal})`);
  ok(`무출력 프로세스를 ${elapsed}ms만에 종료했다`);
}

console.log('\n[2] 출력이 계속 나오면 죽이지 않는다');
{
  // idle 임계(400ms)보다 짧은 간격으로 출력하며 총 1.2초 사는 프로세스.
  // 절대 시간만 보는 감시기라면 이걸 죽인다 — 정상적인 긴 빌드가 여기 해당한다.
  const script = `
    let n = 0;
    const t = setInterval(() => { console.log('tick', ++n); if (n >= 8) { clearInterval(t); } }, 150);
  `;
  const proc = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const wd = attachWatchdog(proc, { idleTimeoutMs: 400, hardTimeoutMs: 60_000, label: '테스트CLI' });
  proc.stdout.on('data', () => wd.notifyActivity());

  const { code } = await waitClose(proc);
  wd.clear();

  assert.strictEqual(wd.reason(), null, `죽이면 안 된다: ${wd.reason()}`);
  assert.strictEqual(code, 0, '정상 종료해야 한다');
  ok('활동 중인 프로세스는 idle 임계를 넘겨도 살아남는다');
}

console.log('\n[3] 절대 상한은 활동 중이어도 적용된다');
{
  // 계속 출력하지만 끝나지 않는 프로세스. idle 감시로는 절대 못 잡는다 —
  // 무한 루프에 빠진 CLI가 로그만 계속 뱉는 경우가 이것이다.
  const script = `setInterval(() => console.log('busy'), 50);`;
  const proc = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const wd = attachWatchdog(proc, { idleTimeoutMs: 60_000, hardTimeoutMs: 500, label: '테스트CLI' });
  proc.stdout.on('data', () => wd.notifyActivity());

  const { signal } = await waitClose(proc);
  wd.clear();

  assert.ok(wd.reason(), '절대 상한으로 종료되어야 한다');
  assert.ok(/넘겨/.test(wd.reason()), `사유가 시간 초과여야 한다: ${wd.reason()}`);
  assert.ok(signal === 'SIGTERM' || signal === 'SIGKILL');
  ok('출력이 계속 나와도 절대 상한을 넘기면 종료된다');
}

console.log('\n[4] spawnCollect가 감시 결과를 실어 돌려준다');
{
  const res = await spawnCollect({
    cmd: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 600,
  });
  assert.ok(res.killReason, 'killReason이 실려야 한다');
  assert.strictEqual(res.timedOut, true);
  assert.ok(res.stderr.includes('[watchdog]'), 'stderr에 감시 사유가 남아야 한다');
  ok('spawnCollect 경로도 행을 잡고 사유를 전달한다');
}

console.log('\n[5] 정상 프로세스는 그대로 통과한다');
{
  const res = await spawnCollect({
    cmd: process.execPath,
    args: ['-e', 'console.log("done")'],
    timeoutMs: 10_000,
  });
  assert.strictEqual(res.code, 0);
  assert.ok(!res.killReason, '죽이면 안 된다');
  assert.ok(res.stdout.includes('done'));
  ok('빠르게 끝나는 프로세스는 영향받지 않는다');
}

console.log(`\n✅ provider_watchdog: ${passed}개 통과\n`);
