// tests/verify_failure.test.js
// 검증 게이트 실패의 환경/코드 분류를 고정한다.
// 실행: node tests/verify_failure.test.js

import assert from 'assert';
import { classifyVerifyFailure } from '../src/agent/verifyFailure.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const kind = (output, label = 'npm run test') => classifyVerifyFailure({ label, output }).kind;

console.log('\n[1] 고칠 수 없는 것은 환경으로 분류한다');
{
  // palmoni 실사례: lockfile에 맥 바이너리만 있어 Linux에서 rollup 네이티브가 없다.
  assert.strictEqual(kind("Error: Cannot find module '@rollup/rollup-linux-x64-gnu'"), 'environment');
  ok('외부 패키지 모듈 누락');

  assert.strictEqual(kind('Loading PostCSS Plugin failed: Cannot find native binding.'), 'environment');
  ok('네이티브 바인딩 없음');

  assert.strictEqual(kind('Error: /lib/x.node: invalid ELF header'), 'environment');
  ok('다른 플랫폼용 바이너리');

  assert.strictEqual(kind('FATAL ERROR: JavaScript heap out of memory'), 'environment');
  ok('메모리 부족');

  assert.strictEqual(kind('sh: 1: vitest: command not found'), 'environment');
  ok('명령 없음');

  assert.strictEqual(kind('npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device', 'npm install'), 'environment');
  ok('의존성 설치 실패는 라벨만으로 환경');
}

console.log('\n[2] 고칠 수 있는 것은 코드로 남긴다 — 이쪽 오판이 훨씬 비싸다');
{
  assert.strictEqual(kind("Cannot find module './components/PrayerCard'"), 'code');
  ok('상대 경로 모듈 누락 = 에이전트가 파일을 지웠거나 경로를 틀렸다');

  assert.strictEqual(kind("Cannot find module '@/hooks/useLoop'"), 'code');
  ok('별칭(@/) 경로도 프로젝트 내부다');

  assert.strictEqual(kind("Cannot find module 'vitest'\nCannot find module './setup.js'"), 'code');
  ok('외부·내부가 섞이면 코드 — 고칠 수 있는 게 하나라도 있으면 돌려보낸다');

  assert.strictEqual(kind('AssertionError: expected 4 to be 5'), 'code');
  ok('테스트 실패');

  assert.strictEqual(kind("error  'x' is assigned a value but never used  no-unused-vars"), 'code');
  ok('린트 오류');

  assert.strictEqual(kind('[verify] 600초 타임아웃으로 강제 종료'), 'code');
  ok('타임아웃은 코드로 본다 — 멈춰 있는 테스트는 대개 코드 문제고, 확신 없이 봐주면 안 된다');

  assert.strictEqual(kind(''), 'code');
  assert.strictEqual(classifyVerifyFailure({}).kind, 'code');
  ok('출력이 없어도 기본값은 코드 (증거 없이 환경으로 내리지 않는다)');
}

console.log('\n[3] 사유 문자열이 알림에 쓸 만큼 구체적이다');
{
  const r = classifyVerifyFailure({ label: 'npm run build', output: "Cannot find module '@rollup/rollup-linux-x64-gnu'" });
  assert.strictEqual(r.kind, 'environment');
  assert.ok(r.why.includes('@rollup/rollup-linux-x64-gnu'), '어떤 패키지인지 사유에 들어가야 한다');
  ok(`사유: ${r.why}`);

  assert.strictEqual(classifyVerifyFailure({ output: 'AssertionError' }).why, null);
  ok('코드 실패에는 사유가 없다');
}

console.log('\n[4] 배선 — 분류 결과가 실제로 흐른다');
{
  // DB 없이 검사할 수 있는 계약만 본다. 분류기가 맞아도 배선이 없으면 아무 일도 안 일어난다.
  const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

  const runner = read('src/agent/runner.js');
  assert.ok(/classifyVerifyFailure/.test(runner), 'runner가 분류기를 쓰지 않는다');
  assert.ok(/failureKind: err\.failureKind \|\| 'code'/.test(runner),
    "task:failed가 failureKind를 싣지 않는다");
  ok('runner: 환경 실패를 분류하고 task:failed에 실어 보낸다');

  // 환경 실패는 에이전트에게 돌려보내지 않고 즉시 던져야 한다.
  // 돌려보내면 MAX_EVAL_ROUNDS(기본 10)를 전부 태운다.
  const gated = runner.slice(runner.indexOf('_runGatedEvaluator'));
  const envBranch = gated.slice(0, gated.indexOf('return {'));
  assert.ok(/kind === 'environment'/.test(envBranch) && /throw err/.test(envBranch),
    '환경 실패가 라운드 피드백보다 먼저 중단되지 않는다');
  ok('runner: 환경 실패는 라운드를 소진하지 않고 즉시 중단한다');

  const exec = read('src/agent/goalExecutor.js');
  assert.ok(/failureKind === 'environment'/.test(exec), 'goalExecutor가 환경 실패를 구분하지 않는다');
  const envIdx = exec.indexOf("failureKind === 'environment'");
  const breakerIdx = exec.indexOf('recentFailures');
  const returnIdx = exec.indexOf('return;', envIdx);
  assert.ok(returnIdx !== -1 && returnIdx < breakerIdx,
    '환경 실패가 목표 차단기 집계 앞에서 빠져나가지 않는다');
  ok('goalExecutor: 환경 실패는 차단기 집계 전에 반환된다');

  // 차단기가 세는 곳과 실행기가 쓰는 곳이 어긋나면 차단기는 죽는다 (실제로 죽어 있었다).
  const goals = read('src/db/goals.js');
  const rf = goals.slice(goals.indexOf('async recentFailures'));
  const rfBody = rf.slice(0, rf.indexOf('},'));
  assert.ok(/goal_events/.test(rfBody), 'recentFailures가 이벤트를 세지 않는다');
  assert.ok(/item_failed/.test(rfBody) && /item_blocked/.test(rfBody), '집계 대상 kind가 없다');
  assert.ok(!/item_blocked_env/.test(rfBody), '환경 실패가 차단기 집계에 들어간다');
  ok('recentFailures: 이벤트를 세고, 환경 실패는 제외한다');

  assert.ok(!/goalItemQueries\.setStatus\([^,]+,\s*'failed'/.test(exec),
    "실행기가 항목을 'failed'로 만든다면 recentFailures를 그 기준으로 되돌려야 한다");
  ok("goalExecutor: 항목 상태에 'failed'를 쓰지 않는다 (차단기가 이벤트를 세는 근거)");
}

console.log(`\n✅ verify_failure: ${passed}개 통과\n`);
