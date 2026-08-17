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
// 로그 insert가 FK 위반으로 실패한다. 그래서 세션/로그 DB 결합이 없는 독립 프로세스 호출을
// 사용한다 — 실패해도 안전하게 해당 프로젝트만 skip된다.

import { spawn } from 'child_process';
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

// 신호는 두 종류다:
//   의도(intent) 신호  — backlog 항목, GitHub 이슈. 사람이 "이걸 하고 싶다"고 적은 것.
//   이력(history) 신호 — 하네스 자신의 needs_review/failed 작업. 자기참조다.
// 이력 신호만으로 제안하면 하네스가 자기 실패에 대한 후속 작업을 계속 만들어내는
// 자기참조 루프가 된다(= 목적이 아닌 잡일 생성기). 그래서:
//   1) 이력 신호 개수를 의도 신호보다 훨씬 적게 잡고,
//   2) 기본값으로 의도 신호가 하나도 없는 프로젝트는 아예 제안하지 않는다.
const MAX_HISTORY_SIGNALS = parseInt(process.env.MANAGER_MAX_HISTORY_SIGNALS || '3', 10);
const REQUIRE_INTENT_SIGNAL = process.env.MANAGER_REQUIRE_INTENT_SIGNAL !== 'false';

export const INTENT_SOURCES = new Set(['backlog_file', 'github_issue']);
export function hasIntentSignal(signals) {
  return signals.some(s => INTENT_SOURCES.has(s.source));
}

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
  // 이력 신호는 의도 신호를 밀어내지 않도록 소수만 — 위 MAX_HISTORY_SIGNALS 주석 참고.
  return signals.slice(0, MAX_HISTORY_SIGNALS);
}

// ── 프로젝트 디렉티브 파일 파싱 ────────────────────────────────
// 이 저장소의 기존 규약은 프로젝트당 파일 하나다: directives/projects/{id}.md
// (예: "**GitHub**: sun2141/palmoni", "## Backlog" 섹션).
// 초기 구현은 directives/projects/{id}/backlog.md 라는 존재하지 않는 디렉토리 구조를
// 찾고 있어서 backlog 신호가 한 번도 잡히지 않았다. 이제 둘 다 지원한다.
// 주석 안의 예시 불릿("- [ ] 이렇게 적으세요")이 진짜 백로그 항목으로 잡히지 않도록
// HTML 주석을 먼저 걷어낸다. 템플릿/사용법 안내를 주석으로 두는 파일이 많다.
export function stripHtmlComments(md) {
  return md.replace(/<!--[\s\S]*?-->/g, '');
}

// 불릿 한 줄 → 백로그 항목 텍스트. 항목이 아니거나 완료됨이면 null.
function backlogItemFrom(rawLine) {
  const line = rawLine.trim();
  if (!line.startsWith('- ') && !line.startsWith('* ')) return null;
  const body = line.replace(/^[-*]\s*/, '');
  if (/^\[[xX]\]/.test(body)) return null;            // 완료 항목 제외
  const text = body.replace(/^\[\s?\]\s*/, '').trim();
  return text || null;
}

