// tests/task_status.test.js
// 작업 상태 문자열이 갈라지지 않게 고정한다.
//
// 9/9 사고: 'reviewed' 상태를 새로 만들면서 종료 상태 목록(SQL 리터럴)에 넣지
// 않았다. 그 상태의 branch_mode 작업이 영원히 "실행 중"으로 잡혀 동시 실행
// 상한을 점유하고, /approve·백로그 버튼·목표 자동 실행까지 브랜치 경로 전체가
// 막혔다. 상태를 하나 더 만들 때 고쳐야 할 곳을 사람 기억에 맡기지 않는다.
// 실행: node tests/task_status.test.js

import assert from 'assert';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TASK_STATUS, TERMINAL_TASK_STATUSES, IDLE_TASK_STATUSES } from '../src/db/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

const ALL = Object.values(TASK_STATUS);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}
const FILES = walk(SRC);

console.log('\n[1] 종료 상태 분류');

assert.ok(TERMINAL_TASK_STATUSES.includes(TASK_STATUS.REVIEWED),
  "reviewed 가 종료 상태에 없다 — 이것이 9/9에 브랜치 경로를 통째로 막았다");
assert.ok(TERMINAL_TASK_STATUSES.includes(TASK_STATUS.NEEDS_REVIEW));
assert.ok(TERMINAL_TASK_STATUSES.includes(TASK_STATUS.DONE));
assert.ok(TERMINAL_TASK_STATUSES.includes(TASK_STATUS.FAILED));
ok('done/failed/needs_review/reviewed 가 모두 종료 상태다');

// rate_limited 는 스스로 재개하므로 슬롯을 계속 점유해야 한다.
assert.ok(!TERMINAL_TASK_STATUSES.includes(TASK_STATUS.RATE_LIMITED),
  'rate_limited 를 종료로 보면 쿨다운 중인 작업 위에 새 작업이 겹친다');
assert.ok(IDLE_TASK_STATUSES.includes(TASK_STATUS.RATE_LIMITED));
ok('rate_limited 는 동시 실행 상한에는 잡히고, 프로젝트 현재작업 조회에서는 빠진다');

// 진행 중 상태는 하나도 종료로 분류되면 안 된다.
for (const s of [TASK_STATUS.PENDING, TASK_STATUS.PLANNING, TASK_STATUS.BUILDING,
  TASK_STATUS.EVALUATING, TASK_STATUS.HANDOFF_PENDING, TASK_STATUS.FALLBACK_RUNNING]) {
  assert.ok(!TERMINAL_TASK_STATUSES.includes(s), `${s} 가 종료로 분류되어 있다`);
}
ok('진행 중 상태는 종료로 분류되지 않는다');

console.log('\n[2] 코드가 쓰는 상태 문자열이 모두 TASK_STATUS 에 있다');
{
  const unknown = new Set();
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    // updateStatus(x, 'literal') / setStatus(x, 'literal')
    for (const m of src.matchAll(/update(?:Task)?Status\([^,)]+,\s*'([a-z_]+)'/g)) {
      if (!ALL.includes(m[1])) unknown.add(`${file.replace(SRC, 'src')}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual([...unknown], [],
    `TASK_STATUS 에 없는 상태를 쓰고 있다:\n${[...unknown].join('\n')}`);
  ok('updateStatus 에 넘기는 리터럴이 모두 정의된 상태다');
}

console.log('\n[3] 종료 상태 목록이 SQL 안에 다시 적혀 있지 않다');
{
  const dbSrc = readFileSync(join(SRC, 'db', 'db.js'), 'utf8');
  // TASK_STATUS 정의 블록은 제외하고 본다.
  const body = dbSrc.slice(dbSrc.indexOf('let _sql = null;'));
  const offenders = [...body.matchAll(/status\s+NOT\s+IN\s*\(\s*'/gi)].length;
  assert.strictEqual(offenders, 0,
    "db.js에 'status NOT IN (...)' 리터럴이 남아 있다 — TERMINAL/IDLE 상수를 쓰라");
  ok('db.js 가 상수를 쓰고 리터럴 목록을 갖고 있지 않다');
}

console.log('\n[4] 대시보드가 모든 상태에 라벨을 갖고 있다');
{
  // PHASE[status] || PHASE.pending 이라서, 빠진 상태는 조용히 '대기'로 보인다.
  // needs_review 가 실제로 그래서 6월 작업이 9월까지 눈에 띄지 않았다.
  const app = readFileSync(join(here, '..', 'dashboard', 'src', 'App.jsx'), 'utf8');
  const start = app.indexOf('const PHASE = {');
  assert.ok(start >= 0, '대시보드에서 PHASE 맵을 찾지 못했다');
  const block = app.slice(start, app.indexOf('\n}', start));
  const missing = ALL.filter(s => !new RegExp(`(^|[\\s{,])${s}\\s*:`, 'm').test(block));
  assert.deepStrictEqual(missing, [],
    `대시보드 PHASE 맵에 라벨이 없는 상태: ${missing.join(', ')} — '대기'로 잘못 표시된다`);
  ok('모든 상태가 대시보드 PHASE 맵에 있다');
}

console.log(`\n✅ task_status: ${passed}개 통과\n`);
