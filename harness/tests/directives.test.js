// tests/directives.test.js
// 프로젝트 지시서가 기기별 절대 경로를 문서에 박아두지 않는지 검사한다.
// 실행: node tests/directives.test.js
//
// 맥 → 씽크패드로 옮긴 뒤 directives/projects/*.md 세 개가 전부 /Users/sun/... 을
// 가리킨 채 남아 있었다. parseDirective가 그 줄을 읽지 않아 동작에는 지장이 없었지만,
// 그래서 더 나쁘다 — 아무도 안 읽는 채로 계속 틀린 답을 들고 있다.
// 경로의 진실은 harness.projects.path 하나여야 한다.

import assert from 'assert';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', '..', 'directives', 'projects');

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

// 기기에 종속된 절대 경로 — 이게 문서에 박히면 기기를 옮기는 순간 거짓이 된다.
const MACHINE_PATH = /(^|[\s`(])(\/Users\/|\/home\/|[A-Z]:\\)/m;

console.log('\n[1] 지시서에 기기별 절대 경로가 박혀 있지 않다');
{
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  assert.ok(files.length > 0, 'directives/projects 에 지시서가 없다');

  const offenders = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      if (line.trimStart().startsWith('>')) continue;   // 인용/설명 줄은 예외
      if (MACHINE_PATH.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim()}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `기기별 절대 경로가 지시서에 있다 (경로의 출처는 harness.projects.path 하나여야 한다):\n  ${offenders.join('\n  ')}`);
  ok(`지시서 ${files.length}개 전부 기기 독립적`);
}

console.log(`\n✅ directives: ${passed}개 통과\n`);
