// src/agent/manager.js
// 매니저 루프 — 프로젝트별 신호(needs_review/failed 작업, backlog.md, GitHub 이슈) 수집 →
// LLM에게 다음 작업 후보 제안 요청 → harness.backlog_items 에 저장.
//
// MANAGER_LOOP 플래그 뒤에서만 호출됨(게이트는 bot.js가 담당). 이 모듈 자체는 플래그를
// 모르며, 항상 순수하게 "신호 수집 → 제안 → 저장"만 한다.
//
// 매니저의 LLM 호출은 runner.js의 파이프라인(_claudeRun/_dispatchPhase)과 의도적으로
// 분리했다: 그쪽은 taskId가 harness.tasks FK를 가진 실제 작업 row를 전제로 로그를 남기는데,
// 매니저 스캔은 실제 작업이 아닌 1회성 브레인스토밍 호출이라 FK가 없는 가짜 taskId를 만들면
// 로그 insert가 FK 위반으로 실패한다. 그래서 세션/로그 DB 결합이 없는 독립 spawnSync 호출을
// 사용한다 — 실패해도 안전하게 해당 프로젝트만 skip된다.

import { spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { projectQueries, taskQueries, backlogQueries } from '../db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_HUB_ROOT = path.resolve(__dirname, '../../..');

const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';
const MANAGER_MODEL = process.env.PLAN_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MANAGER_LLM_TIMEOUT_MS = parseInt(process.env.MANAGER_LLM_TIMEOUT_MS || '120000', 10);
const MAX_SUGGESTIONS_PER_PROJECT = 3;
const MAX_SIGNALS_PER_SOURCE = 8;

function newBacklogId() {
  return `backlog_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

// ── 신호 수집 (모두 raw — 중복 제거는 scanProject에서 한 번에) ──────

function gatherTaskSignals(projectId, recentTasks) {
  const signals = [];
  for (const t of recentTasks) {
    if (t.project_id !== projectId) continue;
    if (t.status === 'needs_review') {
      const score = t.eval_result ? (() => { try { return JSON.parse(t.eval_result).score; } catch { return '-'; } })() : '-';
      signals.push({ source: 'needs_review', source_ref: t.id, text: `[needs_review] ${(t.prompt || '').slice(0, 200)} (eval score: ${score ?? '-'})` });
    } else if (t.status === 'failed') {
      signals.push({ source: 'failed_task', source_ref: t.id, text: `[failed] ${(t.prompt || '').slice(0, 200)} (error: ${(t.error || '').slice(0, 150)})` });
    }
  }
  return signals.slice(0, MAX_SIGNALS_PER_SOURCE * 2);
}

// backlog.md 줄의 안정적 식별자 — 줄 번호가 아니라 내용 해시를 쓴다.
// 줄 번호를 쓰면 파일 위쪽에 한 줄만 추가돼도 아래 모든 항목의 ref가 밀려서
// 이미 소진된 신호가 새 신호로 다시 잡힌다.
export function backlogLineRef(line) {
  const normalized = line.replace(/^[-*]\s*/, '').trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

function gatherBacklogFileSignals(project) {
  const filePath = path.join(AGENT_HUB_ROOT, 'directives', 'projects', project.id, 'backlog.md');
  if (!fs.existsSync(filePath)) return [];
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const lines = content.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- ') || l.startsWith('* '));
  return lines.slice(0, MAX_SIGNALS_PER_SOURCE).map(line => ({
    source: 'backlog_file',
    source_ref: backlogLineRef(line),
    text: line.replace(/^[-*]\s*/, ''),
  }));
}

function isGhAvailable() {
  try {
    const res = spawnSync('gh', ['--version'], { timeout: 3000, stdio: 'pipe' });
    return res.status === 0;
  } catch { return false; }
}

function gatherGithubIssueSignals(project) {
  if (!project.github || !isGhAvailable()) return [];
  try {
    const res = spawnSync('gh', [
      'issue', 'list', '--repo', project.github, '--state', 'open',
      '--limit', String(MAX_SIGNALS_PER_SOURCE), '--json', 'number,title,body',
    ], { timeout: 15000, encoding: 'utf8', stdio: 'pipe' });
    if (res.status !== 0) return [];
    const issues = JSON.parse(res.stdout || '[]');
    return issues.map(iss => ({
      source: 'github_issue',
      source_ref: String(iss.number),
      text: `#${iss.number} ${iss.title}\n${(iss.body || '').slice(0, 300)}`,
    }));
  } catch {
    return [];
  }
}