export function parseDirective(md) {
  if (!md || typeof md !== 'string') return { github: null, backlog: [] };
  md = stripHtmlComments(md);

  // "**GitHub**: owner/repo" 또는 "- **GitHub**: https://github.com/owner/repo"
  let github = null;
  const ghMatch = md.match(/\*\*GitHub\*\*\s*:\s*([^\n]+)/i);
  if (ghMatch) {
    const raw = ghMatch[1].trim().replace(/^`|`$/g, '');
    const slug = raw.match(/(?:github\.com[/:])?([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (slug && slug[1] !== '-' && !/^-+$/.test(raw)) github = slug[1];
  }

  // "## Backlog" 섹션의 불릿만 수집 (다음 ## 헤딩 전까지).
  // 체크박스는 미완료(- [ ])만 신호로 본다 — 완료 항목은 다시 제안할 이유가 없다.
  // 정규식 하나로 "다음 ## 헤딩까지"를 잡으려다 JS에 없는 \Z를 쓰면(= 리터럴 'Z')
  // 파일 맨 끝의 Backlog 섹션이 통째로 안 잡힌다. 줄 단위로 명시적으로 훑는다.
  const backlog = [];
  let inSection = false;
  for (const rawLine of md.split('\n')) {
    if (/^##\s/.test(rawLine)) {
      inSection = /^##\s+Backlog\s*$/i.test(rawLine.trimEnd());
      continue;
    }
    if (!inSection) continue;
    const item = backlogItemFrom(rawLine);
    if (item) backlog.push(item);
  }
  return { github, backlog };
}

function readDirective(projectId) {
  const candidates = [
    path.join(AGENT_HUB_ROOT, 'directives', 'projects', `${projectId}.md`),
    path.join(AGENT_HUB_ROOT, 'directives', 'projects', projectId, 'directive.md'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try { return parseDirective(fs.readFileSync(p, 'utf8')); } catch { /* 다음 후보 */ }
  }
  return { github: null, backlog: [] };
}

// backlog.md 줄의 안정적 식별자 — 줄 번호가 아니라 내용 해시를 쓴다.
// 줄 번호를 쓰면 파일 위쪽에 한 줄만 추가돼도 아래 모든 항목의 ref가 밀려서
// 이미 소진된 신호가 새 신호로 다시 잡힌다.
export function backlogLineRef(line) {
  const normalized = line.replace(/^[-*]\s*/, '').trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

// 백로그 항목은 두 곳에서 온다:
//   1) directives/projects/{id}.md 의 "## Backlog" 섹션  ← 이 저장소의 기존 규약
//   2) directives/projects/{id}/backlog.md 전용 파일      ← 항목이 많아질 때
function gatherBacklogFileSignals(project, directive) {
  const items = [...(directive?.backlog || [])];

  const dedicated = path.join(AGENT_HUB_ROOT, 'directives', 'projects', project.id, 'backlog.md');
  if (fs.existsSync(dedicated)) {
    try {
      const content = stripHtmlComments(fs.readFileSync(dedicated, 'utf8'));
      for (const rawLine of content.split('\n')) {
        const item = backlogItemFrom(rawLine);
        if (item) items.push(item);
      }
    } catch { /* 무시 — 섹션 항목만으로 진행 */ }
  }

  return items.slice(0, MAX_SIGNALS_PER_SOURCE).map(text => ({
    source: 'backlog_file',
    source_ref: backlogLineRef(text),
    text,
  }));
}

// 모든 외부 명령은 비동기로 실행한다.
// spawnSync를 쓰면 명령이 끝날 때까지 Node 이벤트 루프가 통째로 멈춘다. 스캔은
// 프로젝트마다 gh 호출 + 최대 120초짜리 LLM 호출을 하므로, 동기 실행이면 스캔 한 번에
// 텔레그램 봇이 수 분간 어떤 명령에도 응답하지 못한다(실제로 그렇게 동작했다).
function exec(cmd, args, { cwd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', done = false;
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      resolve({ status: 1, stdout: '', stderr: err.message, spawnError: true });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      try { proc.kill('SIGKILL'); } catch { /* 무시 */ }
      stderr += `\n[timeout] ${Math.round(timeoutMs / 1000)}초 초과`;
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 400_000) stdout = stdout.slice(-200_000); });
    proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 100_000) stderr = stderr.slice(-50_000); });
    proc.on('close', code => { done = true; clearTimeout(timer); resolve({ status: code ?? 1, stdout, stderr }); });
    proc.on('error', err => { done = true; clearTimeout(timer); resolve({ status: 1, stdout, stderr: `${stderr}\n${err.message}`, spawnError: true }); });
  });
}

async function isGhAvailable() {
  const res = await exec('gh', ['--version'], { timeoutMs: 5_000 });
  return res.status === 0;
}

