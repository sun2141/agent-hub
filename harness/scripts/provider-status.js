// scripts/provider-status.js
// harness.providers 상태를 표로 출력 (라이브 서버 무변경, 읽기 전용).
// 실행: node scripts/provider-status.js    또는  npm run providers
import 'dotenv/config';
import { providerQueries } from '../src/db/db.js';

function fmt(v, w) { return String(v ?? '-').padEnd(w); }

async function main() {
  let rows;
  try {
    rows = await providerQueries.listEnabled();
  } catch (e) {
    console.error(`DB 조회 실패: ${e.message}`);
    console.error('NEON_DATABASE_URL 확인, 하네스가 최소 1회 기동해 테이블이 생성됐는지 확인하세요.');
    process.exit(1);
  }
  if (!rows.length) {
    console.log('프로바이더 레코드 없음 (하네스 기동 시 자동 시드됩니다).');
    return;
  }
  const now = new Date().toISOString();
  console.log(`\n프로바이더 상태  (기준: ${now})`);
  console.log('─'.repeat(78));
  console.log(`${fmt('PROVIDER', 14)}${fmt('STATE', 11)}${fmt('WINDOW', 8)}${fmt('NEXT_AVAILABLE_AT', 22)}${fmt('WEIGHT', 7)}${fmt('EN', 3)}`);
  console.log('─'.repeat(78));
  for (const r of rows) {
    const mark = r.state === 'cooling' ? '🧊' : '✅';
    console.log(`${fmt(r.provider, 14)}${fmt(`${mark}${r.state}`, 11)}${fmt(r.window_type, 8)}${fmt(r.next_available_at, 22)}${fmt(r.weight, 7)}${fmt(r.enabled, 3)}`);
  }
  console.log('─'.repeat(78));
  const cooling = rows.filter(r => r.state === 'cooling');
  if (cooling.length) {
    console.log(`쿨다운 중: ${cooling.map(r => `${r.provider}(→${r.next_available_at || '?'})`).join(', ')}`);
  } else {
    console.log('전체 available.');
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
