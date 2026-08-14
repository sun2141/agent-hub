// src/agent/scanScheduler.js
// 매니저 루프 자동 스캔 스케줄러 — 주기적으로 runManagerScan()을 돌려 백로그 제안을 채운다.
//
// 자동화되는 건 "제안"까지다. 승인(/approve)은 여전히 사람이 하고, 병합은 항상 수동이다.
// MANAGER_LOOP=false 이거나 MANAGER_SCAN_INTERVAL_MIN=0 이면 타이머 자체가 생성되지 않는다.
//
// 스팸 억제 규칙 3가지:
//   1) 조용한 시간대(MANAGER_SCAN_QUIET_HOURS)에는 스캔하지 않는다.
//   2) 새 제안이 0건이면 텔레그램 알림을 보내지 않는다(MANAGER_SCAN_NOTIFY_EMPTY=true로 해제).
//   3) 미결(proposed) 제안이 MANAGER_MAX_PENDING 이상 쌓여 있으면 스캔을 건너뛴다
//      — 아무도 승인하지 않는 제안을 계속 만들어봐야 LLM 비용만 든다.

import { backlogQueries } from '../db/db.js';
import { runManagerScan, formatScanDigest } from './manager.js';

// "23-8" → { start: 23, end: 8 } / 빈 값이나 형식 오류면 null(=조용한 시간대 없음)
export function parseQuietHours(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start > 23 || end < 0 || end > 23) return null;
  if (start === end) return null; // 24시간 전체 차단은 실수일 가능성이 높아 무시
  return { start, end };
}

// 자정을 넘기는 구간(23-8)도 처리. end는 배타적(8-9면 8시대만 조용).
export function isQuietHour(hour, quiet) {
  if (!quiet) return false;
  const { start, end } = quiet;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

export function readScanConfig(env = process.env) {
  return {
    enabled: env.MANAGER_LOOP === 'true',
    intervalMin: parseInt(env.MANAGER_SCAN_INTERVAL_MIN || '0', 10),
    quietHours: parseQuietHours(env.MANAGER_SCAN_QUIET_HOURS),
    notifyEmpty: env.MANAGER_SCAN_NOTIFY_EMPTY === 'true',
    maxPending: parseInt(env.MANAGER_MAX_PENDING || '10', 10),
  };
}

// 이번 tick에 스캔할지 판정하는 순수 함수 — 타이머/DB 없이 테스트 가능.
// pendingCount는 호출자가 조회해 넘긴다.
export function shouldScan({ now, config, pendingCount, scanInProgress }) {
  if (!config.enabled) return { scan: false, reason: 'disabled' };
  if (!(config.intervalMin > 0)) return { scan: false, reason: 'interval_off' };
  if (scanInProgress) return { scan: false, reason: 'already_running' };
  if (isQuietHour(now.getHours(), config.quietHours)) return { scan: false, reason: 'quiet_hours' };
  if (config.maxPending > 0 && pendingCount >= config.maxPending) {
    return { scan: false, reason: 'pending_backlog_full' };
  }
  return { scan: true, reason: null };
}

// 타이머 시작. 반환값의 stop()으로 해제 가능(테스트/종료용).
// notify는 텔레그램 알림 함수(createTelegramBot이 반환).
export function startManagerScanScheduler({ notify = () => {}, env = process.env } = {}) {
  const config = readScanConfig(env);

  if (!config.enabled || !(config.intervalMin > 0)) {
    console.log(`[manager-scan] 자동 스캔 비활성 (MANAGER_LOOP=${env.MANAGER_LOOP || 'false'}, MANAGER_SCAN_INTERVAL_MIN=${config.intervalMin})`);
    return { stop: () => {}, config, active: false };
  }

  let scanInProgress = false;
  let lastErrorNotifiedAt = 0;
  const ERROR_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 같은 장애로 매 tick 알림이 오지 않도록

  async function tick() {
    let pendingCount = 0;
    try {
      pendingCount = (await backlogQueries.listPending()).length;
    } catch (err) {
      console.error(`[manager-scan] 미결 제안 조회 실패: ${err.message}`);
      return;
    }

    const decision = shouldScan({ now: new Date(), config, pendingCount, scanInProgress });
    if (!decision.scan) {
      console.log(`[manager-scan] 스킵: ${decision.reason} (미결 ${pendingCount}건)`);
      return;
    }

    scanInProgress = true;
    const startedAt = Date.now();
    try {
      const scanResult = await runManagerScan();
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const newCount = scanResult.proposed.length;
      console.log(`[manager-scan] 완료: 새 제안 ${newCount}건 (${elapsedSec}s)`);

      if (newCount > 0 || config.notifyEmpty) {
        notify(`🕒 <b>자동 스캔</b>\n\n${formatScanDigest(scanResult)}`);
      }
    } catch (err) {
      console.error(`[manager-scan] 실패: ${err.message}`);
      if (Date.now() - lastErrorNotifiedAt > ERROR_NOTIFY_COOLDOWN_MS) {
        lastErrorNotifiedAt = Date.now();
        notify(`⚠️ <b>자동 스캔 실패</b>\n${err.message.slice(0, 200)}\n(같은 오류는 1시간 동안 다시 알리지 않습니다)`);
      }
    } finally {
      scanInProgress = false;
    }
  }

  const intervalMs = config.intervalMin * 60 * 1000;
  const timer = setInterval(() => { tick().catch(err => console.error(`[manager-scan] tick 예외: ${err.message}`)); }, intervalMs);
  timer.unref?.();

  console.log(
    `[manager-scan] 자동 스캔 활성 — ${config.intervalMin}분 주기` +
    (config.quietHours ? `, 조용한 시간대 ${config.quietHours.start}시–${config.quietHours.end}시` : '') +
    `, 미결 상한 ${config.maxPending}건`
  );

  return { stop: () => clearInterval(timer), config, active: true, _tick: tick };
}
