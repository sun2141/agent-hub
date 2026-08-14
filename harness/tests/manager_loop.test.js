// tests/manager_loop.test.js
// 매니저 루프 순수 로직 회귀 테스트 (DB/네트워크/LLM 없음)
// 실행: node harness/tests/manager_loop.test.js

import assert from 'assert';
import {
  filterSeenSignals,
  parseSuggestions,
  backlogLineRef,
} from '../src/agent/manager.js';
import {
  parseQuietHours,
  isQuietHour,
  shouldScan,
  readScanConfig,
} from '../src/agent/scanScheduler.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ── 신호 중복 제거 ────────────────────────────────────────────
// 회귀 배경: 초기 구현은 신호 source('needs_review' 등)로 backlog_items를 조회했는데
// 제안 row의 source는 항상 'manager_suggestion'이라 항상 빈 Set이 나왔다 → dedupe 무효.
// 이제 소진 기록 전용 테이블(backlog_seen_signals)을 보고, 그 조회 결과를 이 순수
// 필터에 넘긴다.
section('[dedupe] filterSeenSignals');

test('Dedupe 1: 소진 기록에 있는 신호는 제외된다', () => {
  const raw = [
    { source: 'needs_review', source_ref: 'task_1', text: 'a' },
    { source: 'needs_review', source_ref: 'task_2', text: 'b' },
  ];
  const seen = { needs_review: new Set(['task_1']) };
  const out = filterSeenSignals(raw, seen);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source_ref, 'task_2');
});

test('Dedupe 2: source가 다르면 같은 ref라도 별개 신호로 남는다', () => {
  const raw = [
    { source: 'needs_review', source_ref: '12', text: 'a' },
    { source: 'github_issue', source_ref: '12', text: 'b' },
  ];
  const seen = { needs_review: new Set(['12']) };
  const out = filterSeenSignals(raw, seen);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'github_issue');
});

test('Dedupe 3: 소진 기록이 비어 있으면 전부 통과', () => {
  const raw = [
    { source: 'backlog_file', source_ref: 'aaa', text: 'a' },
    { source: 'backlog_file', source_ref: 'bbb', text: 'b' },
  ];
  assert.strictEqual(filterSeenSignals(raw, {}).length, 2);
  assert.strictEqual(filterSeenSignals(raw, null).length, 2);
});

test('Dedupe 4: 한 번의 스캔 안에서도 동일 신호는 한 번만', () => {
  const raw = [
    { source: 'github_issue', source_ref: '7', text: 'a' },
    { source: 'github_issue', source_ref: '7', text: 'a 중복' },
  ];
  assert.strictEqual(filterSeenSignals(raw, {}).length, 1);
});

test('Dedupe 5: 숫자 ref와 문자열 ref가 동일하게 취급된다 (gh issue number)', () => {
  const raw = [{ source: 'github_issue', source_ref: 12, text: 'a' }];
  const seen = { github_issue: new Set(['12']) };
  assert.strictEqual(filterSeenSignals(raw, seen).length, 0);
});

// ── backlog.md 줄 식별자 ──────────────────────────────────────
// 회귀 배경: source_ref가 줄 번호(`L0:...`)였을 때는 파일 위쪽에 한 줄만 추가돼도
// 아래 항목 전부의 ref가 밀려서 이미 소진된 신호가 새 신호로 다시 잡혔다.
section('[backlog.md] backlogLineRef — 내용 기반 안정 식별자');

test('Ref 1: 줄 위치가 바뀌어도 같은 내용이면 같은 ref', () => {
  const before = ['- 로그인 버그 수정', '- 캐시 추가'];
  const after = ['- 새 항목', '- 로그인 버그 수정', '- 캐시 추가'];
  assert.strictEqual(backlogLineRef(before[0]), backlogLineRef(after[1]));
  assert.strictEqual(backlogLineRef(before[1]), backlogLineRef(after[2]));
});

