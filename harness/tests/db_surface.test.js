// tests/db_surface.test.js
// 코드가 호출하는 DB 쿼리가 실제로 그 객체에 존재하는지 검사한다.
//
// 왜 필요한가: db.js는 projectQueries / taskQueries / backlogQueries 가 한 파일에
// 나란히 있고 get(id), list() 처럼 같은 이름의 메서드를 여럿 가진다. 그래서 새 쿼리를
// 엉뚱한 객체에 넣기 쉽고, 그러면 실행 시점(버튼을 누른 순간, 스크립트를 돌린 순간)에야
// "X is not a function"으로 터진다. 실제로 backlogQueries.listRecent 를 projectQueries에
// 잘못 넣어 npm run backlog:inspect 가 죽은 적이 있다.
//
// 실행: node tests/db_surface.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../src/db/db.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QUERY_OBJECTS = ['projectQueries', 'taskQueries', 'logQueries', 'limitEventQueries', 'providerQueries', 'backlogQueries'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))];
const pattern = new RegExp(`\\b(${QUERY_OBJECTS.join('|')})\\.([A-Za-z_$][\\w$]*)`, 'g');

console.log('\n[1] 호출되는 쿼리가 전부 존재하는가');
{
  const calls = new Map();   // "obj.method" -> [파일…]
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(pattern)) {
      const key = `${m[1]}.${m[2]}`;
      if (!calls.has(key)) calls.set(key, new Set());
      calls.get(key).add(path.relative(ROOT, file));
    }
  }

  assert.ok(calls.size > 20, `호출을 거의 못 찾았다 (${calls.size}건) — 스캔이 깨졌는지 확인`);

  const missing = [];
  for (const [key, where] of calls) {
    const [obj, method] = key.split('.');
    if (typeof db[obj]?.[method] !== 'function') {
      missing.push(`${key}  ← ${[...where].join(', ')}`);
    }
  }
  assert.deepStrictEqual(missing, [], `존재하지 않는 쿼리를 호출함:\n  ${missing.join('\n  ')}`);
  ok(`src/·scripts/에서 호출하는 쿼리 ${calls.size}종이 모두 실제로 존재한다`);
}

console.log('\n[2] 쿼리가 올바른 객체에 붙어 있는가');
{
  // 이름만 보고 "있으니 됐다"로 넘어가면, 같은 이름이 다른 객체에 있을 때 못 잡는다.
  const EXPECTED = {
    backlogQueries: ['propose', 'listPending', 'listRecent', 'allSeenSignals', 'get',
                     'markApproved', 'markRejected', 'countApprovedToday',
                     'countActiveManagerTasks', 'seenRefs', 'markSignalsSeen'],
    taskQueries:    ['create', 'get', 'list', 'updateStatus', 'getActiveForProject',
                     'getRateLimitedTasks', 'getPendingRateLimitedTasks',
                     'updateScheduledResumeAt', 'countBranchModeToday',
                     'pauseInterruptedActiveTasks'],
    projectQueries: ['seed', 'list', 'get'],
    logQueries:     ['append', 'forTask'],
  };

  for (const [obj, methods] of Object.entries(EXPECTED)) {
    for (const m of methods) {
      assert.strictEqual(typeof db[obj]?.[m], 'function', `${obj}.${m} 가 없다`);
    }
  }
  ok('핵심 쿼리가 각자 있어야 할 객체에 붙어 있다');

  // 실제로 났던 사고: backlog 전용 쿼리가 projectQueries로 새어 들어갔다.
  for (const leaked of ['listRecent', 'allSeenSignals', 'listPending', 'markApproved']) {
    assert.strictEqual(db.projectQueries[leaked], undefined, `projectQueries에 ${leaked} 가 새어 들어옴`);
  }
  ok('백로그 전용 쿼리가 projectQueries로 새어 들어가지 않았다');
}

console.log(`\n✅ db_surface: ${passed}개 통과\n`);
