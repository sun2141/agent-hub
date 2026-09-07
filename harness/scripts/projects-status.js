// scripts/projects-status.js
// harness.projects의 등록 경로를 표로 출력 (읽기 전용, 라이브 서버 무변경).
// 실행: node scripts/projects-status.js   또는  npm run projects
//
// 왜 있나: 프로젝트 경로의 진실은 DB에 있는데, 사람이 볼 곳이 없어서
// directives/*.md 의 "Path" 줄이 사실상의 문서가 되어 있었다. 기기를 옮기면
// 그 줄만 옛 경로로 남아 조용히 거짓말한다(맥 → 씽크패드에서 실제로 그랬다).
// 볼 곳을 만들어야 문서에 다시 박아넣지 않는다.
import 'dotenv/config';
import fs from 'fs';
import { projectQueries } from '../src/db/db.js';

// 열을 밀지 않으려면 넘치는 값은 잘라야 한다. 자르지 않으면 옆 열과 붙어
// 'github.com/x/y/home/user/z' 처럼 두 값이 한 값으로 읽힌다 — 표가 거짓말을 한다.
function fmt(v, w) {
  const s = String(v ?? '-');
  return (s.length > w - 1 ? s.slice(0, w - 2) + '…' : s).padEnd(w);
}
// github은 owner/repo만 보면 된다 — URL 전체는 폭만 먹는다.
function ghSlug(v) {
  if (!v) return '-';
  const m = String(v).match(/(?:github\.com[/:])?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return m ? m[1] : String(v);
}

async function main() {
  let rows;
  try {
    rows = await projectQueries.list();
  } catch (e) {
    console.error(`DB 조회 실패: ${e.message}`);
    console.error('NEON_DATABASE_URL 확인, 하네스가 최소 1회 기동했는지 확인하세요.');
    process.exit(1);
  }
  if (!rows.length) { console.log('등록된 프로젝트 없음.'); return; }

  console.log(`\n프로젝트 경로  (기준: ${new Date().toISOString()})`);
  console.log('─'.repeat(84));
  console.log(`${fmt('ID', 16)}${fmt('EXISTS', 8)}${fmt('GITHUB', 26)}PATH`);
  console.log('─'.repeat(84));
  let missing = 0;
  for (const r of rows) {
    // "등록됨"과 "실제로 있음"은 다르다 — 기기를 옮기면 갈라지는 지점이 정확히 여기다.
    const exists = r.path && fs.existsSync(r.path);
    if (!exists) missing++;
    console.log(`${fmt(r.id, 16)}${fmt(exists ? '✅' : '❌', 7)}${fmt(ghSlug(r.github), 26)}${r.path ?? '-'}`);
  }
  console.log('─'.repeat(84));
  if (missing) {
    console.log(`⚠️ ${missing}개 경로가 이 기기에 없다 — 그 프로젝트의 작업은 실행 즉시 실패한다.`);
    console.log('   대시보드나 /api/projects 로 경로를 이 기기 기준으로 고치세요.');
    process.exitCode = 1;
  } else {
    console.log('전체 경로 존재.');
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
