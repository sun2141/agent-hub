// tests/review_buttons.test.js
// 검토 필요(needs_review) 작업의 재투입 버튼 검증.
// DB·네트워크·텔레그램 없이 순수 함수와 파일 입출력만 돌린다.
// 실행: node tests/review_buttons.test.js

import assert from 'assert';
import {
  encodeReviewCallback, decodeReviewCallback, buildNeedsReviewMessage,
  decodeRunCallback, decodeDecisionCallback,
  encodeRunCallback, encodeDecisionCallback, buildReviewQueueItem,
  CALLBACK_DATA_LIMIT,
} from '../src/telegram/bot.js';
import { buildRetryPrompt } from '../src/agent/report_generator.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

const TASK = 'task_1786977920451_adeed5';

console.log('\n[1] 콜백 인코딩/디코딩');

for (const action of ['run', 'done', 'rpt']) {
  const data = encodeReviewCallback(action, TASK);
  assert.ok(data, `${action} 인코딩 실패`);
  assert.ok(Buffer.byteLength(data, 'utf8') <= CALLBACK_DATA_LIMIT, '64바이트 초과');
  assert.deepStrictEqual(decodeReviewCallback(data), { action, taskId: TASK });
}
ok('run/done/rpt 왕복 + 64바이트 규격');

assert.strictEqual(encodeReviewCallback('nope', TASK), null);
assert.strictEqual(encodeReviewCallback('run', 'not-a-task'), null);
assert.strictEqual(encodeReviewCallback('run', ''), null);
assert.strictEqual(encodeReviewCallback('run', null), null);
ok('잘못된 action/taskId는 null');

assert.strictEqual(decodeReviewCallback('rvw|run'), null);
assert.strictEqual(decodeReviewCallback('rvw|run|bad id'), null);
assert.strictEqual(decodeReviewCallback(''), null);
assert.strictEqual(decodeReviewCallback(null), null);
ok('깨진 콜백 데이터는 null');

console.log('\n[2] 콜백 세 종류가 서로를 해석하지 못한다');
// 섞이면 엉뚱한 작업이 돈다 — 양방향으로 고정한다.
const reviewData = encodeReviewCallback('run', TASK);
assert.strictEqual(decodeRunCallback(reviewData), null);
assert.strictEqual(decodeDecisionCallback(reviewData), null);
ok('rvw는 blrun/bldec로 해석되지 않는다');

const runData = encodeRunCallback('palmoni', 'a1b2c3d4');
const decData = encodeDecisionCallback('apv', 'backlog_1755000000000_ab12cd34');
assert.ok(runData && decData);
assert.strictEqual(decodeReviewCallback(runData), null);
assert.strictEqual(decodeReviewCallback(decData), null);
ok('blrun/bldec는 rvw로 해석되지 않는다');

console.log('\n[3] 검토 필요 메시지 조립');

const withFollowUp = buildNeedsReviewMessage({
  taskId: TASK, round: 10,
  evalResult: { score: 75, issues: ['a', 'b'] },
  unresolvedIssues: 2,
  telegramSummary: '⚠️ <b>최대 라운드 도달</b> | 점수: <b>75/100</b> (C)',
  hasFollowUp: true,
});
const buttons = withFollowUp.reply_markup.inline_keyboard[0];
assert.strictEqual(buttons.length, 3);
assert.ok(buttons[0].text.includes('재투입'));
assert.deepStrictEqual(decodeReviewCallback(buttons[0].callback_data), { action: 'run', taskId: TASK });
assert.deepStrictEqual(decodeReviewCallback(buttons[1].callback_data), { action: 'rpt', taskId: TASK });
assert.deepStrictEqual(decodeReviewCallback(buttons[2].callback_data), { action: 'done', taskId: TASK });
ok('후속 작업이 있으면 버튼 3개 (재투입/리포트/검토완료)');

const noFollowUp = buildNeedsReviewMessage({
  taskId: TASK, round: 10, evalResult: { score: 75, issues: [] }, unresolvedIssues: 0,
  telegramSummary: 'x', hasFollowUp: false,
});
const buttons2 = noFollowUp.reply_markup.inline_keyboard[0];
assert.strictEqual(buttons2.length, 2);
assert.ok(!buttons2.some(b => b.text.includes('재투입')));
assert.ok(noFollowUp.text.includes('재투입할 후속 작업이 없습니다'));
ok('후속 작업이 없으면 재투입 버튼을 만들지 않고 이유를 알린다');

