// src/agent/dispatcher.js
// 멀티 프로바이더 디스패치 정책 — 하이브리드 "로테이션 후 대기" + 단계 핀 고정.
//
// 확정 설계:
//  - Plan / Review(eval) 단계 → 선호 프로바이더에 핀 고정 (품질 민감).
//  - Build / Test-fix 단계 → 페일오버 허용 (로테이션).
//  - 단계별 선호 프로바이더가 cooling이면:
//      · 페일오버 허용 단계: 다음 가용 프로바이더로 넘김.
//      · 핀 고정 단계: 해당 프로바이더 리셋까지 대기. 단 weekly 캡(며칠)일 땐 강등 허용.
//  - 셋 다 cooling: 가장 빠른 리셋 시각까지 대기(wait 모드).
//  - 프로바이더당 단일 실행(single-flight): busy 목록으로 강제.

import { providerQueries } from '../db/db.js';
import { getAdapter } from './providers/index.js';
import { minutesFromNow } from './providers/base.js';

// 단계별 선호 프로바이더
const PHASE_PREFERENCE = {
  plan:    process.env.PROVIDER_PLAN    || 'antigravity', // 긴 컨텍스트/여유
  build:   process.env.PROVIDER_BUILD   || 'claude',      // 메인 구현
  testfix: process.env.PROVIDER_BUILD   || 'claude',      // Build 담당과 동일
  eval:    process.env.PROVIDER_REVIEW  || 'codex',       // 교차 모델 리뷰
  review:  process.env.PROVIDER_REVIEW  || 'codex',
};

// 페일오버 허용 단계 (그 외는 핀 고정)
const FAILOVER_PHASES = new Set(['build', 'testfix']);

// weekly 캡(며칠)이면 핀 고정 단계라도 강등 허용 (다일 정지 회피)
const RELAX_ON_WEEKLY = process.env.PROVIDER_RELAX_WEEKLY !== 'false';

export function preferredFor(phase) {
  return PHASE_PREFERENCE[phase] || 'claude';
}

export function isFailoverPhase(phase) {
  return FAILOVER_PHASES.has(phase);
}

// UTC 'YYYY-MM-DD HH:MM:SS' → 지금부터 남은 ms (최소 0)
export function waitMsUntil(utcString) {
  if (!utcString) return 0;
  const iso = utcString.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t - Date.now());
}

// 만료된 cooling 프로바이더를 available로 회수하고 회수된 이름 배열 반환.
// store 주입으로 DB 없이 테스트 가능(기본: providerQueries).
export async function reclaimExpired(store = providerQueries) {
  const rows = await store.reclaimExpired();
  return rows.map(r => r.provider);
}

// 리미트 감지 시 cooling 등록 (어댑터 결과의 resetAt/windowType 그대로).
export async function markLimit(provider, { resetAt, windowType, reason }, store = providerQueries) {
  await store.markCooling(provider, { nextAvailableAt: resetAt, windowType, reason });
}

// 핵심: 단계와 현재 in-flight(busy) 목록을 받아 실행/대기/재큐 결정.
// 반환:
//   { action:'run',  provider, adapter }
//   { action:'wait', provider, resumeAt, waitMs }   // 전부 cooling
//   { action:'busy', provider? }                    // 곧 빌 프로바이더 있음 → 재큐
export async function selectProvider({ phase, busy = [], relaxWeekly = RELAX_ON_WEEKLY, store = providerQueries }) {
  await reclaimExpired(store);

  const busySet = new Set(busy);
  const all = await store.listEnabled(); // weight 내림차순
  const byName = Object.fromEntries(all.map(p => [p.provider, p]));
  const isFree = (p) => p && p.enabled === 1 && p.state === 'available' && !busySet.has(p.provider);

  const preferredName = preferredFor(phase);
  const pref = byName[preferredName];

  // 1) 선호 프로바이더가 즉시 가용
  if (isFree(pref)) return { action: 'run', provider: preferredName, adapter: getAdapter(preferredName) };

  const prefCoolingWeekly = pref && pref.state === 'cooling' && pref.window_type === 'weekly';
  const canFailover = isFailoverPhase(phase) || (relaxWeekly && prefCoolingWeekly);

  if (canFailover) {
    // 가중치 순으로 가용 프로바이더 선택 (선호 포함 전체 후보)
    const candidate = all.find(isFree);
    if (candidate) return { action: 'run', provider: candidate.provider, adapter: getAdapter(candidate.provider) };
  } else {
    // 핀 고정: 선호가 잠깐 busy면 재큐, cooling이면 리셋까지 대기
    if (pref && pref.state === 'available' && busySet.has(preferredName)) {
      return { action: 'busy', provider: preferredName };
    }
    if (pref && pref.state === 'cooling') {
      return { action: 'wait', provider: preferredName, resumeAt: pref.next_available_at, waitMs: waitMsUntil(pref.next_available_at) };
    }
  }

  // 2) 가용은 있으나 전부 busy → 재큐
  if (all.some(p => p.state === 'available' && busySet.has(p.provider))) {
    return { action: 'busy' };
  }

  // 3) 전부 cooling → 가장 빠른 리셋까지 대기
  const earliest = await store.earliestResetAt();
  if (earliest) {
    return { action: 'wait', provider: earliest.provider, resumeAt: earliest.next_available_at, waitMs: waitMsUntil(earliest.next_available_at) };
  }

  // 4) 알 수 없음(모두 비활성 등) — 보수적 30분 대기
  const fallback = minutesFromNow(30);
  return { action: 'wait', provider: null, resumeAt: fallback, waitMs: waitMsUntil(fallback) };
}