test('Ref 2: 불릿 기호(-/*)와 공백/대소문자 차이는 무시된다', () => {
  assert.strictEqual(backlogLineRef('- Fix  login'), backlogLineRef('* fix login'));
});

test('Ref 3: 내용이 다르면 ref도 다르다', () => {
  assert.notStrictEqual(backlogLineRef('- a'), backlogLineRef('- b'));
});

// ── LLM 응답 파싱 ─────────────────────────────────────────────
section('[LLM] parseSuggestions');

test('Parse 1: 순수 JSON 배열', () => {
  const out = parseSuggestions('[{"title":"A","description":"d","rationale":"r"}]');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, 'A');
});

test('Parse 2: ```json 코드블록으로 감싼 응답', () => {
  const out = parseSuggestions('```json\n[{"title":"A"}]\n```');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].description, '');
});

test('Parse 3: 앞뒤 설명 텍스트가 섞여도 배열만 추출', () => {
  const out = parseSuggestions('알겠습니다.\n[{"title":"A"}]\n이상입니다.');
  assert.strictEqual(out.length, 1);
});

test('Parse 4: 최대 3개까지만 채택', () => {
  const arr = JSON.stringify([1, 2, 3, 4, 5].map(i => ({ title: `T${i}` })));
  assert.strictEqual(parseSuggestions(arr).length, 3);
});

test('Parse 5: title 없는 항목은 버린다', () => {
  const out = parseSuggestions('[{"description":"d"},{"title":"  "},{"title":"OK"}]');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, 'OK');
});

test('Parse 6: 깨진 JSON / 배열 아님 → 빈 배열 (throw 금지)', () => {
  assert.deepStrictEqual(parseSuggestions('그냥 텍스트'), []);
  assert.deepStrictEqual(parseSuggestions('[{"title":'), []);
  assert.deepStrictEqual(parseSuggestions('{"title":"A"}'), []);
  assert.deepStrictEqual(parseSuggestions(''), []);
});

// ── 조용한 시간대 ─────────────────────────────────────────────
section('[scheduler] parseQuietHours / isQuietHour');

test('Quiet 1: "23-8" 파싱', () => {
  assert.deepStrictEqual(parseQuietHours('23-8'), { start: 23, end: 8 });
  assert.deepStrictEqual(parseQuietHours(' 9 - 18 '), { start: 9, end: 18 });
});

test('Quiet 2: 잘못된 값은 null (= 조용한 시간대 없음)', () => {
  for (const bad of ['', null, undefined, 'abc', '25-3', '1-99', '5-5', '3']) {
    assert.strictEqual(parseQuietHours(bad), null, `입력: ${bad}`);
  }
});

test('Quiet 3: 자정을 넘는 구간(23-8)', () => {
  const q = parseQuietHours('23-8');
  assert.strictEqual(isQuietHour(23, q), true);
  assert.strictEqual(isQuietHour(2, q), true);
  assert.strictEqual(isQuietHour(7, q), true);
  assert.strictEqual(isQuietHour(8, q), false); // end는 배타적
  assert.strictEqual(isQuietHour(14, q), false);
});

test('Quiet 4: 같은 날 안의 구간(9-18)', () => {
  const q = parseQuietHours('9-18');
  assert.strictEqual(isQuietHour(9, q), true);
  assert.strictEqual(isQuietHour(17, q), true);
  assert.strictEqual(isQuietHour(18, q), false);
  assert.strictEqual(isQuietHour(3, q), false);
});

test('Quiet 5: quiet=null이면 항상 스캔 가능 시간', () => {
  for (let h = 0; h < 24; h++) assert.strictEqual(isQuietHour(h, null), false);
});

// ── 스캔 실행 판정 ────────────────────────────────────────────
section('[scheduler] shouldScan');

const baseConfig = { enabled: true, intervalMin: 180, quietHours: null, notifyEmpty: false, maxPending: 10 };
const noon = new Date(2026, 0, 15, 12, 0, 0);

