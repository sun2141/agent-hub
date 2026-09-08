// tests/repo_cleanup.test.js
// 저장소 자동 정리 — 진짜 git 저장소를 만들어서 검증한다.
// eval 불합격은 커밋을 건너뛰므로 "task 브랜치에 dirty로 방치"가 기본값에 가깝고,
// 그 상태로 다음 작업이 시작하면 브랜치 생성이 막힌다. 여기가 그 경로다.
// 실행: node tests/repo_cleanup.test.js

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { AgentRunner } from '../src/agent/runner.js';
import {
  encodeCleanCallback, decodeCleanCallback,
  buildCleanupItem, buildCleanupResultMessage,
  decodeRunCallback, decodeReviewCallback, decodeDecisionCallback,
} from '../src/telegram/bot.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const runner = Object.create(AgentRunner.prototype);

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

function makeRepo({ onTaskBranch = false, dirty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-'));
  git(['init', '-q', '-b', 'master', '.'], root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'original\n');
  git(['add', '-A'], root);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], root);
  if (onTaskBranch) git(['checkout', '-q', '-b', 'task/task_1_abc'], root);
  if (dirty) {
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(root, 'new.txt'), 'new file\n');
  }
  return root;
}
const branchOf = (root) => git(['rev-parse', '--abbrev-ref', 'HEAD'], root).stdout.trim();
const statusOf = (root) => git(['status', '--porcelain'], root).stdout.trim();
const logOf = (root, ref) => git(['log', '--oneline', '-5', ref], root).stdout.trim();

console.log('\n[1] inspectRepo — 아무것도 바꾸지 않는다');

const clean = makeRepo();
let info = runner.inspectRepo(clean);
assert.strictEqual(info.ok, true);
assert.strictEqual(info.branch, 'master');
assert.strictEqual(info.needsCleanup, false);
assert.strictEqual(info.dirtyCount, 0);
ok('깨끗한 저장소는 needsCleanup=false');

const messy = makeRepo({ onTaskBranch: true, dirty: true });
info = runner.inspectRepo(messy);
assert.strictEqual(info.onTaskBranch, true);
assert.strictEqual(info.dirtyCount, 2);
assert.strictEqual(info.needsCleanup, true);
assert.deepStrictEqual(info.staleBranches, ['task/task_1_abc']);
assert.strictEqual(statusOf(messy).split('\n').length, 2);  // 점검이 상태를 바꾸지 않았다
ok('task 브랜치 + dirty를 정확히 보고하고, 저장소는 그대로');

assert.strictEqual(runner.inspectRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'notgit-'))).ok, false);
ok('git 저장소가 아니면 ok=false');

console.log('\n[2] cleanupRepo');

const r1 = runner.cleanupRepo(messy);
assert.strictEqual(r1.ok, true);
assert.strictEqual(r1.changed, true);
assert.strictEqual(r1.sealed, true);
assert.strictEqual(branchOf(messy), 'master');
assert.strictEqual(statusOf(messy), '');
assert.ok(logOf(messy, 'task/task_1_abc').includes('wip:'));
assert.strictEqual(fs.readFileSync(path.join(messy, 'a.txt'), 'utf8'), 'original\n');
ok('산출물을 task 브랜치에 봉인하고 base로 복귀 — base 내용은 원래대로');

const r2 = runner.cleanupRepo(messy);
assert.strictEqual(r2.changed, false);
ok('이미 깨끗하면 아무것도 하지 않는다');

// 사람이 base에서 작업 중인 변경은 절대 자동 커밋하지 않는다.
const humanWork = makeRepo({ dirty: true });
const r3 = runner.cleanupRepo(humanWork);
assert.strictEqual(r3.ok, false);
assert.ok(r3.reason.includes('사람 작업'));
assert.strictEqual(statusOf(humanWork).split('\n').length, 2);  // 그대로 남아 있다
ok('base 브랜치의 dirty는 손대지 않고 거부한다');

console.log('\n[3] _ensureTaskBranch — 막히지 않고 진행한다');

