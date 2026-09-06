// tests/preflight_gate.test.js
// preflight의 프로바이더 사용 판정(provider_in_use)을 실제 bash로 실행해 고정한다.
// 실행: node tests/preflight_gate.test.js
//
// 왜 테스트하나: 이 함수가 틀리면 preflight가 두 방향으로 거짓말한다.
//   - 쓰는 프로바이더를 "미사용"으로 봐서 CLI 부재를 놓치면, 실행 중에 터진다.
//   - 안 쓰는 프로바이더를 "사용"으로 봐서 ✗를 상수로 만들면, 사람이 ✗ 자체를 무시하게 된다.
// 두 번째가 8/18 사고("20개 전부 ✓인데 커밋 불가")와 같은 계열의 고장이다.

import assert from 'assert';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, '..', 'scripts', 'preflight.sh'), 'utf8');

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

console.log('\n[1] provider_in_use 함수가 preflight.sh에 존재한다');
{
  const start = script.indexOf('provider_in_use() {');
  assert.notStrictEqual(start, -1, 'provider_in_use 정의를 찾지 못했다');
  ok('정의 발견');

  // 정의 블록만 잘라낸다 — preflight 본문은 DB/네트워크를 건드리므로 통째로 실행하지 않는다.
  const end = script.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, 'provider_in_use 정의의 끝을 찾지 못했다');
  var fnSrc = script.slice(start, end + 3);
}

// 잘라낸 함수를 그대로 실행한다. "있다"와 "맞게 판단한다"는 다르다.
const decide = (adapter, { enabled, plan = '', build = '', review = '' }) => {
  const probe = [
    'set -u',
    `ENABLED_PROVIDERS=${JSON.stringify(enabled)}`,
    `PROVIDER_PLAN=${JSON.stringify(plan)}`,
    `PROVIDER_BUILD=${JSON.stringify(build)}`,
    `PROVIDER_REVIEW=${JSON.stringify(review)}`,
    fnSrc,
    `if provider_in_use ${adapter}; then echo USE; else echo SKIP; fi`,
  ].join('\n');
  return execFileSync('bash', ['-c', probe], { encoding: 'utf8' }).trim();
};

console.log('\n[2] DB의 enabled 목록이 판정의 근거다');
{
  assert.strictEqual(decide('claude', { enabled: 'claude codex' }), 'USE');
  ok('활성 목록에 있으면 사용 대상');

  assert.strictEqual(decide('antigravity', { enabled: 'claude codex' }), 'SKIP');
  ok('활성 목록에 없으면 미사용 — 설치돼 있지 않아도 ✗가 아니다');

  assert.strictEqual(decide('antigravity', { enabled: 'claude codex antigravity' }), 'USE');
  ok('나중에 활성화하면 자동으로 다시 검사 대상이 된다');
}

console.log('\n[3] 부분 일치로 오판하지 않는다');
{
  assert.strictEqual(decide('codex', { enabled: 'codex-preview' }), 'SKIP');
  ok('codex-preview는 codex가 아니다');

  assert.strictEqual(decide('gravity', { enabled: 'antigravity' }), 'SKIP');
  ok('antigravity의 일부가 gravity로 잡히지 않는다');
}

console.log('\n[4] DB를 못 읽으면 env 핀으로 판정하고, 모르면 "필요하다"로 본다');
{
  assert.strictEqual(
    decide('antigravity', { enabled: '__UNKNOWN__', plan: 'antigravity', build: 'claude', review: 'codex' }),
    'USE');
  ok('DB 불명 + Plan에 핀 고정 → 사용 대상 (부재를 놓치지 않는다)');

  assert.strictEqual(
    decide('antigravity', { enabled: '__UNKNOWN__', plan: 'claude', build: 'claude', review: 'codex' }),
    'SKIP');
  ok('DB 불명 + 어느 단계에도 안 쓰임 → 미사용');

  assert.strictEqual(
    decide('claude', { enabled: '__UNKNOWN__', plan: '', build: '', review: '' }),
    'SKIP');
  ok('DB 불명 + env도 비어 있으면 판정 근거가 없다 (기본값은 dispatcher가 따로 가진다)');
}

console.log('\n[5] 정의되지 않은 함수를 부르는 경로가 남아 있지 않다');
{
  // 8/18 이후 추가된 커밋 실동작 검사의 실패 경로가 fail()을 불렀는데 fail은 정의된 적이 없다.
  // 가장 중요한 검사의 실패 출력이 통째로 사라지는 종류의 버그다.
  const defined = new Set((script.match(/^(\w+)\(\)\s*\{/gm) || []).map(m => m.replace(/\(\).*/, '')));
  const called = new Set((script.match(/^\s*(ok|bad|warn|skip|fail|note)\s+"/gm) || [])
    .map(m => m.trim().split(/\s+/)[0]));
  for (const c of called) {
    assert.ok(defined.has(c), `preflight.sh가 정의되지 않은 ${c}() 를 호출한다`);
  }
  ok(`보고 함수 호출 ${called.size}종이 전부 정의돼 있다`);
}

console.log(`\n✅ preflight_gate: ${passed}개 통과\n`);
