// tests/net_defaults.test.js
// WSL2 IPv6 경합 대응(src/util/netdefaults.js) 검증. 네트워크 호출 없음.
// 실행: node tests/net_defaults.test.js

import assert from 'assert';
import dns from 'dns';
import net from 'net';
import { execFileSync } from 'child_process';
import { netDefaultsSummary } from '../src/util/netdefaults.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

// 자식 프로세스로 env를 바꿔가며 확인 (모듈은 한 번만 평가되므로)
function run(env = {}) {
  return execFileSync(
    process.execPath,
    ['-e', "import('./src/util/netdefaults.js').then(m => console.log(m.netDefaultsSummary()))"],
    { env: { ...process.env, ...env }, encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname }
  ).trim();
}

console.log('\n[1] import 만으로 전역 기본값이 잡힌다');
{
  assert.strictEqual(dns.getDefaultResultOrder(), 'ipv4first');
  ok('DNS 결과 순서가 ipv4first');

  // 핵심: Node 기본 250ms는 유럽권 RTT(텔레그램 ~300~800ms)보다 짧아 IPv4가 매번 밀린다.
  assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), 3000);
  ok('Happy Eyeballs 시도 간격이 250ms → 3000ms');

  assert.match(netDefaultsSummary(), /dns=ipv4first, autoSelectFamilyTimeout=3000ms/);
  ok('요약 문자열이 부팅 로그에 쓸 형태로 나온다');
}

console.log('\n[2] 환경변수로 조정 가능하다');
{
  assert.match(run({ NET_AUTOSELECT_TIMEOUT_MS: '5000' }), /autoSelectFamilyTimeout=5000ms/);
  ok('NET_AUTOSELECT_TIMEOUT_MS 로 시도 간격 조정');

  // IPv6가 정상인 환경으로 되돌리는 탈출구
  assert.match(run({ DNS_RESULT_ORDER: 'verbatim' }), /dns=verbatim/);
  ok('DNS_RESULT_ORDER=verbatim 으로 원래 동작 복원');
}

console.log('\n[3] 이상값을 넣어도 죽지 않는다');
{
  // setDefaultAutoSelectFamilyAttemptTimeout(0)은 예외를 던진다 → 최소 10으로 클램프해야 함
  assert.match(run({ NET_AUTOSELECT_TIMEOUT_MS: '0' }), /autoSelectFamilyTimeout=3000ms/);
  ok('0을 주면 기본값으로 되돌아간다 (예외로 부팅이 막히지 않음)');

  assert.match(run({ NET_AUTOSELECT_TIMEOUT_MS: '이상한값' }), /autoSelectFamilyTimeout=3000ms/);
  ok('숫자가 아닌 값도 기본값으로 처리된다');
}

console.log(`\n✅ net_defaults: ${passed}개 통과\n`);
