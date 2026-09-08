// tests/goal_telegram.test.js
// 목표 계층의 텔레그램 표면 — 명령 파싱, 콜백 코덱, 메시지 조립.
// DB·네트워크·텔레그램 없이 순수 함수만 돌린다.
// 실행: node tests/goal_telegram.test.js

import assert from 'assert';
import {
  parseGoalCommand, parseAnswerCommand, mapAnswersToQuestions,
  encodeGoalCallback, decodeGoalCallback,
  buildPlanReadyMessage, buildClarifyMessage, buildGoalListMessage,
  goalUsageMessage, GOAL_CALLBACK_LIMIT,
} from '../src/telegram/goalMessages.js';
import {
  decodeRunCallback, decodeDecisionCallback, decodeReviewCallback,
  encodeRunCallback, encodeDecisionCallback, encodeReviewCallback,
} from '../src/telegram/bot.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

const GOAL = 'goal_1788880000000_a1b2c3';
const PLAN = 'plan_1788880001000_d4e5f6';

console.log('\n[1] /goal 명령 파싱 — 줄바꿈 형식');

const full = parseGoalCommand('palmoni\n로그인 이탈 줄이기\n완료: 소셜 3종 복귀 동작 + e2e 통과\n기한: 2026-09-30');
assert.strictEqual(full.ok, true);
assert.strictEqual(full.projectId, 'palmoni');
assert.strictEqual(full.title, '로그인 이탈 줄이기');
assert.strictEqual(full.outcome, '소셜 3종 복귀 동작 + e2e 통과');
assert.strictEqual(full.dueDate, '2026-09-30');
assert.strictEqual(full.kind, 'build');
assert.strictEqual(full.outcomeInferred, false);
ok('프로젝트/목표/완료/기한을 각각 뽑는다');

// 입력 문턱을 낮추는 게 요점 — 완료 조건이 없어도 통과시키고 계획기가 되묻게 한다.
const bare = parseGoalCommand('palmoni\n로그인 이탈 줄이기');
assert.strictEqual(bare.ok, true);
assert.strictEqual(bare.outcome, '로그인 이탈 줄이기');
assert.strictEqual(bare.outcomeInferred, true);
assert.strictEqual(bare.dueDate, null);
ok('완료 조건 없이도 통과하고, 추론했음을 표시한다');

const research = parseGoalCommand('facepick\n현재 구조 파악\n조사');
assert.strictEqual(research.kind, 'research');
assert.strictEqual(research.title, '현재 구조 파악');
ok('"조사" 한 줄이면 research 목표');

const fullwidth = parseGoalCommand('palmoni\n제목\n완료： 조건입니다');
assert.strictEqual(fullwidth.outcome, '조건입니다');
ok('전각 콜론(：)도 태그로 인식');

const alt = parseGoalCommand('palmoni\n제목\noutcome: X\ndue: 2026-12-01');
assert.strictEqual(alt.outcome, 'X');
assert.strictEqual(alt.dueDate, '2026-12-01');
ok('영문 태그(outcome/due)도 받는다');

console.log('\n[2] /goal 명령 파싱 — 한 줄 형식과 거부');

const pipe = parseGoalCommand('palmoni | 로그인 복귀 | 소셜 3종 동작 | 2026-09-30');
assert.strictEqual(pipe.ok, true);
assert.strictEqual(pipe.title, '로그인 복귀');
assert.strictEqual(pipe.outcome, '소셜 3종 동작');
assert.strictEqual(pipe.dueDate, '2026-09-30');
ok('파이프 한 줄 형식');

assert.strictEqual(parseGoalCommand('').ok, false);
assert.strictEqual(parseGoalCommand('Palmoni\n제목').ok, false);       // 대문자 id 없음
assert.strictEqual(parseGoalCommand('palmoni').ok, false);              // 목표 문장 없음
ok('빈 입력 / 잘못된 프로젝트 id / 목표 없음은 거부');

const badDue = parseGoalCommand('palmoni\n제목\n기한: 9월 30일');
assert.strictEqual(badDue.ok, false);
assert.ok(badDue.error.includes('YYYY-MM-DD'));
assert.ok(badDue.error.includes('9월 30일'));   // 받은 값을 되돌려줘야 뭘 고칠지 안다
ok('기한 형식 오류는 받은 값을 되돌려준다');

assert.ok(goalUsageMessage().includes('/goal palmoni'));
ok('사용법 메시지에 복사 가능한 예시가 있다');

console.log('\n[3] 콜백 코덱');

for (const [action, id] of [['apv', PLAN], ['rej', PLAN], ['rpl', GOAL]]) {
  const data = encodeGoalCallback(action, id);
  assert.ok(data, `${action} 인코딩 실패`);
  assert.ok(Buffer.byteLength(data, 'utf8') <= GOAL_CALLBACK_LIMIT);
  assert.deepStrictEqual(decodeGoalCallback(data), { action, id });
}
ok('apv/rej/rpl 왕복 + 64바이트 규격');

// apv/rej는 plan id, rpl은 goal id — 바꿔 넣으면 거부된다.
assert.strictEqual(encodeGoalCallback('apv', GOAL), null);
assert.strictEqual(encodeGoalCallback('rpl', PLAN), null);
assert.strictEqual(encodeGoalCallback('nope', PLAN), null);
ok('action별 id 종류가 어긋나면 null');

