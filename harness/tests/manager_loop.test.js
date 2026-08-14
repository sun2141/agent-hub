// tests/manager_loop.test.js
// 매니저 루프 순수 로직 회귀 테스트 (DB/네트워크/LLM 없음)
// 실행: node harness/tests/manager_loop.test.js

import assert from 'assert';
import {
  filterSeenSignals,
  parseSuggestions,
  backlogLineRef,
  parseDirective,
  hasIntentSignal,
  buildPrompt,
  INTENT_SOURCES,
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

// ── 디렉티브 파일 파싱 ────────────────────────────────────────
// 회귀 배경: 초기 구현은 directives/projects/{id}/backlog.md 라는 존재하지 않는 디렉토리
// 구조를 찾았고, projects.js에는 github 필드가 아예 없었다. 그래서 "의도 신호"(백로그/이슈)가
// 한 번도 잡히지 않고 하네스 자기 실패 이력만 신호로 남았다.
section('[directive] parseDirective — 실제 규약(directives/projects/{id}.md)');

const SAMPLE_DIRECTIVE = `# Palmoni Project Directive

## Project Info

- **ID**: palmoni
- **GitHub**: sun2141/palmoni
- **Deploy**: palmoni.vercel.app (Vercel)

## Backlog

- [ ] 기도 목록 무한 스크롤
- [x] 로그인 오류 수정
- 알림 설정 화면 추가

## Monitoring Rules

- 이건 백로그가 아니다
`;

test('Directive 1: GitHub 슬러그 추출', () => {
  assert.strictEqual(parseDirective(SAMPLE_DIRECTIVE).github, 'sun2141/palmoni');
});

test('Directive 2: GitHub이 "-" 플레이스홀더면 null', () => {
  assert.strictEqual(parseDirective('- **GitHub**: -\n').github, null);
});

test('Directive 3: 전체 URL / .git 접미사도 슬러그로 정규화', () => {
  assert.strictEqual(parseDirective('**GitHub**: https://github.com/sun2141/facepick.git').github, 'sun2141/facepick');
});

test('Directive 4: Backlog 섹션 항목만 수집 (다음 ## 헤딩에서 멈춤)', () => {
  const { backlog } = parseDirective(SAMPLE_DIRECTIVE);
  assert.deepStrictEqual(backlog, ['기도 목록 무한 스크롤', '알림 설정 화면 추가']);
});

test('Directive 5: 완료된 체크박스(- [x])는 신호에서 제외', () => {
  assert.ok(!parseDirective(SAMPLE_DIRECTIVE).backlog.includes('로그인 오류 수정'));
});

test('Directive 6: HTML 주석 안의 예시 불릿은 항목으로 잡지 않는다', () => {
  // 회귀: 템플릿 안내를 <!-- --> 주석으로 넣었더니 "- [ ] 미완료 (신호로 잡힘)"이
  // 진짜 백로그 항목으로 파싱됐다. 실제 디렉티브 파일로 확인된 버그.
  const md = `## Backlog

<!-- 사용법: - [ ] 이렇게 적으세요 / - [x] 완료 -->

- [ ] 진짜 항목
`;
  assert.deepStrictEqual(parseDirective(md).backlog, ['진짜 항목']);
});

test('Directive 7: 파일 맨 끝의 Backlog 섹션도 잡힌다', () => {
  // 회귀: 섹션 끝을 (?=^##\s|\Z)로 잡았는데 JS에 \Z가 없어(리터럴 'Z') 뒤에 다른
  // 헤딩이 없는 파일에서는 섹션 전체가 매칭되지 않았다.
  const md = '# 제목\n\n## Backlog\n\n- [ ] 마지막 항목\n';
  assert.deepStrictEqual(parseDirective(md).backlog, ['마지막 항목']);
});

test('Directive 8: Backlog 섹션이 없으면 빈 배열 (throw 금지)', () => {
  assert.deepStrictEqual(parseDirective('# 제목\n\n## Info\n- a\n').backlog, []);
  assert.deepStrictEqual(parseDirective('').backlog, []);
  assert.deepStrictEqual(parseDirective(null), { github: null, backlog: [] });
});

// ── 의도 신호 게이트 ──────────────────────────────────────────
// 사용자 요구: "간단하거나 의미없는 작업을 반복하는 게 아니라 실제 개발을 자동화".
// 이력 신호(하네스 자기 실패)만으로 제안하면 자기참조 잡일 루프가 된다.
section('[intent] hasIntentSignal — 자기참조 루프 방지 게이트');

test('Intent 1: 의도 신호는 backlog_file / github_issue 뿐', () => {
  assert.deepStrictEqual([...INTENT_SOURCES].sort(), ['backlog_file', 'github_issue']);
});

test('Intent 2: 이력 신호만 있으면 false (제안하지 않음)', () => {
  const signals = [
    { source: 'needs_review', source_ref: 't1', text: 'a' },
    { source: 'failed_task', source_ref: 't2', text: 'b' },
  ];
  assert.strictEqual(hasIntentSignal(signals), false);
});

test('Intent 3: 백로그 항목이 하나라도 있으면 true', () => {
  const signals = [
    { source: 'failed_task', source_ref: 't2', text: 'b' },
    { source: 'backlog_file', source_ref: 'h1', text: '무한 스크롤' },
  ];
  assert.strictEqual(hasIntentSignal(signals), true);
});

test('Intent 4: GitHub 이슈도 의도 신호', () => {
  assert.strictEqual(hasIntentSignal([{ source: 'github_issue', source_ref: '3', text: 'x' }]), true);
});

test('Intent 5: 신호가 없으면 false', () => {
  assert.strictEqual(hasIntentSignal([]), false);
});

// ── 프롬프트 구성 ─────────────────────────────────────────────
section('[prompt] buildPrompt — 의도/이력 신호 분리');

const proj = { name: 'Palmoni', description: '기도앱', stack: 'react-vite' };

test('Prompt 1: 의도 신호와 이력 신호가 별도 블록으로 분리된다', () => {
  const p = buildPrompt(proj, [
    { source: 'backlog_file', source_ref: 'h', text: '무한 스크롤' },
    { source: 'failed_task', source_ref: 't', text: '빌드 실패' },
  ]);
  assert.ok(p.includes('[의도 신호'), '의도 신호 블록 없음');
  assert.ok(p.includes('[이력 신호'), '이력 신호 블록 없음');
  assert.ok(p.indexOf('[의도 신호') < p.indexOf('[이력 신호'), '의도 신호가 먼저 와야 함');
});

test('Prompt 2: 이력 신호가 없으면 이력 블록 자체를 넣지 않는다', () => {
  const p = buildPrompt(proj, [{ source: 'backlog_file', source_ref: 'h', text: '무한 스크롤' }]);
  assert.ok(!p.includes('[이력 신호'));
});

test('Prompt 3: 근거 없으면 빈 배열을 반환하라는 지시가 포함된다', () => {
  const p = buildPrompt(proj, [{ source: 'failed_task', source_ref: 't', text: 'x' }]);
  assert.ok(p.includes('빈 배열'), '억지 제안 방지 지시 없음');
  assert.ok(p.includes('리팩터링'), '요구사항 없는 일반 개선 금지 목록 없음');
});

// ── 결과 ──────────────────────────────────────────────────────
console.log(`\n결과: ${passed} 통과, ${failed} 실패\n`);
process.exit(failed > 0 ? 1 : 0);