// 순수 필터 — 이미 소진된 (source, source_ref) 신호 제외. 같은 스캔 안의 중복도 제거.
// seenBySource: { [source]: Set<source_ref> }
export function filterSeenSignals(rawSignals, seenBySource) {
  const withinScan = new Set();
  return rawSignals.filter(s => {
    const key = `${s.source}::${s.source_ref}`;
    if (withinScan.has(key)) return false;
    if (seenBySource?.[s.source]?.has(String(s.source_ref))) return false;
    withinScan.add(key);
    return true;
  });
}

// 이미 제안 근거로 소진된 신호는 제외 — 재스캔 시 동일 이슈 반복 제안 방지.
// 소진 기록은 backlog_seen_signals 테이블(제안 row가 아님)이 들고 있다.
async function dedupeSignals(projectId, rawSignals) {
  const sources = [...new Set(rawSignals.map(s => s.source))];
  const seenBySource = {};
  for (const src of sources) {
    seenBySource[src] = await backlogQueries.seenRefs(projectId, src);
  }
  return filterSeenSignals(rawSignals, seenBySource);
}

// ── LLM 제안 (독립 1회성 호출) ────────────────────────────────

function runManagerLLM(prompt, cwd) {
  const res = spawnSync(CLAUDE_CLI, [
    '--print',
    '--model', MANAGER_MODEL,
    '--dangerously-skip-permissions',
    prompt,
  ], {
    cwd,
    encoding: 'utf8',
    timeout: MANAGER_LLM_TIMEOUT_MS,
    stdio: 'pipe',
    env: process.env,
  });
  if (res.error) throw new Error(`매니저 LLM 호출 실패: ${res.error.message}`);
  if (res.status !== 0 && !(res.stdout || '').trim()) {
    throw new Error(`매니저 LLM 비정상 종료 (code ${res.status}): ${(res.stderr || '').slice(0, 300)}`);
  }
  return (res.stdout || '').trim();
}

export function parseSuggestions(text) {
  const stripped = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(x => x && typeof x.title === 'string' && x.title.trim())
    .slice(0, MAX_SUGGESTIONS_PER_PROJECT)
    .map(x => ({
      title: String(x.title).slice(0, 200),
      description: String(x.description || '').slice(0, 2000),
      rationale: String(x.rationale || '').slice(0, 300),
    }));
}

function buildPrompt(project, signals) {
  const signalText = signals.map((s, i) => `${i + 1}. (${s.source}) ${s.text}`).join('\n\n');
  return [
    `프로젝트 "${project.name}" (${project.description || project.stack || ''})의 다음 작업 후보를 제안해줘.`,
    '',
    '아래는 이 프로젝트의 최근 신호(미해결 이슈/실패한 작업/백로그 메모)다:',
    '',
    signalText,
    '',
    `이 신호들을 바탕으로 구체적이고 단일 스코프인 작업 후보를 최대 ${MAX_SUGGESTIONS_PER_PROJECT}개 제안해라.`,
    '각 후보는 한 번의 빌드 라운드로 끝낼 수 있을 만큼 좁은 범위여야 한다.',
    '파일을 읽거나 수정하지 말고, 위 신호 텍스트만 근거로 판단해라.',
    '',
    '반드시 아래 JSON 배열 형식으로만 답하라 (다른 설명 텍스트 없이):',
    '[{"title": "...", "description": "...", "rationale": "이 신호를 근거로 제안하는 이유 1줄"}]',
  ].join('\n');
}

// ── 프로젝트 1개 스캔 ──────────────────────────────────────────

