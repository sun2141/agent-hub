// scripts/backlog-inspect.js
// "제안 목록에서 항목이 사라졌는데 어떻게 된 건가"를 답하는 진단 도구.
//
// /proposals 는 status='proposed' 만 보여준다. 승인·거부된 항목은 조용히 빠지고,
// 근거로 쓰인 신호(GitHub 이슈 등)는 소진 기록에 남아 다시 제안되지 않는다.
// 그래서 "이슈는 3개인데 제안은 2개"가 정상일 수 있고, 이 스크립트가 그걸 구분해준다.
//
// 실행: node scripts/backlog-inspect.js   또는  npm run backlog:inspect

import 'dotenv/config';
import '../src/util/netdefaults.js';
import { backlogQueries, projectQueries } from '../src/db/db.js';
import { formatLocal } from '../src/util/time.js';

const STATUS_LABEL = {
  proposed: '⏳ 대기',
  approved: '✅ 승인',
  rejected: '🚫 거부',
};

const SOURCE_LABEL = {
  github_issue: 'GitHub 이슈',
  backlog_file: '백로그 파일',
  needs_review: '검토필요 이력',
  failed_task:  '실패 이력',
};

function pad(s, n) {
  const str = String(s ?? '');
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

const items = await backlogQueries.listRecent(30);
const seen = await backlogQueries.allSeenSignals();
const projects = await projectQueries.list();
const nameById = new Map(projects.map(p => [p.id, p.name]));

console.log('\n── 제안 이력 (backlog_items, 최신 30건) ─────────────────────');
if (!items.length) {
  console.log('  (없음) — /scan 이 아직 제안을 만든 적이 없습니다.');
} else {
  const counts = {};
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
  console.log('  ' + Object.entries(counts).map(([k, v]) => `${STATUS_LABEL[k] || k} ${v}`).join('  |  ') + '\n');

  for (const it of items) {
    const when = it.decided_at || it.proposed_at;
    console.log(`  ${pad(STATUS_LABEL[it.status] || it.status, 8)} ${pad(it.project_name || it.project_id, 14)} ${String(it.title || '').slice(0, 52)}`);
    console.log(`           ${it.id}${it.task_id ? `  →  ${it.task_id}` : ''}   ${formatLocal(when)}`);
  }
}

console.log('\n── 소진된 신호 (backlog_seen_signals) ───────────────────────');
console.log('   이미 제안 근거로 쓴 신호입니다. 제안을 거부해도 되돌아가지 않으므로');
console.log('   같은 이슈/백로그 줄은 /scan 에서 다시 올라오지 않습니다.\n');
if (!seen.length) {
  console.log('  (없음)');
} else {
  const grouped = new Map();
  for (const s of seen) {
    const key = `${s.project_id}|${s.source}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(s.source_ref);
  }
  for (const [key, refs] of grouped) {
    const [pid, source] = key.split('|');
    const shown = source === 'github_issue' ? refs.map(r => `#${r}`) : refs.map(r => r.slice(0, 12));
    console.log(`  ${pad(nameById.get(pid) || pid, 14)} ${pad(SOURCE_LABEL[source] || source, 14)} ${shown.join(', ')}`);
  }
}

console.log('\n── 읽는 법 ─────────────────────────────────────────────────');
console.log('  · 제안이 ✅승인 이면 → task_id 로 실행됐습니다. /status 로 진행 확인.');
console.log('  · 제안이 🚫거부 이면 → 근거 신호는 소진된 채라 다시 제안되지 않습니다.');
console.log('  · 이슈는 있는데 제안이 없고 소진 기록에도 없으면 → LLM이 후보로 뽑지 않은 것입니다.');
console.log('  · 소진 기록만 있고 제안이 안 보이면 → 그 제안이 30건 밖으로 밀렸거나 삭제된 것입니다.\n');

process.exit(0);
