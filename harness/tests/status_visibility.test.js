// tests/status_visibility.test.js
// 쿨다운/재개 가시성 검증 — DB·네트워크 불필요 (순수 빌더 + 시각 헬퍼).
// 실행: node tests/status_visibility.test.js

import assert from 'assert';
import { buildStatusMessage, buildRateLimitedMessage, buildResumingMessage } from '../src/telegram/bot.js';
import { formatLocal, humanizeUntil, humanizeAgo, formatResumeAt, parseUtc } from '../src/util/time.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

console.log('\n[1] 시각 표기 (UTC 저장 → KST 출력)');
{
  assert.strictEqual(formatLocal('2026-08-18 18:30:00'), '08-19 03:30 KST');
  ok('UTC 18:30 → 익일 03:30 KST');

  assert.strictEqual(formatLocal('2026-08-18 15:00:00'), '08-19 00:00 KST');
  ok('자정 경계가 24:00이 아니라 00:00으로 표기');

  const base = Date.UTC(2026, 7, 18, 16, 17, 0);
  assert.strictEqual(humanizeUntil('2026-08-18 18:30:00', base), '2시간 13분 후');
  ok('남은 시간 = 2시간 13분 후');

  assert.strictEqual(humanizeUntil('2026-08-18 18:30:00', Date.UTC(2026, 7, 18, 18, 33, 0)), '3분 지남');
  ok('예약 시각이 지났으면 "지남"으로 구분');

  assert.strictEqual(humanizeAgo('2026-08-18 18:30:00', Date.UTC(2026, 7, 18, 18, 35, 0)), '5분 전');
  ok('마지막 활동 = 5분 전');

  assert.strictEqual(formatResumeAt(null), '미정');
  assert.strictEqual(parseUtc('망가진값'), null);
  ok('null/파싱 실패는 던지지 않고 대체 문자열');
}

console.log('\n[2] /status — 쿨다운 대기 작업 노출');
{
  const now = Date.UTC(2026, 7, 18, 16, 17, 0);
  const waiting = [{ id: 'task_1_abc', scheduled_resume_at: '2026-08-18 18:30:00' }];

  const msg = buildStatusMessage({
    pid: 111, uptimeSec: 3720, multiProvider: true,
    running: [], queued: 0, waiting,
    activity: { task_1_abc: '41분 전' }, now,
  });

  // 회귀의 핵심: 실행 중 작업이 0개여도 "작업 없음"으로 끝나면 안 된다.
  assert.ok(msg.includes('⚪ 실행 중인 작업 없음'), '실행 중 없음 표시는 유지');
  assert.ok(msg.includes('쿨다운 대기 (1개)'), '쿨다운 대기 섹션이 있어야 함');
  ok('실행 중 0개여도 쿨다운 대기 작업이 표시된다');

  assert.ok(msg.includes('task_1_abc'), 'taskId 노출');
  assert.ok(msg.includes('08-19 03:30 KST'), 'KST 재개 시각');
  assert.ok(msg.includes('2시간 13분 후'), '남은 시간');
  ok('재개 예정 시각이 KST + 남은 시간으로 표시된다');

  assert.ok(msg.includes('마지막 활동 41분 전'), '마지막 활동');
  ok('마지막 활동 시각이 함께 나온다 (멈춤 판별용)');

  assert.ok(msg.includes('업타임: 1시간 2분'), '업타임 포맷');
  ok('업타임이 초가 아니라 시/분으로 표시된다');
}

console.log('\n[3] /status — 예약 없음 / 자동 재개 off');
{
  const msg = buildStatusMessage({
    pid: 1, multiProvider: true,
    waiting: [{ id: 'task_2_xyz', scheduled_resume_at: null }],
  });
  assert.ok(msg.includes('자동 재개 예약 없음'));
  assert.ok(msg.includes('/resume task_2_xyz'));
  ok('예약 없는 rate_limited는 수동 재개 명령을 안내한다');

  const off = buildStatusMessage({
    pid: 1, multiProvider: false,
    waiting: [{ id: 'task_3_qqq', scheduled_resume_at: '2026-08-18 18:30:00' }],
  });
  assert.ok(off.includes('자동 재개: ⚠️ 꺼짐'));
  assert.ok(off.includes('MULTI_PROVIDER가 꺼져 있어'));
  ok('MULTI_PROVIDER=off면 예약이 있어도 자동 재개되지 않는다고 경고한다');

  const on = buildStatusMessage({ pid: 1, multiProvider: true, waiting: [] });
  assert.ok(!on.includes('MULTI_PROVIDER가 꺼져 있어'));
  ok('대기 작업이 없으면 불필요한 경고를 붙이지 않는다');
}

console.log('\n[4] /status — 실행 중 작업 + 조회 실패');
{
  const msg = buildStatusMessage({
    pid: 1, multiProvider: true, queued: 2,
    running: [{ taskId: 'task_4_run', phase: 'building', round: 3 }],
    activity: { task_4_run: '방금' },
  });
  assert.ok(msg.includes('🔨 <code>task_4_run</code>'));
  assert.ok(msg.includes('building (Round 3) · 마지막 활동 방금'));
  assert.ok(msg.includes('실행 대기 큐: 2개'));
  ok('실행 중 작업에 단계·라운드·마지막 활동이 붙는다');

  const err = buildStatusMessage({ pid: 1, waitingError: 'connection refused' });
  assert.ok(err.includes('쿨다운 대기 조회 실패'));
  ok('DB 조회가 실패해도 /status가 죽지 않고 사유를 알린다');
}

console.log('\n[5] 쿨다운 진입 알림 — 두 경로가 구분된다');
{
  const now = Date.UTC(2026, 7, 18, 16, 17, 0);
  const scheduled = buildRateLimitedMessage({ taskId: 'task_5_a', resumeAt: '2026-08-18 18:30:00', now });
  assert.ok(scheduled.includes('프로바이더 쿨다운'));
  assert.ok(scheduled.includes('08-19 03:30 KST (2시간 13분 후)'));
  assert.ok(!scheduled.includes('(UTC)'), 'UTC 원문을 그대로 노출하지 않는다');
  ok('예약 재개 경로: KST 재개 시각을 알린다');

  // 회귀의 핵심: 예전에는 resumeAt이 없으면 알림이 아예 나가지 않아 무음 정지였다.
  const manual = buildRateLimitedMessage({ taskId: 'task_5_b', resumeAt: null });
  assert.ok(manual.length > 0, '무음이면 안 된다');
  assert.ok(manual.includes('사용량 한도로 중단'));
  assert.ok(manual.includes('/resume task_5_b'));
  ok('토큰 리미트 경로도 알림이 나가고 수동 재개를 안내한다');
}

console.log('\n[6] 재개 알림 — 자동/수동 문구 구분');
{
  const auto = buildResumingMessage({ taskId: 'task_6_a', auto: true, round: 2 });
  assert.ok(auto.includes('자동 재개됨'));
  assert.ok(auto.includes('Round 2'));
  ok('자동 재개는 "자동 재개됨"으로 표시된다');

  const manual = buildResumingMessage({ taskId: 'task_6_b', auto: false, round: 0 });
  assert.ok(manual.includes('재개됨'));
  assert.ok(!manual.includes('자동 재개됨'));
  ok('수동 재개(/resume)와 문구가 구분된다');

  assert.ok(buildResumingMessage({ taskId: 't', auto: true }).includes('Round -'));
  ok('round가 없어도 undefined가 새지 않는다');
}

console.log(`\n✅ status_visibility: ${passed}개 통과\n`);