async function scanProject(project, recentTasks) {
  const rawSignals = [
    ...gatherTaskSignals(project.id, recentTasks),
    ...gatherBacklogFileSignals(project),
    ...gatherGithubIssueSignals(project),
  ];
  if (rawSignals.length === 0) return { projectId: project.id, projectName: project.name, proposed: [], skipped: 'no_signals' };

  const signals = await dedupeSignals(project.id, rawSignals);
  if (signals.length === 0) return { projectId: project.id, projectName: project.name, proposed: [], skipped: 'all_signals_seen' };

  let suggestions;
  try {
    const output = runManagerLLM(buildPrompt(project, signals), project.path);
    suggestions = parseSuggestions(output);
  } catch (err) {
    return { projectId: project.id, projectName: project.name, proposed: [], skipped: `llm_error: ${err.message.slice(0, 150)}` };
  }
  if (suggestions.length === 0) return { projectId: project.id, projectName: project.name, proposed: [], skipped: 'no_suggestions' };

  const proposed = [];
  for (const s of suggestions) {
    const id = newBacklogId();
    const insertedId = await backlogQueries.propose({
      id,
      project_id: project.id,
      source: 'manager_suggestion',
      source_ref: id, // 제안 자체는 항상 신규 — 근거 신호 단계에서 이미 중복 제거됨
      title: s.title,
      description: s.description,
      rationale: s.rationale,
    });
    if (insertedId) proposed.push({ id: insertedId, title: s.title, rationale: s.rationale, projectId: project.id, projectName: project.name });
  }

  // 제안이 실제로 저장된 뒤에만 근거 신호를 소진 처리한다.
  // LLM 실패/빈 응답으로 여기까지 오지 못한 신호는 기록되지 않으므로 다음 스캔에서 재시도된다.
  if (proposed.length > 0) {
    try {
      await backlogQueries.markSignalsSeen(project.id, signals);
    } catch (err) {
      console.error(`[manager] 신호 소진 기록 실패 (${project.id}): ${err.message}`);
    }
  }

  return { projectId: project.id, projectName: project.name, proposed, skipped: null };
}

// ── 전체 스캔 진입점 ──────────────────────────────────────────
// 활성 작업이 있는 프로젝트는 건너뜀(중복 제안 방지). 반환값은 호출자(bot.js)가
// 다이제스트 메시지로 조립한다.
export async function runManagerScan() {
  const projects = await projectQueries.list();
  const recentTasks = await taskQueries.list(100);
  const harnessRootReal = fs.realpathSync(AGENT_HUB_ROOT);
  const results = [];
  for (const project of projects) {
    // 하네스 자체 저장소는 스캔 대상에서 제외 — 브랜치 모드 실행이 금지되어 있으므로
    // 제안해봐야 승인 시점에 거부됨(runner.js run() 가드와 대칭).
    const projectReal = fs.existsSync(project.path) ? fs.realpathSync(project.path) : path.resolve(project.path);
    if (projectReal === harnessRootReal) {
      results.push({ projectId: project.id, projectName: project.name, proposed: [], skipped: 'harness_self_excluded' });
      continue;
    }
    const active = await taskQueries.getActiveForProject(project.id);
    if (active) {
      results.push({ projectId: project.id, projectName: project.name, proposed: [], skipped: 'active_task' });
      continue;
    }
    results.push(await scanProject(project, recentTasks));
  }
  return { results, proposed: results.flatMap(r => r.proposed) };
}

export function formatScanDigest({ results, proposed }) {
  if (proposed.length === 0) {
    const scanned = results.length;
    return `🔍 <b>스캔 완료</b>\n\n${scanned}개 프로젝트 확인 — 새 제안 없음.`;
  }
  const byProject = new Map();
  for (const p of proposed) {
    if (!byProject.has(p.projectId)) byProject.set(p.projectId, { name: p.projectName, items: [] });
    byProject.get(p.projectId).items.push(p);
  }
  let msg = `🔍 <b>스캔 완료</b> — 새 제안 ${proposed.length}개\n`;
  for (const [, { name, items }] of byProject) {
    msg += `\n<b>${name}</b>\n`;
    msg += items.map(it => `• <code>${it.id}</code> ${it.title}\n  └ ${it.rationale || '(근거 없음)'}`).join('\n') + '\n';
  }
  msg += '\n/approve <id> 또는 /reject <id> 로 결정하세요.';
  return msg;
}
