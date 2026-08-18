// src/util/time.js
// DB에는 UTC 문자열('YYYY-MM-DD HH:MM:SS')을 그대로 유지하고,
// 사람이 읽는 출력(텔레그램/로그)만 로컬 타임존으로 변환한다.
// 저장 형식을 바꾸지 않으므로 기존 문자열 비교 쿼리(scheduled_resume_at <= now)에 영향이 없다.

const DISPLAY_TZ    = process.env.DISPLAY_TZ || 'Asia/Seoul';
const DISPLAY_TZ_LBL = process.env.DISPLAY_TZ_LABEL || 'KST';

// 'YYYY-MM-DD HH:MM:SS' (UTC로 해석) → Date. 파싱 불가면 null.
export function parseUtc(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)));
  }
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

// → '08-19 03:30 KST' (withDate=false 면 '03:30 KST')
export function formatLocal(value, { withDate = true } = {}) {
  const d = parseUtc(value);
  if (!d) return '-';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TZ,
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const time = `${parts.hour}:${parts.minute} ${DISPLAY_TZ_LBL}`;
  return withDate ? `${parts.month}-${parts.day} ${time}` : time;
}

// → '2시간 13분 후' / '3분 지남' / '곧'
export function humanizeUntil(value, now = Date.now()) {
  const d = parseUtc(value);
  if (!d) return '';
  const diffMin = Math.round((d.getTime() - now) / 60_000);
  const abs = Math.abs(diffMin);
  const label = abs >= 60 ? `${Math.floor(abs / 60)}시간 ${abs % 60}분` : `${abs}분`;
  if (diffMin > 0) return `${label} 후`;
  if (diffMin < 0) return `${label} 지남`;
  return '곧';
}

// → '08-19 03:30 KST (2시간 13분 후)'
export function formatResumeAt(value, now = Date.now()) {
  if (!parseUtc(value)) return '미정';
  return `${formatLocal(value)} (${humanizeUntil(value, now)})`;
}

// 마지막 활동 시각용: '5분 전' / '2시간 13분 전'
export function humanizeAgo(value, now = Date.now()) {
  const d = parseUtc(value);
  if (!d) return '기록 없음';
  const diffMin = Math.max(0, Math.round((now - d.getTime()) / 60_000));
  if (diffMin < 1) return '방금';
  return diffMin >= 60 ? `${Math.floor(diffMin / 60)}시간 ${diffMin % 60}분 전` : `${diffMin}분 전`;
}
