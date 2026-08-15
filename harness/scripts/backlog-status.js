// scripts/backlog-status.js
// 각 프로젝트 디렉티브의 "## Backlog" 미완료 항목 수를 출력한다.
//
// 하네스가 실제로 쓰는 parseDirective를 그대로 임포트한다 — 셸에서 정규식을 다시 짜면
// 여러 줄 HTML 주석이나 완료 체크박스 처리가 어긋나서 preflight가 거짓 보고를 한다.
//
// 실행: node scripts/backlog-status.js
// 출력: "<projectId>\t<미완료건수>\t<github슬러그|->" 한 줄씩, 마지막에 "TOTAL\t<합계>"

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseDirective } from '../src/agent/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.resolve(__dirname, '../../directives/projects');

let total = 0;

if (!fs.existsSync(PROJECTS_DIR)) {
  console.log(`TOTAL\t0`);
  process.exit(0);
}

const files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.md')).sort();
for (const file of files) {
  const id = file.replace(/\.md$/, '');
  let parsed;
  try {
    parsed = parseDirective(fs.readFileSync(path.join(PROJECTS_DIR, file), 'utf8'));
  } catch {
    continue;
  }
  total += parsed.backlog.length;
  console.log(`${id}\t${parsed.backlog.length}\t${parsed.github || '-'}`);
}

console.log(`TOTAL\t${total}`);
