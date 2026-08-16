// scripts/provider-enable.js
// 프로바이더를 DB에서 켜고 끈다.
//
// 왜 필요한가: CLI가 설치되지 않은 프로바이더가 harness.providers 에 enabled=1 로 남아
// 있으면, 디스패처가 Build 페일오버 대상으로 골랐다가 spawn 실패로 작업이 깨진다.
// (Plan/Review는 핀 고정이라 .env 의 PROVIDER_* 로 피하지만, Build는 페일오버 대상이다.)
//
// 사용법:
//   node scripts/provider-enable.js                 # 현재 상태 보기
//   node scripts/provider-enable.js antigravity off
//   node scripts/provider-enable.js antigravity on
//
// 하네스를 최소 1회 기동해 providers 테이블이 만들어진 뒤에 쓸 수 있다.

import 'dotenv/config';
import { providerQueries } from '../src/db/db.js';

const KNOWN = ['claude', 'codex', 'antigravity'];

async function main() {
  const [provider, state] = process.argv.slice(2);

  if (!provider) {
    // providerQueries에는 전체 목록 조회가 없어 알려진 이름으로 하나씩 읽는다.
    console.log('provider      enabled  weight  status');
    for (const name of KNOWN) {
      const r = await providerQueries.get(name);
      if (!r) { console.log(`${name.padEnd(13)} (DB에 없음 — 하네스 최초 기동 전)`); continue; }
      console.log(
        `${name.padEnd(13)} ${String(r.enabled).padEnd(8)} ` +
        `${String(r.weight ?? '-').padEnd(7)} ${r.status ?? '-'}`
      );
    }
    console.log('\n사용법: node scripts/provider-enable.js <provider> <on|off>');
    return;
  }

  if (!KNOWN.includes(provider)) {
    console.error(`알 수 없는 프로바이더: ${provider} (가능: ${KNOWN.join(', ')})`);
    process.exit(1);
  }
  if (state !== 'on' && state !== 'off') {
    console.error(`상태는 on 또는 off 여야 합니다 (받은 값: ${state ?? '없음'})`);
    process.exit(1);
  }

  await providerQueries.setEnabled(provider, state === 'on');
  console.log(`${provider} → ${state === 'on' ? 'enabled' : 'disabled'}`);
  if (state === 'off') {
    console.log('디스패처가 이 프로바이더를 더 이상 선택하지 않습니다.');
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(`실패: ${err.message}`);
    console.error('하네스를 최소 1회 기동해 providers 테이블이 생성됐는지 확인하세요.');
    process.exit(1);
  });