test('Scan 1: 기본 조건 충족 시 스캔', () => {
  const r = shouldScan({ now: noon, config: baseConfig, pendingCount: 0, scanInProgress: false });
  assert.strictEqual(r.scan, true);
});

test('Scan 2: MANAGER_LOOP=false면 스캔 안 함', () => {
  const r = shouldScan({ now: noon, config: { ...baseConfig, enabled: false }, pendingCount: 0, scanInProgress: false });
  assert.deepStrictEqual(r, { scan: false, reason: 'disabled' });
});

test('Scan 3: interval 0이면 스캔 안 함', () => {
  const r = shouldScan({ now: noon, config: { ...baseConfig, intervalMin: 0 }, pendingCount: 0, scanInProgress: false });
  assert.strictEqual(r.reason, 'interval_off');
});

test('Scan 4: 이전 스캔이 아직 돌고 있으면 겹쳐 돌지 않는다', () => {
  const r = shouldScan({ now: noon, config: baseConfig, pendingCount: 0, scanInProgress: true });
  assert.strictEqual(r.reason, 'already_running');
});

test('Scan 5: 조용한 시간대에는 스캔 안 함', () => {
  const config = { ...baseConfig, quietHours: { start: 23, end: 8 } };
  const at3am = new Date(2026, 0, 15, 3, 0, 0);
  assert.strictEqual(shouldScan({ now: at3am, config, pendingCount: 0, scanInProgress: false }).reason, 'quiet_hours');
  assert.strictEqual(shouldScan({ now: noon, config, pendingCount: 0, scanInProgress: false }).scan, true);
});

test('Scan 6: 미결 제안이 상한에 도달하면 스캔 안 함 (LLM 비용 방어)', () => {
  const r = shouldScan({ now: noon, config: baseConfig, pendingCount: 10, scanInProgress: false });
  assert.strictEqual(r.reason, 'pending_backlog_full');
  assert.strictEqual(shouldScan({ now: noon, config: baseConfig, pendingCount: 9, scanInProgress: false }).scan, true);
});

test('Scan 7: maxPending=0이면 미결 상한 비활성', () => {
  const config = { ...baseConfig, maxPending: 0 };
  assert.strictEqual(shouldScan({ now: noon, config, pendingCount: 999, scanInProgress: false }).scan, true);
});

// ── 설정 읽기 (기본값이 안전한 쪽인지) ────────────────────────
section('[scheduler] readScanConfig 기본값');

test('Config 1: 빈 환경 → 자동 스캔 off', () => {
  const c = readScanConfig({});
  assert.strictEqual(c.enabled, false);
  assert.strictEqual(c.intervalMin, 0);
  assert.strictEqual(c.notifyEmpty, false);
});

test('Config 2: MANAGER_LOOP=true만으론 타이머가 돌지 않는다 (interval 필요)', () => {
  const c = readScanConfig({ MANAGER_LOOP: 'true' });
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.intervalMin, 0);
  assert.strictEqual(shouldScan({ now: noon, config: c, pendingCount: 0, scanInProgress: false }).scan, false);
});

test('Config 3: 전체 설정 반영', () => {
  const c = readScanConfig({
    MANAGER_LOOP: 'true',
    MANAGER_SCAN_INTERVAL_MIN: '180',
    MANAGER_SCAN_QUIET_HOURS: '23-8',
    MANAGER_SCAN_NOTIFY_EMPTY: 'true',
    MANAGER_MAX_PENDING: '5',
  });
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.intervalMin, 180);
  assert.deepStrictEqual(c.quietHours, { start: 23, end: 8 });
  assert.strictEqual(c.notifyEmpty, true);
  assert.strictEqual(c.maxPending, 5);
});

// ── 결과 ──────────────────────────────────────────────────────
console.log(`\n결과: ${passed} 통과, ${failed} 실패\n`);
process.exit(failed > 0 ? 1 : 0);
