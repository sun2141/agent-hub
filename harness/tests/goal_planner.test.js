// tests/goal_planner.test.js
// 목표 계층의 계획 검증 규칙 — 나쁜 계획이 실제로 거절되는지가 핵심이다.
// DB·네트워크·LLM 없이 순수 함수만 돌린다.
// 실행: node tests/goal_planner.test.js

import assert from 'assert';
import {
  validatePlan, looksVerifiable, overlappingScopes, parsePlanOutput, buildPlanPrompt,
} from '../src/agent/goalPlanner.js';
import { daysUntil, paceSignal } from '../src/agent/pace.js';
import {
  parseQuietHours, isQuietNow, kstHour, matchProtected, buildItemPrompt,
} from '../src/agent/goalExecutor.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

const ctxWithVerify = {
  project: { name: 'palmoni', stack: 'React', description: '' },
  projectPath: '/tmp/nonexistent',
  verifyScripts: ['typecheck', 'test'],
  allScripts: ['build', 'typecheck', 'test'],
  hasPackageJson: true,
  tree: 'src/\n',
};
const ctxNoVerify = { ...ctxWithVerify, verifyScripts: [], allScripts: ['build'] };

const capNone = { capacity: null, days: null };
const capTight = { capacity: 4, days: 2 };
const capRoomy = { capacity: 100, days: 30 };

const goalBuild = { kind: 'build', title: 't', outcome: 'o', due_date: null };
const goalResearch = { ...goalBuild, kind: 'research' };

function goodPlan(overrides = {}) {
  return {
    rationale: '이유',
    risk_notes: '위험',
    workstreams: [
      { key: 'ws1', name: '인증', file_scope: ['src/auth/'] },
      { key: 'ws2', name: 'UI', file_scope: ['src/components/'] },
    ],
    milestones: [
      { key: 'm1', title: '인증 정비', exit_criteria: 'npm run test 통과' },
    ],
    items: [
      {
        title: '로그인 잠금',
        workstream: 'ws1',
        milestone: 'm1',
        acceptance_criteria: '로그인 실패 3회 시 60초 잠금, 남은 초를 응답에 포함',
        verify_cmd: 'npm run test',
        target_paths: ['src/auth/login.js'],
        est_runs: 1,
      },
    ],
    ...overrides,
  };
}

console.log('\n[1] 검증 가능성 판정');
{
  assert.ok(looksVerifiable('로그인 실패 3회 시 60초 잠금, 남은 초를 응답에 포함'));
  ok('구체적인 조건은 통과한다');

  assert.ok(!looksVerifiable('로그인 개선'));
  assert.ok(!looksVerifiable('성능 최적화'));
  assert.ok(!looksVerifiable('코드 정리'));
  assert.ok(!looksVerifiable('안정성 강화'));
  ok('"개선/최적화/정리/강화"는 거절된다');

  assert.ok(!looksVerifiable(''));
  assert.ok(!looksVerifiable('짧음'));
  ok('빈 값과 너무 짧은 문장은 거절된다');
}

console.log('\n[2] 정상 계획은 통과한다');
{
  const errs = validatePlan(goodPlan(), ctxWithVerify, capRoomy, goalBuild);
  assert.deepStrictEqual(errs, [], `예상 밖 오류: ${errs.join(' | ')}`);
  ok('규칙을 모두 지킨 계획은 오류 0건');
}

console.log('\n[3] 규칙 1 — 검증 불가능한 완료 조건');
{
  const plan = goodPlan();
  plan.items[0].acceptance_criteria = '로그인 개선';
  const errs = validatePlan(plan, ctxWithVerify, capRoomy, goalBuild);
  assert.ok(errs.some(e => e.includes('검증 불가능')), errs.join(' | '));
  ok('모호한 acceptance_criteria를 잡아낸다');
}

console.log('\n[4] 규칙 2 — 판정 수단 없음');
{
  const plan = goodPlan();
  delete plan.items[0].verify_cmd;
  plan.milestones[0].exit_criteria = '';
  const errs = validatePlan(plan, ctxWithVerify, capRoomy, goalBuild);
  assert.ok(errs.some(e => e.includes('판정할 방법')), errs.join(' | '));
  ok('verify_cmd도 exit_criteria도 없으면 거절한다');

  // 마일스톤의 exit_criteria가 있으면 항목에 verify_cmd가 없어도 통과
  const plan2 = goodPlan();
  delete plan2.items[0].verify_cmd;
  const errs2 = validatePlan(plan2, ctxWithVerify, capRoomy, goalBuild);
  assert.deepStrictEqual(errs2, [], errs2.join(' | '));
  ok('마일스톤 exit_criteria가 판정 수단을 대신할 수 있다');
}