// repo slug는 DB의 project.github을 우선하되, 비어 있으면 디렉티브 파일에서 읽는다
// (projects.js에는 github 필드가 없고 디렉티브 파일이 사실상의 출처다).
async function gatherGithubIssueSignals(project, directive) {
  const repo = project.github || directive?.github;
  if (!repo) {
    console.log(`[manager] ${project.id}: GitHub 슬러그 없음 — 이슈 신호 건너뜀`);
    return [];
  }
  if (!await isGhAvailable()) {
    console.warn(`[manager] ${project.id}: gh CLI를 실행할 수 없음 — 이슈 신호 건너뜀 (설치/PATH 확인)`);
    return [];
  }
  const res = await exec('gh', [
    'issue', 'list', '--repo', repo, '--state', 'open',
    '--limit', String(MAX_SIGNALS_PER_SOURCE), '--json', 'number,title,body',
  ], { timeoutMs: 20_000 });
  if (res.status !== 0) {
    console.warn(`[manager] gh issue list 실패 (${repo}): ${(res.stderr || '').trim().slice(0, 200)}`);
    return [];
  }
  try {
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

async function runManagerLLM(prompt, cwd) {
  // cwd가 없으면 spawn 자체가 ENOENT로 실패한다 — 저장소를 아직 clone하지 않은 프로젝트.
  const runCwd = cwd && fs.existsSync(cwd) ? cwd : AGENT_HUB_ROOT;
  const res = await exec(CLAUDE_CLI, [
    '--print',
    '--model', MANAGER_MODEL,
    '--dangerously-skip-permissions',
    prompt,
  ], { cwd: runCwd, timeoutMs: MANAGER_LLM_TIMEOUT_MS });
  if (res.spawnError) throw new Error(`매니저 LLM 호출 실패: ${(res.stderr || '').slice(0, 200)}`);
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

export function buildPrompt(project, signals) {
  const intent = signals.filter(s => INTENT_SOURCES.has(s.source));
  const history = signals.filter(s => !INTENT_SOURCES.has(s.source));
  const fmt = (list) => list.map((s, i) => `${i + 1}. (${s.source}) ${s.text}`).join('\n\n');

  const parts = [
    `프로젝트 "${project.name}" (${project.description || project.stack || ''})의 다음 작업 후보를 제안해줘.`,
    '',
    '[의도 신호 — 사람이 직접 적은 요구사항. 제안의 근거는 여기서 나와야 한다]',
    '',
    intent.length ? fmt(intent) : '(없음)',
  ];

  if (history.length) {
    parts.push(
      '',
      '[이력 신호 — 하네스 자신의 실패/보류 작업. 참고용 맥락일 뿐 제안의 출발점이 아니다]',
      '',
      fmt(history),
    );
  }

  parts.push(
    '',
    `위 의도 신호를 바탕으로 구체적이고 단일 스코프인 작업 후보를 최대 ${MAX_SUGGESTIONS_PER_PROJECT}개 제안해라.`,
    '각 후보는 한 번의 빌드 라운드로 끝낼 수 있을 만큼 좁은 범위여야 한다.',
    '',
    '[제안하지 말아야 할 것]',
    '- 의도 신호와 무관하게 이력 신호만 근거로 한 후속 작업 (하네스 자체 뒤치다꺼리)',
    '- "리팩터링", "테스트 추가", "문서 정리" 같은 요구사항 없는 일반적 개선',
    '- 사용자가 요청한 적 없는 신규 기능 발명',
    '근거로 삼을 의도 신호가 없으면 빈 배열 []을 반환해라. 억지로 채우지 마라.',
    '',
    '파일을 읽거나 수정하지 말고, 위 신호 텍스트만 근거로 판단해라.',
    '',
    '반드시 아래 JSON 배열 형식으로만 답하라 (다른 설명 텍스트 없이):',
    '[{"title": "...", "description": "...", "rationale": "어느 의도 신호를 근거로 하는지 1줄"}]',
  );
  return parts.join('\n');
}

// ── 프로젝트 1개 스캔 ──────────────────────────────────────────

async function scanProject(project, recentTasks) {
  const directive = readDirective(project.id);
  const taskSig = gatherTaskSignals(project.id, recentTasks);
  const backlogSig = gatherBacklogFileSignals(project, directive);
  const issueSig = await gatherGithubIssueSignals(project, directive);
  const rawSignals = [...taskSig, ...backlogSig, ...issueSig];

  // 왜 제안이 안 나왔는지 로그만 보고도 알 수 있게 소스별 개수를 남긴다.
  console.log(
    `[manager] ${project.id}: 신호 수집 — 이력 ${taskSig.length}, ` +
    `백로그 ${backlogSig.length}, 이슈 ${issueSig.length} (repo=${project.github || directive?.github || '없음'})`
  );

  if (rawSignals.length === 0) return { projectId: project.id, projectName: project.name, proposed: [], skipped: 'no_signals' };

  const signals = await dedupeSignals(project.id, rawSignals);
  if (signals.length === 0) return { projectId: project.id, projectName: project.name, proposed: [], skipped: 'all_signals_seen' };

  // 의도 신호(백로그/이슈)가 없으면 제안하지 않는다 — 하네스가 자기 실패 이력만 보고
  // 잡일을 만들어내는 걸 막는 기본 가드. MANAGER_REQUIRE_INTENT_SIGNAL=false로 해제 가능.
  if (REQUIRE_INTENT_SIGNAL && !hasIntentSignal(signals)) {
    return { projectId: project.id, projectName: project.name, proposed: [], skipped: 'no_intent_signal' };
  }

  let suggestions;
  try {
    const output = await runManagerLLM(buildPrompt(project, signals), project.path);
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

// 스킵 사유를 사람이 읽을 수 있는 한 줄로 옮긴다.
// 사유를 감추면 "왜 내 이슈를 안 읽지?"를 서버 로그 없이는 알 수 없다 — 실제로 그랬다.
export const SKIP_REASONS = {
  no_signals:            '신호 없음 — 백로그·이슈·실패이력이 모두 비어 있음',
  all_signals_seen:      '이미 제안에 쓴 신호뿐',
  no_intent_signal:      '의도 신호 없음 — 백로그/이슈 필요',
  active_task:           '실행 중인 작업이 있어 건너뜀',
  harness_self_excluded: '하네스 자기 저장소 — 대상 아님',
  no_suggestions:        'LLM이 후보를 내지 않음',
};

export function describeSkip(skipped) {
  if (!skipped) return null;
  if (SKIP_REASONS[skipped]) return SKIP_REASONS[skipped];
  if (String(skipped).startsWith('llm_error:')) {
    return `LLM 호출 실패 — ${String(skipped).slice('llm_error:'.length).trim().slice(0, 120)}`;
  }
  return String(skipped);
}

export function formatScanDigest({ results, proposed }) {
  // 제안이 나오지 않은 프로젝트는 "왜 빠졌는지"를 하나씩 보여준다.
  const proposedIds = new Set(proposed.map(p => p.projectId));
  const skippedLines = results
    .filter(r => !proposedIds.has(r.projectId) && r.skipped)
    .map(r => `• ${r.projectName}: ${describeSkip(r.skipped)}`);
  const skipBlock = skippedLines.length
    ? `\n\n<b>건너뛴 프로젝트</b>\n${skippedLines.join('\n')}`
    : '';

  const needsIntent = results.some(r => r.skipped === 'no_intent_signal');
  const intentHint = needsIntent
    ? `\n\n📝 <code>directives/projects/&lt;id&gt;.md</code>의 <code>## Backlog</code> 섹션에 작업을 적거나 GitHub 이슈를 열면 다음 스캔에서 후보로 올라옵니다.`
    : '';

  if (proposed.length === 0) {
    const scanned = results.length;
    return `🔍 <b>스캔 완료</b>\n\n${scanned}개 프로젝트 확인 — 새 제안 없음.${skipBlock}${intentHint}`;
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
  msg += '\n/approve <id> 또는 /reject <id> 로 결정하세요.' + skipBlock + intentHint;
  return msg;
}