console.log('\n[4] 네 종류 콜백이 서로를 해석하지 못한다');
const goalData = encodeGoalCallback('apv', PLAN);
assert.strictEqual(decodeRunCallback(goalData), null);
assert.strictEqual(decodeDecisionCallback(goalData), null);
assert.strictEqual(decodeReviewCallback(goalData), null);
ok('goal은 blrun/bldec/rvw로 해석되지 않는다');

for (const other of [
  encodeRunCallback('palmoni', 'a1b2c3d4'),
  encodeDecisionCallback('apv', 'backlog_1755000000000_ab12cd34'),
  encodeReviewCallback('run', 'task_1786977920451_adeed5'),
]) {
  assert.ok(other);
  assert.strictEqual(decodeGoalCallback(other), null);
}
ok('blrun/bldec/rvw는 goal로 해석되지 않는다');

console.log('\n[5] 메시지 조립');

const plan = buildPlanReadyMessage({
  goalTitle: '로그인 이탈 줄이기', version: 2, itemCount: 8,
  planId: PLAN, goalId: GOAL, dueDate: '2026-09-30',
});
const row = plan.reply_markup.inline_keyboard[0];
assert.strictEqual(row.length, 3);
assert.deepStrictEqual(decodeGoalCallback(row[0].callback_data), { action: 'apv', id: PLAN });
assert.deepStrictEqual(decodeGoalCallback(row[1].callback_data), { action: 'rpl', id: GOAL });
assert.deepStrictEqual(decodeGoalCallback(row[2].callback_data), { action: 'rej', id: PLAN });
assert.ok(plan.text.includes('v2') && plan.text.includes('8개') && plan.text.includes('2026-09-30'));
ok('계획서 메시지에 버튼 3개와 버전·항목수·기한');

const brokenPlan = buildPlanReadyMessage({ goalTitle: 't', version: 1, itemCount: 1, planId: 'nope', goalId: 'nope' });
assert.strictEqual(brokenPlan.reply_markup, undefined);
assert.ok(brokenPlan.text.includes('대시보드'));
ok('id가 어긋나 버튼을 못 만들면 안내로 대체');

const clarify = buildClarifyMessage({
  goalId: GOAL, goalTitle: '수익성 확대',
  questions: [{ question: '구독인가 광고인가?' }, { question: '대상 국가는?' }],
});
assert.ok(clarify.text.includes('1. 구독인가 광고인가?'));
assert.ok(clarify.text.includes(`/answer ${GOAL}`));
assert.ok(clarify.text.includes('1) 답변') && clarify.text.includes('2) 답변'));
ok('되물음 메시지가 답변 템플릿까지 만들어 준다');

// HTML 이스케이프 — 목표 제목에 <가 들어가도 메시지가 깨지지 않아야 한다.
const esc = buildClarifyMessage({ goalId: GOAL, goalTitle: '<b>주입</b>', questions: [{ question: 'a & b' }] });
assert.ok(esc.text.includes('&lt;b&gt;'));
assert.ok(esc.text.includes('a &amp; b'));
ok('제목·질문의 HTML을 이스케이프한다');

const list = buildGoalListMessage([
  { id: GOAL, title: '로그인 이탈 줄이기', project_id: 'palmoni', status: 'active',
    due_date: '2026-09-30', progress: { finished: 3, total: 8, blocked: 1 } },
]);
assert.ok(list.includes('실행 중') && list.includes('3/8') && list.includes('차단 1'));
ok('목록에 상태 라벨·진행률·차단 수');

assert.ok(buildGoalListMessage([]).includes('/goal palmoni'));
ok('목표가 없으면 사용법을 보여준다');

console.log('\n[6] /answer 파싱');

const ans = parseAnswerCommand(`${GOAL}\n1) 구독\n2. 한국\n3 - 둘 다`);
assert.strictEqual(ans.ok, true);
assert.strictEqual(ans.goalId, GOAL);
assert.strictEqual(ans.byIndex.get(1), '구독');
assert.strictEqual(ans.byIndex.get(2), '한국');
assert.strictEqual(ans.byIndex.get(3), '둘 다');
ok('1) / 2. / 3 - 세 가지 번호 표기를 모두 받는다');

assert.strictEqual(parseAnswerCommand('not-a-goal\n1) x').ok, false);
assert.strictEqual(parseAnswerCommand(`${GOAL}\n답변만 있음`).ok, false);
ok('id 형식 오류 / 번호 없는 답변은 거부');

const mapped = mapAnswersToQuestions(
  new Map([[1, '구독'], [2, '한국']]),
  [{ question: '구독인가 광고인가?' }, { question: '대상 국가는?' }],
);
assert.deepStrictEqual(mapped, { '구독인가 광고인가?': '구독', '대상 국가는?': '한국' });
ok('번호 답변을 질문 텍스트 키로 옮긴다');

// 일부만 답해도 답한 것만 반영된다 — 전부 채우라고 막으면 폰에서 못 쓴다.
const partial = mapAnswersToQuestions(new Map([[2, '한국']]), [{ question: 'Q1' }, { question: 'Q2' }]);
assert.deepStrictEqual(partial, { Q2: '한국' });
ok('일부만 답해도 그것만 반영된다');

console.log(`\n✅ goal_telegram: ${passed}개 통과\n`);