// 직전 작업이 남긴 dirty 위에서 새 작업을 시작하는 경로.
// 예전에는 여기서 예외가 나면서 프로젝트 전체가 막혔다.
const resume = makeRepo({ onTaskBranch: true, dirty: true });
runner._ensureTaskBranch({ branchName: 'task/task_2_def', cwd: resume });
assert.strictEqual(branchOf(resume), 'task/task_2_def');
assert.strictEqual(statusOf(resume), '');
assert.ok(logOf(resume, 'task/task_1_abc').includes('wip:'));
ok('직전 task 브랜치 산출물을 봉인하고 새 브랜치로 넘어간다');

// 새 브랜치는 base에서 갈라져야 한다 — 직전 작업이 섞이면 PR diff가 오염된다.
assert.ok(!logOf(resume, 'task/task_2_def').includes('wip:'));
ok('새 브랜치에 직전 작업이 섞이지 않는다');

// base의 사람 변경 위에서는 여전히 거부한다.
const humanBase = makeRepo({ dirty: true });
assert.throws(
  () => runner._ensureTaskBranch({ branchName: 'task/task_3_ghi', cwd: humanBase }),
  /커밋되지 않은 변경/,
);
assert.strictEqual(statusOf(humanBase).split('\n').length, 2);
assert.strictEqual(branchOf(humanBase), 'master');
ok('base의 사람 변경 위에서는 거부하고 아무것도 커밋하지 않는다');

// 이미 그 브랜치 위면 아무 일도 하지 않는다(재개 경로).
const already = makeRepo({ onTaskBranch: true, dirty: true });
runner._ensureTaskBranch({ branchName: 'task/task_1_abc', cwd: already });
assert.strictEqual(statusOf(already).split('\n').length, 2);
ok('같은 브랜치 재개 시에는 dirty를 건드리지 않는다');

console.log('\n[4] 버튼과 메시지');

assert.deepStrictEqual(decodeCleanCallback(encodeCleanCallback('palmoni')), { projectId: 'palmoni' });
assert.strictEqual(encodeCleanCallback('Palmoni'), null);
assert.strictEqual(encodeCleanCallback(''), null);
assert.strictEqual(decodeCleanCallback('clean|nope|palmoni'), null);
ok('정리 콜백 왕복 + 잘못된 입력 거부');

const cleanData = encodeCleanCallback('palmoni');
assert.strictEqual(decodeRunCallback(cleanData), null);
assert.strictEqual(decodeReviewCallback(cleanData), null);
assert.strictEqual(decodeDecisionCallback(cleanData), null);
ok('다른 콜백 종류로 해석되지 않는다');

const item = buildCleanupItem('palmoni', {
  branch: 'task/task_1_abc', base: 'master', onTaskBranch: true,
  dirtyCount: 3, dirty: ' M a.js\n M b.js\n?? c.js', staleBranches: ['task/a', 'task/b'],
});
assert.ok(item.reply_markup);
assert.ok(item.text.includes('task/task_1_abc') && item.text.includes('3건'));
assert.ok(item.text.includes('미정리 task 브랜치 2개'));
assert.ok(item.text.includes('아무것도 지우지 않습니다'));
ok('정리 항목에 브랜치·변경 수·미정리 브랜치와 버튼');

const baseItem = buildCleanupItem('palmoni', {
  branch: 'master', base: 'master', onTaskBranch: false,
  dirtyCount: 1, dirty: ' M a.js', staleBranches: [],
});
assert.strictEqual(baseItem.reply_markup, undefined);
assert.ok(baseItem.text.includes('사람 작업'));
ok('base 브랜치 변경에는 버튼을 주지 않는다');

assert.ok(buildCleanupResultMessage('palmoni', { ok: false, reason: '이유' }).includes('정리 실패'));
assert.ok(buildCleanupResultMessage('palmoni', { ok: true, changed: false }).includes('이미 깨끗'));
assert.ok(buildCleanupResultMessage('palmoni', {
  ok: true, changed: true, sealed: true,
  before: { branch: 'task/x', dirtyCount: 2 }, after: { branch: 'master', dirtyCount: 0 },
}).includes('task/x'));
ok('결과 메시지 세 갈래');

console.log(`\n✅ repo_cleanup: ${passed}개 통과\n`);
