// tests/read_api_version.test.js
// 읽기 API가 "지금 도는 코드"와 "저장소에 있는 코드"를 구분해 보고하는지.
//
// 이게 없으면 밖에서 "배포됐는지"를 확인할 방법이 없다 — pull은 됐는데 재시작이
// 안 된 상태가 겉으로는 정상으로 보인다.
// 실행: node tests/read_api_version.test.js

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import express from 'express';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

const TOKEN = 'testtoken_0123456789abcdefghij';
// readRoutes는 모듈 로드 시점에 READ_API_KEY를 읽는다. 정적 import는 이 대입보다
// 먼저 평가되므로 반드시 동적 import여야 한다.
process.env.READ_API_KEY = TOKEN;
const { registerReadRoutes } = await import('../src/api/readRoutes.js');

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const commit = (root, msg) => {
  fs.appendFileSync(path.join(root, 'a.txt'), `${msg}\n`);
  git(['add', '-A'], root);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg], root);
  return git(['rev-parse', '--short', 'HEAD'], root).stdout.trim();
};

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'readapi-'));
git(['init', '-q', '-b', 'main', '.'], repo);
const first = commit(repo, '첫 커밋');

const app = express();
registerReadRoutes(app, { getStatus: () => ({ running: [], queued: 0, maxConcurrent: 2 }) }, repo);
const server = app.listen(0);
const port = server.address().port;
const status = async () => (await fetch(`http://127.0.0.1:${port}/r/${TOKEN}/status`)).json();

console.log('\n[1] 배포 직후 — 실행 중 커밋과 저장소 커밋이 같다');
{
  const j = await status();
  assert.strictEqual(j.version.running, first);
  assert.strictEqual(j.version.head, first);
  assert.strictEqual(j.version.restartNeeded, false);
  assert.strictEqual(j.version.headSubject, '첫 커밋');
  ok('running == head, restartNeeded=false, 커밋 제목까지 실린다');

  assert.ok(typeof j.startedAt === 'string' && !Number.isNaN(Date.parse(j.startedAt)));
  ok('startedAt이 파싱 가능한 시각이다');
}

console.log('\n[2] pull은 됐는데 재시작을 안 한 상태');
{
  const second = commit(repo, '두 번째 커밋');
  const j = await status();
  assert.strictEqual(j.version.running, first, '실행 중 커밋은 부팅 시점 값으로 고정되어야 한다');
  assert.strictEqual(j.version.head, second, '저장소 커밋은 요청마다 다시 읽어야 한다');
  assert.strictEqual(j.version.restartNeeded, true);
  assert.strictEqual(j.version.headSubject, '두 번째 커밋');
  ok('running은 고정, head는 갱신, restartNeeded=true로 뒤집힌다');
}

console.log('\n[3] 인증은 그대로 걸린다');
{
  const r = await fetch(`http://127.0.0.1:${port}/r/wrongtoken_0123456789abcdefghij/status`);
  assert.strictEqual(r.status, 401);
  ok('잘못된 토큰은 401');
}

server.close();
fs.rmSync(repo, { recursive: true, force: true });
console.log(`\n✅ read_api_version: ${passed}개 통과\n`);