console.log('\n[5] 규칙 3 — 검증 스크립트 없는 프로젝트');
{
  const errs = validatePlan(goodPlan(), ctxNoVerify, capRoomy, goalBuild);
  assert.ok(errs.some(e => e.includes('첫 마일스톤')), errs.join(' | '));
  ok('verify 스크립트가 없는데 게이트 구축이 첫 마일스톤이 아니면 거절한다');

  const gated = goodPlan({
    milestones: [
      { key: 'm0', title: '검증 게이트 구축', exit_criteria: 'npm run verify 통과' },
      { key: 'm1', title: '인증 정비', exit_criteria: 'npm run test 통과' },
    ],
  });
  gated.items[0].milestone = 'm1';
  const errs2 = validatePlan(gated, ctxNoVerify, capRoomy, goalBuild);
  assert.deepStrictEqual(errs2, [], errs2.join(' | '));
  ok('첫 마일스톤이 게이트 구축이면 통과한다');

  // research 목표는 코드를 안 건드리므로 이 규칙에서 면제된다
  const errs3 = validatePlan(goodPlan(), ctxNoVerify, capRoomy, goalResearch);
  assert.deepStrictEqual(errs3, [], errs3.join(' | '));
  ok('research 목표는 검증 게이트 규칙에서 면제된다');
}

console.log('\n[6] 규칙 4 — 워크스트림 경로 충돌');
{
  const plan = goodPlan({
    workstreams: [
      { key: 'ws1', name: '인증', file_scope: ['src/auth/'] },
      { key: 'ws2', name: '세션', file_scope: ['src/auth/session.js'] },
    ],
  });
  const errs = validatePlan(plan, ctxWithVerify, capRoomy, goalBuild);
  assert.ok(errs.some(e => e.includes('겹친다')), errs.join(' | '));
  ok('file_scope가 겹치는 워크스트림을 잡아낸다');

  assert.deepStrictEqual(overlappingScopes(['src/a/'], ['src/b/']), []);
  assert.ok(overlappingScopes(['src/a'], ['src/a/x.js']).length > 0);
  assert.ok(overlappingScopes(['src/a/'], ['src/a']).length > 0);
  ok('접두사 겹침을 방향과 무관하게 판정한다');
}

console.log('\n[7] 규칙 5 — 항목 크기와 기한 용량');
{
  const big = goodPlan();
  big.items[0].est_runs = 5;
  const errs = validatePlan(big, ctxWithVerify, capRoomy, goalBuild);
  assert.ok(errs.some(e => e.includes('쪼개라')), errs.join(' | '));
  ok('est_runs가 큰 항목은 쪼개라고 거절한다');

  const many = goodPlan({
    items: Array.from({ length: 6 }, (_, i) => ({
      title: `항목 ${i}`,
      workstream: 'ws1',
      milestone: 'm1',
      acceptance_criteria: `기능 ${i}을 추가하고 응답에 코드 200을 반환한다`,
      verify_cmd: 'npm run test',
      est_runs: 1,
    })),
  });
  const errs2 = validatePlan(many, ctxWithVerify, capTight, goalBuild);
  assert.ok(errs2.some(e => e.includes('용량')), errs2.join(' | '));
  ok('총 est_runs가 기한 용량을 넘으면 거절한다');

  const errs3 = validatePlan(many, ctxWithVerify, capNone, goalBuild);
  assert.ok(!errs3.some(e => e.includes('용량')), errs3.join(' | '));
  ok('기한이 없으면 용량 규칙을 적용하지 않는다');
}

console.log('\n[8] 출력 파싱');
{
  assert.strictEqual(parsePlanOutput('설명\n```json\n{"a":1}\n```\n끝').a, 1);
  ok('코드펜스와 앞뒤 설명이 붙어도 JSON을 뽑아낸다');

  assert.strictEqual(parsePlanOutput('JSON 아님'), null);
  assert.strictEqual(parsePlanOutput(''), null);
  assert.strictEqual(parsePlanOutput('{깨진'), null);
  ok('파싱 불가는 null을 돌려준다 — 예외를 던지지 않는다');
}

console.log('\n[9] 빈 계획 방어');
{
  assert.ok(validatePlan(null, ctxWithVerify, capRoomy, goalBuild).length > 0);
  assert.ok(validatePlan({ items: [] }, ctxWithVerify, capRoomy, goalBuild).length > 0);
  ok('null이나 빈 items는 즉시 거절된다');
}

