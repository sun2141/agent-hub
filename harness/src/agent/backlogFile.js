// src/agent/backlogFile.js
// "원문 백로그" — directives/projects/<id>.md 의 "## Backlog" 섹션에 사람이 적은 요구사항.
//
// 이름이 비슷한 두 가지를 구분해야 한다:
//   · 원문 백로그 (이 파일)        = 사람이 적은 요구사항. manager.js가 "의도 신호"로 읽는다.
//   · 제안 백로그 (backlog_items)  = /scan 이 LLM으로 만든 작업 후보. /approve 대상.
//
// 텔레그램 /backlog 와 /add 가 이 모듈을 통해 원문 백로그를 보여주고 고친다.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripHtmlComments, backlogLineRef } from './manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_HUB_ROOT = path.resolve(__dirname, '../../..');

// 프로젝트 id가 경로로 해석되지 않도록 (../ 등) 화이트리스트로 막는다.
const PROJECT_ID_RE = /^[A-Za-z0-9._-]+$/;
export const MAX_ITEM_LENGTH = 500;

export function directivePath(projectId, root = AGENT_HUB_ROOT) {
  if (!PROJECT_ID_RE.test(String(projectId || ''))) {
    throw new Error(`잘못된 프로젝트 id: ${projectId}`);
  }
  return path.join(root, 'directives', 'projects', `${projectId}.md`);
}

// "## Backlog" 섹션의 미완료 불릿만 수집한다.
// ref는 줄 번호가 아니라 내용 해시다 — 위에 한 줄 추가돼도 아래 항목의 ref가 안 밀린다.
// manager.js가 신호 소진 기록에 쓰는 ref와 같은 값이어야 하므로 backlogLineRef를 공유한다.
export function parseBacklogItems(md) {
  if (!md || typeof md !== 'string') return [];
  const items = [];
  const seen = new Set();
  let inSection = false;

  for (const rawLine of stripHtmlComments(md).split('\n')) {
    if (/^##\s/.test(rawLine)) {
      inSection = /^##\s+Backlog\s*$/i.test(rawLine.trimEnd());
      continue;
    }
    if (!inSection) continue;

    const line = rawLine.trim();
    if (!line.startsWith('- ') && !line.startsWith('* ')) continue;
    const body = line.replace(/^[-*]\s*/, '');
    if (/^\[[xX]\]/.test(body)) continue;                 // 완료 항목 제외
    const text = body.replace(/^\[\s?\]\s*/, '').trim();
    if (!text) continue;

    const ref = backlogLineRef(text);
    if (seen.has(ref)) continue;                          // 같은 문장 중복 방지
    seen.add(ref);
    items.push({ text, ref });
  }
  return items;
}

// { exists, items } — 파일이 없으면 exists:false (에러 아님. 안내 문구가 달라진다)
// id가 규격 밖이어도 던지지 않는다: /backlog는 등록된 프로젝트를 전부 훑기 때문에,
// 하나가 이상하다고 목록 전체가 실패하면 안 된다.
export function listBacklog(projectId, root = AGENT_HUB_ROOT) {
  let p;
  try { p = directivePath(projectId, root); }
  catch (err) { return { exists: false, path: null, items: [], invalidId: true, error: err.message }; }
  if (!fs.existsSync(p)) return { exists: false, path: p, items: [] };
  try {
    return { exists: true, path: p, items: parseBacklogItems(fs.readFileSync(p, 'utf8')) };
  } catch (err) {
    return { exists: true, path: p, items: [], error: err.message };
  }
}

export function findBacklogItem(projectId, ref, root = AGENT_HUB_ROOT) {
  return listBacklog(projectId, root).items.find(it => it.ref === ref) || null;
}

// "## Backlog" 섹션 끝에 "- [ ] <내용>" 한 줄을 추가한다.
// 섹션이 없으면 파일 끝에 섹션째 만든다. 이미 같은 문장이 있으면 추가하지 않는다.
export function addBacklogItem(projectId, text, root = AGENT_HUB_ROOT) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('내용이 비어 있습니다');
  if (clean.length > MAX_ITEM_LENGTH) throw new Error(`내용이 너무 깁니다 (${MAX_ITEM_LENGTH}자 이내)`);

  const p = directivePath(projectId, root);
  if (!fs.existsSync(p)) {
    throw new Error(`디렉티브 파일이 없습니다: directives/projects/${projectId}.md`);
  }

  const raw = fs.readFileSync(p, 'utf8');
  const ref = backlogLineRef(clean);
  const existing = parseBacklogItems(raw);
  if (existing.some(it => it.ref === ref)) {
    return { text: clean, ref, duplicate: true, createdSection: false };
  }

  const lines = raw.split('\n');
  const start = lines.findIndex(l => /^##\s+Backlog\s*$/i.test(l.trimEnd()));

  if (start === -1) {
    const next = `${raw.replace(/\s*$/, '')}\n\n## Backlog\n\n- [ ] ${clean}\n`;
    fs.writeFileSync(p, next, 'utf8');
    return { text: clean, ref, duplicate: false, createdSection: true };
  }

  // 섹션 범위 = 다음 "## " 헤딩 직전까지 (없으면 파일 끝)
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  // 섹션 안 마지막 비어있지 않은 줄 뒤에 넣는다 (다음 섹션과의 빈 줄은 보존)
  let insertAt = start + 1;
  for (let i = start + 1; i < end; i++) if (lines[i].trim() !== '') insertAt = i + 1;

  // 섹션에 실제 항목이 아직 없으면(= 안내 주석만 있으면) 빈 줄을 하나 끼워 읽기 좋게 둔다.
  // 주석 안의 예시 불릿에 붙여 쓰면 사람이 볼 때 주석의 일부처럼 보인다.
  const prev = insertAt > 0 ? lines[insertAt - 1].trim() : '';
  const needsGap = existing.length === 0 && prev !== '';
  const insertion = needsGap ? ['', `- [ ] ${clean}`] : [`- [ ] ${clean}`];

  lines.splice(insertAt, 0, ...insertion);
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return { text: clean, ref, duplicate: false, createdSection: false };
}