// taskId 형식이 어긋나면 버튼을 못 만든다 — 조용히 빠지지 않고 안내로 대체된다.
const broken = buildNeedsReviewMessage({
  taskId: 'weird-id', round: 3, evalResult: { score: 40, issues: ['z'] },
  unresolvedIssues: 1, telegramSummary: null, hasFollowUp: true,
});
assert.strictEqual(broken.reply_markup, undefined);
assert.ok(broken.text.includes('대시보드'));
ok('버튼을 만들 수 없으면 대시보드 안내로 대체');

// 요약이 없어도 핵심 수치는 본문에 남는다
assert.ok(broken.text.includes('40/100'));
assert.ok(broken.text.includes('라운드: 3'));
ok('telegramSummary가 없으면 점수·라운드를 직접 싣는다');

console.log('\n[4] 재투입 프롬프트');

const prompt = buildRetryPrompt({
  title: '로그인 후 원래 화면 복귀',
  originalPrompt: '원래 프롬프트',
  score: 75, rounds: 10,
  issues: ['npm run test가 ENOENT로 실패', 'OAuth 복귀 경로 소실'],
  followUps: [
    { priority: 'HIGH', title: '평가 이슈 해소: npm run test가 ENOENT로 실패', reason: 'r1' },
    { priority: 'HIGH', title: '최대 라운드 초과로 미완성 — rounds 증가 후 재시도', reason: 'r2' },
    { priority: 'MEDIUM', title: '평가자 개선 제안 반영', reason: 'OAuth 콜백을 분리할 것' },
  ],
});
assert.ok(prompt.includes('로그인 후 원래 화면 복귀'));
assert.ok(prompt.includes('npm run test가 ENOENT로 실패'));
assert.ok(prompt.includes('OAuth 복귀 경로 소실'));
ok('원래 목표와 미해결 이슈가 프롬프트에 들어간다');

assert.ok(prompt.includes('새로 설계하지 말고'));
ok('전체 재설계로 흘러가지 않도록 범위를 못박는다');

// "rounds 증가 후 재시도"는 운영자에게 하는 말이지 에이전트에게 시킬 일이 아니다.
assert.ok(!prompt.includes('rounds 증가 후 재시도'));
ok('운영 지시성 후속 작업은 우선 처리 목록에서 제외된다');

assert.ok(prompt.includes('OAuth 콜백을 분리할 것'));
ok('평가자 개선 제안이 실린다');

assert.ok(prompt.includes('lint') && prompt.includes('test'));
ok('완료 기준에 lint/test 통과가 포함된다');

const empty = buildRetryPrompt({ originalPrompt: 'p' });
assert.ok(empty.includes('p'));
assert.ok(!empty.includes('## 미해결 항목'));
ok('이슈가 없으면 빈 섹션을 만들지 않는다');

console.log('\n[5] /review 큐 항목');

const qi = buildReviewQueueItem(
  { id: TASK, project_id: 'palmoni', created_at: '2026-08-17T14:45:20.451Z', prompt: '로그인 후 원래 화면으로 복귀' },
  true,
);
assert.ok(qi.text.includes(TASK));
assert.ok(qi.text.includes('palmoni'));
assert.ok(qi.text.includes('2026-08-17'));
assert.ok(qi.text.includes('로그인 후 원래 화면으로 복귀'));
assert.strictEqual(qi.reply_markup.inline_keyboard[0].length, 3);
ok('큐 항목에 id·프로젝트·날짜·원문과 버튼 3개');

// 사이드카가 없는 과거 작업 — 재투입은 못 해도 리포트/검토완료로 큐에서 내릴 수 있어야 한다.
const legacy = buildReviewQueueItem({ id: TASK, project_id: 'facepick', created_at: '2026-06-28T00:00:00Z' }, false);
const lb = legacy.reply_markup.inline_keyboard[0];
assert.strictEqual(lb.length, 2);
assert.ok(!lb.some(b => b.text.includes('재투입')));
assert.deepStrictEqual(decodeReviewCallback(lb[1].callback_data), { action: 'done', taskId: TASK });
ok('사이드카 없는 과거 작업도 검토 완료로 큐에서 내릴 수 있다');

const brokenQ = buildReviewQueueItem({ id: 'weird', project_id: 'x' }, true);
assert.strictEqual(brokenQ.reply_markup, undefined);
assert.ok(brokenQ.text.includes('대시보드'));
ok('id 형식이 어긋나면 안내로 대체');

console.log(`\n✅ review_buttons: ${passed}개 통과\n`);