console.log('\n[10] 프롬프트 조립');
{
  const p = buildPlanPrompt(goalBuild, ctxNoVerify, capNone);
  assert.ok(p.includes('검증 스크립트가 하나도 없다'), '게이트 구축 지시가 들어가야 한다');
  ok('verify 스크립트가 없으면 게이트 구축을 프롬프트에 명시한다');

  const p2 = buildPlanPrompt(goalBuild, ctxWithVerify, capTight);
  assert.ok(p2.includes('약 4회'), '용량이 프롬프트에 들어가야 한다');
  ok('기한 용량이 프롬프트에 전달된다');

  const p3 = buildPlanPrompt(goalBuild, ctxWithVerify, capNone, ['이유A', '이유B']);
  assert.ok(p3.includes('이유A') && p3.includes('이유B'));
  ok('재시도 시 이전 거절 사유가 프롬프트에 붙는다');

  const p4 = buildPlanPrompt(goalResearch, ctxWithVerify, capNone);
  assert.ok(p4.includes('리포트 파일'), 'research 목표 설명이 들어가야 한다');
  ok('research 목표는 산출물이 리포트임을 명시한다');
}

console.log('\n[11] pace 신호');
{
  assert.strictEqual(paceSignal(0.5).level, 'green');
  assert.strictEqual(paceSignal(0.85).level, 'yellow');
  assert.strictEqual(paceSignal(1.5).level, 'red');
  assert.strictEqual(paceSignal(null).level, 'none');
  ok('pace 구간별 신호가 맞다');

  assert.strictEqual(daysUntil(null), null);
  const d = daysUntil('2030-01-01', new Date('2029-12-30T00:00:00Z'));
  assert.strictEqual(d, 3);
  ok('남은 일수를 UTC 기준으로 센다');
}

console.log('\n[12] 조용 시간 — 실행이 아니라 알림만 미룬다');
{
  assert.deepStrictEqual(parseQuietHours('23-8'), { from: 23, to: 8 });
  assert.strictEqual(parseQuietHours('없음'), null);
  ok('조용 시간 표기를 파싱한다');

  // 자정을 넘는 구간(23-8)이 핵심 — 여기서 틀리면 밤새 알림이 그대로 나간다
  const at = (kstHourWanted) => new Date(Date.UTC(2026, 0, 15, (kstHourWanted - 9 + 24) % 24, 0, 0));
  assert.strictEqual(kstHour(at(3)), 3, 'KST 변환');
  assert.strictEqual(isQuietNow('23-8', at(2)), true,  '새벽 2시는 조용 시간');
  assert.strictEqual(isQuietNow('23-8', at(23)), true, '23시는 조용 시간');
  assert.strictEqual(isQuietNow('23-8', at(8)), false, '8시는 해제');
  assert.strictEqual(isQuietNow('23-8', at(14)), false, '오후는 해제');
  ok('자정을 넘는 조용 시간 구간을 정확히 판정한다');
}

console.log('\n[13] 설정 파일 변경 감지 (8/18 vite 오염 대응)');
{
  const flagged = matchProtected([
    'src/auth/login.js',
    'vite.config.cjs',
    'package.json',
    '.github/workflows/ci.yml',
    'src/components/Button.jsx',
    'tsconfig.json',
  ]);
  assert.ok(flagged.includes('vite.config.cjs'));
  assert.ok(flagged.includes('package.json'));
  assert.ok(flagged.includes('.github/workflows/ci.yml'));
  assert.ok(flagged.includes('tsconfig.json'));
  ok('설정 파일 변경을 잡아낸다');

  assert.ok(!flagged.includes('src/auth/login.js'));
  assert.ok(!flagged.includes('src/components/Button.jsx'));
  ok('일반 소스 변경은 통과시킨다');

  assert.deepStrictEqual(matchProtected([]), []);
  assert.deepStrictEqual(matchProtected(['README.md', 'src/a.js']), []);
  ok('설정 변경이 없으면 빈 배열');
}

console.log('\n[14] 항목 프롬프트');
{
  const item = {
    title: '로그인 잠금',
    acceptance_criteria: '실패 3회 시 60초 잠금',
    verify_cmd: 'npm run test',
    target_paths: ['src/auth/login.js'],
  };
  const build = buildItemPrompt(item, { title: '인증 정비', outcome: '완료조건', kind: 'build' });
  assert.ok(build.includes('실패 3회 시 60초 잠금'));
  assert.ok(build.includes('npm run test'));
  assert.ok(build.includes('설정 변경'), 'build 목표는 설정 변경 금지를 프롬프트에 넣는다');
  ok('build 항목 프롬프트에 완료조건·검증명령·설정변경 금지가 들어간다');

  const research = buildItemPrompt(
    { ...item, report_path: 'RELEASE_READINESS.md' },
    { title: '출시 차단 요소 조사', outcome: '완료조건', kind: 'research' }
  );
  assert.ok(research.includes('코드를 변경하지 마라'));
  assert.ok(research.includes('RELEASE_READINESS.md'));
  assert.ok(research.includes('추측으로 채우지 마라'));
  ok('research 항목은 코드 변경 금지와 리포트 경로를 명시한다');
}

console.log(`\n✅ goal_planner: ${passed}개 통과\n`);
