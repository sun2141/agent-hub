// src/agent/pace.js
// 기한 대비 진척(pace) 계산.
//
// 기한 필드는 계산이 붙지 않으면 장식이다. 여기서 하는 일은 하나:
//   "지금 속도로 기한 안에 끝나는가"를 실측값으로 답한다.
//
// 성공률과 사이클 시간은 추정하지 않는다 — harness.tasks 이력에서 measure한다.
// 표본이 부족할 때만 보수적 기본값으로 떨어지고, 그 사실을 결과에 실어 보낸다
// (추정값을 실측인 척하면 pace 신호 자체를 믿을 수 없게 된다).

import { dbGet } from '../db/goals.js';

export const RUNS_PER_DAY = parseInt(process.env.GOAL_MAX_RUNS_PER_DAY || '6', 10);

// 표본이 이보다 적으면 실측 성공률을 쓰지 않는다.
const MIN_SAMPLE = 5;
const FALLBACK_SUCCESS_RATE = 0.7;

// 쿨다운으로 날리는 시간 비율. limit_events에서 실측한다.
const FALLBACK_COOLDOWN_LOSS = 0.15;

function todayUtc() {
  return new Date(Date.now());
}

export function daysUntil(dueDate, from = todayUtc()) {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T23:59:59Z`);
  if (Number.isNaN(due.getTime())) return null;
  const ms = due.getTime() - from.getTime();
  return Math.ceil(ms / 86400000);
}

// ── 실측 ───────────────────────────────────────────────────────

// 최근 N일 파이프라인 성공률. done / (done + failed).
export async function measureSuccessRate(days = 30) {
  const row = await dbGet(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'done')   AS done,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed
     FROM harness.tasks
     WHERE created_at >= to_char((now() AT TIME ZONE 'UTC') - ($1 || ' days')::interval,
                                 'YYYY-MM-DD HH24:MI:SS')`,
    [String(days)]
  );
  const done = Number(row?.done || 0);
  const failed = Number(row?.failed || 0);
  const sample = done + failed;
  if (sample < MIN_SAMPLE) {
    return { rate: FALLBACK_SUCCESS_RATE, sample, measured: false };
  }
  return { rate: done / sample, sample, measured: true };
}

// 최근 N일 쿨다운으로 잃은 시간 비율.
// limit_events는 프로바이더가 한도에 걸린 구간을 기록한다 — 그 구간의 합을 기간으로 나눈다.
export async function measureCooldownLoss(days = 30) {
  const row = await dbGet(
    `SELECT COUNT(*) AS cnt FROM harness.limit_events
     WHERE created_at >= to_char((now() AT TIME ZONE 'UTC') - ($1 || ' days')::interval,
                                 'YYYY-MM-DD HH24:MI:SS')`,
    [String(days)]
  ).catch(() => null);

  const cnt = Number(row?.cnt || 0);
  if (cnt === 0) return { loss: 0, events: 0, measured: true };

  // 쿨다운 1건이 평균적으로 반나절의 실행 기회를 없앤다고 본다.
  // 정확한 구간 길이는 limit_events 스키마에 따라 다르므로, 여기서는 건수 기반 근사만 한다.
  // 근사임을 measured:false로 명시한다 — 이 값을 정밀하게 만들려면
  // limit_events에 해제 시각 컬럼이 필요하다.
  const loss = Math.min(0.6, (cnt * 0.5) / days);
  return { loss, events: cnt, measured: false };
}

// ── pace ───────────────────────────────────────────────────────

export function paceSignal(pace) {
  if (pace === null) return { level: 'none', label: '기한 없음' };
  if (pace <= 0.7) return { level: 'green',  label: '여유' };
  if (pace <= 1.0) return { level: 'yellow', label: '빠듯' };
  return { level: 'red', label: '기한 위험' };
}

// 남은 용량(실행 횟수)을 실측 기반으로 계산한다.
export async function estimateCapacity(dueDate) {
  const days = daysUntil(dueDate);
  const [success, cooldown] = await Promise.all([
    measureSuccessRate(),
    measureCooldownLoss(),
  ]);

  if (days === null) {
    return {
      days: null, capacity: null,
      successRate: success.rate, successMeasured: success.measured, successSample: success.sample,
      cooldownLoss: cooldown.loss, cooldownMeasured: cooldown.measured,
    };
  }

  const usableDays = Math.max(0, days);
  const capacity = usableDays * RUNS_PER_DAY * success.rate * (1 - cooldown.loss);

  return {
    days: usableDays,
    capacity: Math.floor(capacity),
    runsPerDay: RUNS_PER_DAY,
    successRate: success.rate,
    successMeasured: success.measured,
    successSample: success.sample,
    cooldownLoss: cooldown.loss,
    cooldownMeasured: cooldown.measured,
  };
}

// 목표 하나의 pace. remainingRuns는 goalQueries.progress()의 remaining_runs.
export async function computePace({ dueDate, remainingRuns }) {
  const cap = await estimateCapacity(dueDate);
  if (cap.capacity === null) {
    return { ...cap, pace: null, signal: paceSignal(null), remainingRuns };
  }
  if (remainingRuns === 0) {
    return { ...cap, pace: 0, signal: paceSignal(0), remainingRuns };
  }
  // 용량이 0인데 남은 작업이 있으면 무조건 위험 — 0으로 나누지 않는다.
  const pace = cap.capacity <= 0 ? Infinity : remainingRuns / cap.capacity;
  return { ...cap, pace, signal: paceSignal(pace), remainingRuns };
}

// 사람이 읽는 한 줄. 실측이 아닌 값에는 물음표를 달아 구분한다.
export function describePace(p) {
  if (!p || p.pace === null) return '기한 없음';
  const pct = p.pace === Infinity ? '∞' : `${Math.round(p.pace * 100)}%`;
  const succ = `성공률 ${Math.round(p.successRate * 100)}%${p.successMeasured ? '' : '?'}`;
  const cd = `쿨다운손실 ${Math.round(p.cooldownLoss * 100)}%${p.cooldownMeasured ? '' : '?'}`;
  return `${p.signal.label} · 남은작업 ${p.remainingRuns}회 / 용량 ${p.capacity}회 (${pct}) · D-${p.days} · ${succ}, ${cd}`;
}
