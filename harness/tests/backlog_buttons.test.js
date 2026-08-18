// tests/backlog_buttons.test.js
// 원문 백로그(directives) 읽기·쓰기 + 텔레그램 인라인 버튼 조립 검증.
// DB·네트워크·텔레그램 없이 순수 함수만 돌린다.
// 실행: node tests/backlog_buttons.test.js

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listBacklog, addBacklogItem, findBacklogItem, parseBacklogItems, MAX_ITEM_LENGTH } from '../src/agent/backlogFile.js';
import {
  encodeRunCallback, decodeRunCallback, buildBacklogSections, buildBacklogEmptyMessage,
  escapeHtml, CALLBACK_DATA_LIMIT, BACKLOG_ITEMS_PER_PROJECT,
} from '../src/telegram/bot.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

function makeRoot(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bltest-'));
  fs.mkdirSync(path.join(root, 'directives/projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'directives/projects/palmoni.md'), body);
  return root;
}

const TEMPLATE = `# Palmoni

**GitHub**: sun2141/palmoni

## Backlog

<!-- 안내 주석입니다.
     - [ ] 이렇게 적으세요 -->

## Related Directives
- 다른 섹션 불릿
`;

console.log('\n[1] 원문 백로그 파싱');
{
  const root = makeRoot(TEMPLATE);
  assert.deepStrictEqual(listBacklog('palmoni', root).items, []);
  ok('안내 주석 안의 예시 불릿은 항목으로 잡히지 않는다');

  assert.deepStrictEqual(parseBacklogItems('## Backlog\n- [x] 끝난 일\n- [ ] 할 일\n').map(i => i.text), ['할 일']);
  ok('- [x] 완료 항목은 제외된다');

  const other = parseBacklogItems(TEMPLATE);
  assert.ok(!other.some(i => i.text === '다른 섹션 불릿'));
  ok('다른 ## 섹션의 불릿은 섞이지 않는다');

  assert.strictEqual(listBacklog('facepick', root).exists, false);
  ok('디렉티브 파일이 없으면 exists:false (예외 아님)');

  assert.throws(() => addBacklogItem('../../etc/passwd', '침입', root), /잘못된 프로젝트 id/);
  ok('프로젝트 id로 경로를 벗어나 쓸 수 없다');

  // /backlog는 등록된 프로젝트를 전부 훑으므로, id 하나가 이상해도 목록이 죽으면 안 된다
  const weird = listBacklog('한글아이디', root);
  assert.strictEqual(weird.invalidId, true);
  assert.deepStrictEqual(weird.items, []);
  ok('규격 밖 id는 던지지 않고 빈 목록으로 넘어간다');
}

console.log('\n[2] 백로그 추가 (/add)');
{
  const root = makeRoot(TEMPLATE);
  const a = addBacklogItem('palmoni', '로그인 실패 3회 시 60초 잠금', root);
  const b = addBacklogItem('palmoni', '목록 첫 렌더 50개만 조회', root);
  assert.strictEqual(listBacklog('palmoni', root).items.length, 2);
  ok('항목이 ## Backlog 섹션에 추가된다');

  const body = fs.readFileSync(path.join(root, 'directives/projects/palmoni.md'), 'utf8');
  assert.ok(body.includes('## Related Directives'), '다음 섹션이 보존되어야 함');
  assert.ok(body.indexOf('- [ ] 로그인') < body.indexOf('## Related Directives'));
  ok('다음 섹션을 침범하지 않고 Backlog 안에 들어간다');

  const dup = addBacklogItem('palmoni', '  로그인   실패 3회 시 60초 잠금 ', root);
  assert.strictEqual(dup.duplicate, true);
  assert.strictEqual(listBacklog('palmoni', root).items.length, 2);
  ok('공백만 다른 같은 문장은 중복으로 걸러진다');

  // 핵심: 위에 항목이 추가돼도 아래 항목의 ref가 밀리면 안 된다 (줄 번호가 아니라 내용 해시)
  assert.strictEqual(findBacklogItem('palmoni', b.ref, root).text, b.text);
  ok('항목이 늘어도 기존 ref가 그대로 가리킨다');

  assert.throws(() => addBacklogItem('palmoni', '   ', root), /비어/);
  assert.throws(() => addBacklogItem('palmoni', 'x'.repeat(MAX_ITEM_LENGTH + 1), root), /너무 깁니다/);
  ok('빈 내용과 과도한 길이는 거부된다');

  const root2 = makeRoot('# Palmoni\n\n설명만 있고 Backlog 섹션이 없음\n');
  const c = addBacklogItem('palmoni', '첫 항목', root2);
  assert.strictEqual(c.createdSection, true);
  assert.deepStrictEqual(listBacklog('palmoni', root2).items.map(i => i.text), ['첫 항목']);
  ok('Backlog 섹션이 없으면 만들어서 넣는다');
}

console.log('\n[3] 콜백 데이터 (텔레그램 64바이트 제한)');
{
  const data = encodeRunCallback('pray-crawling', '0123456789abcdef');
  assert.ok(Buffer.byteLength(data, 'utf8') <= CALLBACK_DATA_LIMIT);
  assert.deepStrictEqual(decodeRunCallback(data), { projectId: 'pray-crawling', ref: '0123456789abcdef' });
  ok('encode → decode 왕복이 일치하고 64바이트를 넘지 않는다');

  assert.strictEqual(encodeRunCallback('x'.repeat(60), '0123456789abcdef'), null);
  ok('64바이트를 넘으면 null (잘린 데이터로 엉뚱한 작업을 돌리지 않는다)');

  for (const bad of ['', '쓰레기', 'blrun|palmoni', 'other|palmoni|0123456789abcdef',
                     'blrun|../etc|0123456789abcdef', 'blrun|palmoni|NOTHEX', null, undefined]) {
    assert.strictEqual(decodeRunCallback(bad), null, `거부되어야 함: ${bad}`);
  }
  ok('형식이 어긋나거나 경로가 섞인 데이터는 전부 거부된다');
}

console.log('\n[4] /backlog 메시지 조립');
{
  const { sections, total } = buildBacklogSections([
    { id: 'palmoni', name: 'Palmoni', exists: true, items: [
      { text: '로그인 실패 3회 시 60초 잠금. 남은 초를 응답에 포함', ref: 'aaaa000000000001' },
      { text: '짧은 항목', ref: 'aaaa000000000002' },
    ] },
    { id: 'facepick', name: 'FacePick', exists: true, items: [] },
  ]);

  assert.strictEqual(total, 2);
  assert.strictEqual(sections.length, 1);
  ok('항목이 없는 프로젝트는 메시지를 만들지 않는다');

  const rows = sections[0].reply_markup.inline_keyboard;
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(decodeRunCallback(rows[0][0].callback_data).ref, 'aaaa000000000001');
  ok('항목마다 버튼이 하나씩, 올바른 ref를 들고 붙는다');

  assert.ok(rows[0][0].text.startsWith('▶ 1.'));
  assert.ok(rows[0][0].text.includes('…'), '긴 항목은 라벨이 잘려야 함');
  assert.ok(!rows[1][0].text.includes('…'), '짧은 항목은 안 잘려야 함');
  ok('버튼 라벨에 번호가 붙고 긴 문장은 잘린다');

  assert.ok(sections[0].text.includes('1. 로그인 실패'));
  assert.ok(sections[0].text.includes('브랜치+PR'));
  ok('본문에 전체 문장과 실행 방식이 함께 표시된다');

  const many = Array.from({ length: BACKLOG_ITEMS_PER_PROJECT + 3 }, (_, i) => ({
    text: `항목 ${i}`, ref: String(i).padStart(16, '0'),
  }));
  const big = buildBacklogSections([{ id: 'palmoni', name: 'Palmoni', items: many }]);
  assert.strictEqual(big.sections[0].reply_markup.inline_keyboard.length, BACKLOG_ITEMS_PER_PROJECT);
  assert.ok(big.sections[0].text.includes('외 3건'), '가려진 항목 수를 밝혀야 함');
  ok(`항목이 많으면 ${BACKLOG_ITEMS_PER_PROJECT}개까지만 버튼을 만들고 나머지 건수를 알린다`);

  const evil = buildBacklogSections([{ id: 'palmoni', name: 'P', items: [{ text: '<b>주입</b> & 종료', ref: 'bbbb000000000001' }] }]);
  assert.ok(evil.sections[0].text.includes('&lt;b&gt;주입&lt;/b&gt; &amp; 종료'));
  ok('항목 문장의 HTML은 이스케이프된다 (메시지가 깨지지 않는다)');
}

console.log('\n[5] 백로그가 비었을 때 안내');
{
  const msg = buildBacklogEmptyMessage([
    { id: 'palmoni', exists: true, items: [] },
    { id: 'shootinglike', exists: false, items: [] },
  ]);
  assert.ok(msg.includes('/add'), '추가 방법을 알려줘야 함');
  assert.ok(msg.includes('shootinglike'), '파일이 없는 프로젝트를 짚어줘야 함');
  assert.ok(!msg.includes('>palmoni<'), '파일이 있는 프로젝트는 경고 목록에 없어야 함');
  ok('비었을 때 /add 사용법과 파일 없는 프로젝트를 함께 알린다');

  assert.strictEqual(escapeHtml('<a href="x">&'), '&lt;a href="x"&gt;&amp;');
  ok('escapeHtml이 &, <, > 를 처리한다');
}

console.log(`\n✅ backlog_buttons: ${passed}개 통과\n`);
