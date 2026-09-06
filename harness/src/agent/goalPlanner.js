// src/agent/goalPlanner.js
// 목표 → 계획서 생성.
//
// 이 모듈의 값어치는 "LLM에게 계획을 시킨다"가 아니라 **나쁜 계획을 기계로 거절한다**에 있다.
// 계획 1회 승인 후 자동 실행이므로, 여기서 통과한 문장이 며칠치 실행을 좌우한다.
//
// 거절 규칙 (validatePlan)
//   1. 모든 항목에 검증 가능한 acceptance_criteria
//   2. 모든 항목에 verify_cmd 또는 소속 마일스톤의 exit_criteria
//   3. 대상 프로젝트에 verify 스크립트가 없으면 첫 마일스톤은 반드시 그것을 채우는 일
//   4. 워크스트림 간 file_scope 교집합이 비어 있을 것
//   5. 항목 크기 est_runs <= 2, 그리고 Σest_runs가 기한 용량을 넘지 않을 것
//
// 모호한 목표는 계획 대신 질문을 낸다(clarify). 통과시키면 LLM이 사업 판단을 지어내고
// 며칠치 실행이 그 가정 위에 쌓인다.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { goalQueries, planQueries, goalEventQueries } from '../db/goals.js';
import { estimateCapacity } from './pace.js';

const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';
const PLANNER_MODEL = process.env.PLAN_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const PLANNER_TIMEOUT_MS = parseInt(process.env.GOAL_PLANNER_TIMEOUT_MS || '180000', 10);

const MAX_ITEMS = parseInt(process.env.GOAL_MAX_ITEMS || '20', 10);
const MAX_EST_RUNS_PER_ITEM = 2;

// 프로젝트가 "객관 검증이 가능한 상태"로 인정되는 최소 스크립트
const VERIFY_SCRIPTS = ['typecheck', 'lint', 'test', 'smoketest', 'verify'];

// ── 프로세스 실행 ──────────────────────────────────────────────
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

// ── 컨텍스트 수집 ──────────────────────────────────────────────

// 대상 프로젝트에 어떤 검증 스크립트가 실제로 있는가.
// "있다고 적혀 있음"이 아니라 package.json scripts에 실재하는지를 본다.
export function readVerifyScripts(projectPath) {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return { scripts: [], hasPackageJson: false };
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const all = Object.keys(pkg.scripts || {});
    return {
      scripts: all.filter(s => VERIFY_SCRIPTS.includes(s)),
      allScripts: all,
      hasPackageJson: true,
    };
  } catch {
    return { scripts: [], hasPackageJson: false };
  }
}

// 저장소 구조 요약 — 계획이 실재하는 경로를 가리키게 하려면 이게 있어야 한다.
async function repoTree(projectPath, limit = 120) {
  if (!projectPath || !fs.existsSync(projectPath)) return '(저장소 없음)';
  const res = await exec('git', ['ls-files'], { cwd: projectPath, timeoutMs: 15_000 });
  if (res.status !== 0) return '(git ls-files 실패)';
  const files = (res.stdout || '').split('\n').filter(Boolean);
  if (files.length <= limit) return files.join('\n');
  // 너무 많으면 디렉터리 수준으로 접는다.
  const dirs = new Map();
  for (const f of files) {
    const d = f.includes('/') ? f.split('/').slice(0, 2).join('/') : '(root)';
    dirs.set(d, (dirs.get(d) || 0) + 1);
  }
  return [...dirs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([d, n]) => `${d}/  (${n}개 파일)`)
    .join('\n');
}

export async function gatherContext(project) {
  const projectPath = project.path;
  const verify = readVerifyScripts(projectPath);
  const tree = await repoTree(projectPath);
  return {
    project,
    projectPath,
    verifyScripts: verify.scripts,
    allScripts: verify.allScripts || [],
    hasPackageJson: verify.hasPackageJson,
    tree,
  };
}

// ── 프롬프트 ───────────────────────────────────────────────────
export function buildPlanPrompt(goal, ctx, capacity, retryErrors = null) {
  const hasVerify = ctx.verifyScripts.length > 0;
  const capLine = capacity.capacity === null
    ? '기한이 없다. est_runs 총합에 상한은 없지만 20개 항목을 넘기지 마라.'
    : `기한까지 ${capacity.days}일, 처리 가능한 총 실행 횟수는 약 ${capacity.capacity}회다. `
      + `모든 항목의 est_runs 합이 이 값을 넘으면 안 된다. `
      + `넘길 수밖에 없으면 scope_cut에 "무엇을 빼면 기한을 맞출 수 있는지"를 적어라.`;

  const parts = [
    `너는 개발 매니저다. 아래 목표를 자동 실행 가능한 작업 계획서로 분해한다.`,
    '',
    `[프로젝트] ${ctx.project.name} — ${ctx.project.stack || ''} ${ctx.project.description || ''}`,
    `[목표] ${goal.title}`,
    `[완료 조건] ${goal.outcome}`,
    `[기한] ${goal.due_date || '없음'}`,
    `[목표 종류] ${goal.kind === 'research' ? 'research — 코드를 바꾸지 않는다. 산출물은 리포트 파일 하나다.' : 'build — 코드를 바꾸고 항목마다 PR을 만든다.'}`,
    '',
    '[저장소 구조]',
    ctx.tree,
    '',
    `[검증 스크립트 현황] package.json scripts 중 검증용: ${hasVerify ? ctx.verifyScripts.join(', ') : '없음'}`,
    '',
    '[반드시 지킬 규칙]',
    '1. 각 항목의 acceptance_criteria는 검증 가능한 문장이어야 한다. "개선한다" "최적화한다" 금지.',
    '   나쁨: "로그인 개선"  /  좋음: "로그인 실패 3회 시 60초 잠금, 잠금 중 시도하면 남은 초를 응답에 포함"',
    '2. 각 항목에 verify_cmd(그 항목을 판정할 셸 명령)를 넣어라. 없으면 소속 마일스톤의 exit_criteria가 그 역할을 해야 한다.',
    hasVerify
      ? '3. 검증 스크립트가 이미 있으므로 그것을 verify_cmd에 활용하라.'
      : '3. 이 프로젝트에는 검증 스크립트가 하나도 없다. **첫 번째 마일스톤은 반드시 typecheck/lint/test/smoketest를 채우는 일이어야 한다.** 그 전에는 어떤 기능 항목도 배치하지 마라.',
    '4. 워크스트림은 서로 건드리는 파일이 겹치면 안 된다. file_scope에 경로 접두사를 적고, 겹치면 하나로 합쳐라.',
    `5. 항목 하나의 est_runs는 최대 ${MAX_EST_RUNS_PER_ITEM}이다. 더 크면 항목을 쪼개라.`,
    `6. ${capLine}`,
    `7. 항목은 최대 ${MAX_ITEMS}개.`,
    '',
    '[목표가 모호해서 계획을 세울 수 없다면]',
    '계획 대신 아래 형식으로 질문만 내라. 단, **코드를 읽으면 알 수 있는 것은 묻지 마라.**',
    '사업 판단·가격·우선순위·"완료"의 정의처럼 사람만 답할 수 있는 것만 묻는다.',
    '{"needs_clarification": [{"question": "...", "why": "...", "options": ["...", "..."]}]}',
    '',
    '[출력 형식 — JSON 하나만. 설명 문장 금지]',
    JSON.stringify({
      rationale: '왜 이렇게 쪼갰는지 3줄 이내',
      risk_notes: '이 계획에서 가장 깨지기 쉬운 지점',
      scope_cut: ['기한이 빠듯할 때 뺄 후보 항목 title'],
      workstreams: [{ key: 'ws1', name: '인증', file_scope: ['src/auth/', 'src/lib/session.js'], depends_on: [] }],
      milestones: [{ key: 'm1', title: '검증 게이트 구축', target_date: 'YYYY-MM-DD', exit_criteria: 'npm run verify 가 통과' }],
      items: [{
        title: '한 줄 요약',
        workstream: 'ws1',
        milestone: 'm1',
        acceptance_criteria: '검증 가능한 완료 조건',
        verify_cmd: 'npm run test',
        target_paths: ['src/auth/login.js'],
        est_runs: 1,
      }],
    }, null, 2),
  ];

  if (retryErrors && retryErrors.length) {
    parts.push(
      '',
      '[이전 시도가 아래 이유로 거절되었다. 전부 고쳐서 다시 내라]',
      ...retryErrors.map((e, i) => `${i + 1}. ${e}`),
    );
  }

  return parts.join('\n');
}

// ── 파싱 ───────────────────────────────────────────────────────
export function parsePlanOutput(text) {
  const stripped = String(text || '').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ── 검증 ───────────────────────────────────────────────────────

// "검증 가능한가"의 근사 — 금지어가 들어 있고 구체 수치·경로·조건이 없으면 거절한다.
const VAGUE_PATTERNS = [
  /개선(한다|하기|$)/, /최적화/, /고도화/, /정리(한다|하기)?$/,
  /강화(한다|하기)?$/, /향상/, /좋게/, /깔끔하게/,
  /^.{0,15}$/,   // 너무 짧아 판정 불가
];

export function looksVerifiable(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  for (const re of VAGUE_PATTERNS) {
    if (re.test(t)) return false;
  }
  return true;
}

export function validatePlan(plan, ctx, capacity, goal) {
  const errors = [];

  if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) {
    return ['items가 비어 있다. 최소 1개 항목이 필요하다.'];
  }
  if (plan.items.length > MAX_ITEMS) {
    errors.push(`항목이 ${plan.items.length}개다. 최대 ${MAX_ITEMS}개로 줄여라.`);
  }

  const milestoneByKey = new Map(
    (plan.milestones || []).map(m => [m.key || m.title, m])
  );

  // 규칙 1·2·5 — 항목 단위
  let totalRuns = 0;
  plan.items.forEach((it, idx) => {
    const label = `항목 ${idx + 1} ("${(it.title || '제목없음').slice(0, 40)}")`;

    if (!it.title || !String(it.title).trim()) {
      errors.push(`${label}: title이 비었다.`);
    }
    if (!looksVerifiable(it.acceptance_criteria)) {
      errors.push(`${label}: acceptance_criteria가 검증 불가능하다 — "${String(it.acceptance_criteria || '').slice(0, 60)}". 구체적인 조건·수치·경로로 다시 써라.`);
    }
    const ms = milestoneByKey.get(it.milestone);
    const hasGate = (it.verify_cmd && String(it.verify_cmd).trim())
      || (ms && ms.exit_criteria && String(ms.exit_criteria).trim());
    if (!hasGate) {
      errors.push(`${label}: verify_cmd가 없고 소속 마일스톤에도 exit_criteria가 없다. 판정할 방법이 없는 항목은 실행할 수 없다.`);
    }

    const runs = Number(it.est_runs) || 1;
    if (runs > MAX_EST_RUNS_PER_ITEM) {
      errors.push(`${label}: est_runs=${runs}. 항목 하나는 최대 ${MAX_EST_RUNS_PER_ITEM}회다. 더 작게 쪼개라.`);
    }
    totalRuns += runs;
  });

  // 규칙 3 — 검증 스크립트가 없으면 첫 마일스톤이 그것을 채우는 일이어야 한다
  if (ctx.verifyScripts.length === 0 && goal.kind !== 'research') {
    const first = (plan.milestones || [])[0];
    // 제목으로 판정한다. exit_criteria까지 함께 훑으면 "npm run test 통과" 같은
    // 흔한 판정 문구 때문에 아무 마일스톤이나 게이트 구축으로 오인된다 —
    // 실제로 이 규칙을 무력화시켰던 지점이라 테스트로 고정해뒀다.
    const firstTitle = String(first?.title || '');
    const firstExit = String(first?.exit_criteria || '');
    const buildsGate =
      /(verify|typecheck|lint|smoketest|smoke ?test|검증|게이트|테스트 ?(구축|추가|정비))/i.test(firstTitle)
      || /npm run verify/i.test(firstExit);
    if (!buildsGate) {
      errors.push(
        '이 프로젝트에는 검증 스크립트가 없는데 첫 마일스톤이 검증 게이트 구축이 아니다. '
        + '첫 마일스톤을 "typecheck/lint/test/smoketest를 채우고 npm run verify가 통과"로 바꾸고, '
        + '기능 항목은 그 뒤에 배치하라.'
      );
    }
  }

  // 규칙 4 — 워크스트림 file_scope 교집합
  const ws = plan.workstreams || [];
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      const overlap = overlappingScopes(ws[i].file_scope || [], ws[j].file_scope || []);
      if (overlap.length) {
        errors.push(
          `워크스트림 "${ws[i].name}"와 "${ws[j].name}"의 file_scope가 겹친다 (${overlap.join(', ')}). `
          + '합치거나 경로를 나눠라 — 겹치면 머지 충돌과 재작업이 난다.'
        );
      }
    }
  }

  // 규칙 6 — 기한 용량
  if (capacity.capacity !== null && totalRuns > capacity.capacity) {
    const hasCut = Array.isArray(plan.scope_cut) && plan.scope_cut.length > 0;
    errors.push(
      `est_runs 합계가 ${totalRuns}회인데 기한까지 처리 가능한 용량은 약 ${capacity.capacity}회다.`
      + (hasCut ? ' scope_cut이 있으니 그만큼 항목을 줄여서 다시 내라.' : ' 항목을 줄이거나 scope_cut을 채워라.')
    );
  }

  return errors;
}

// 경로 접두사 기준 겹침. "src/auth/"와 "src/auth/login.js"는 겹친다.
export function overlappingScopes(a, b) {
  const norm = (s) => String(s || '').replace(/^\.\//, '').replace(/\/+$/, '');
  const out = [];
  for (const x of a.map(norm)) {
    for (const y of b.map(norm)) {
      if (!x || !y) continue;
      if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) {
        out.push(x === y ? x : `${x} ↔ ${y}`);
      }
    }
  }
  return [...new Set(out)];
}

// ── LLM 호출 ───────────────────────────────────────────────────
async function runPlannerLLM(prompt, cwd) {
  const runCwd = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const res = await exec(CLAUDE_CLI, [
    '--print',
    '--model', PLANNER_MODEL,
    '--dangerously-skip-permissions',
    prompt,
  ], { cwd: runCwd, timeoutMs: PLANNER_TIMEOUT_MS });

  if (res.spawnError) throw new Error(`계획 LLM 호출 실패: ${(res.stderr || '').slice(0, 200)}`);
  if (res.status !== 0 && !(res.stdout || '').trim()) {
    throw new Error(`계획 LLM 비정상 종료 (code ${res.status}): ${(res.stderr || '').slice(0, 300)}`);
  }
  return (res.stdout || '').trim();
}

// ── 본체 ───────────────────────────────────────────────────────

/**
 * 목표 하나를 계획서로 분해한다.
 * @returns {{ ok: boolean, kind: 'plan'|'clarify'|'error', planId?, version?, questions?, errors?, message? }}
 */
export async function planGoal(goalId, { projectResolver } = {}) {
  const goal = await goalQueries.get(goalId);
  if (!goal) return { ok: false, kind: 'error', message: '목표를 찾을 수 없습니다.' };

  const project = projectResolver
    ? await projectResolver(goal.project_id)
    : { id: goal.project_id, name: goal.project_name, path: null };

  if (!project) {
    return { ok: false, kind: 'error', message: `프로젝트 ${goal.project_id}를 찾을 수 없습니다.` };
  }

  await goalQueries.setStatus(goalId, 'planning');
  await goalEventQueries.add({
    goal_id: goalId, kind: 'plan_started',
    message: `계획 생성 시작 — ${goal.title}`,
  });

  try {
    const ctx = await gatherContext(project);
    const capacity = await estimateCapacity(goal.due_date);

    let errors = null;
    let parsed = null;

    // 1회 재시도. 두 번 다 실패하면 사람에게 넘긴다 —
    // 여기서 무한 재시도를 걸면 한도만 태우고 같은 실패를 반복한다.
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = buildPlanPrompt(goal, ctx, capacity, errors);
      const raw = await runPlannerLLM(prompt, ctx.projectPath);
      parsed = parsePlanOutput(raw);

      if (!parsed) {
        errors = ['출력이 JSON으로 파싱되지 않았다. JSON 객체 하나만 출력하라.'];
        continue;
      }

      // 되물음 경로
      if (Array.isArray(parsed.needs_clarification) && parsed.needs_clarification.length) {
        const questions = parsed.needs_clarification.slice(0, 5).map(q => ({
          question: String(q.question || '').slice(0, 300),
          why: String(q.why || '').slice(0, 200),
          options: Array.isArray(q.options) ? q.options.slice(0, 4).map(o => String(o).slice(0, 80)) : [],
        })).filter(q => q.question);

        if (questions.length) {
          await goalQueries.setClarify(goalId, questions);
          await goalEventQueries.add({
            goal_id: goalId, kind: 'clarify_needed',
            message: `계획을 세우려면 결정이 필요합니다 — 질문 ${questions.length}개`,
            payload: { questions },
          });
          return { ok: true, kind: 'clarify', questions };
        }
      }

      errors = validatePlan(parsed, ctx, capacity, goal);
      if (errors.length === 0) break;
    }

    if (!parsed || (errors && errors.length)) {
      await goalQueries.setStatus(goalId, 'paused', '계획 검증 실패');
      await goalEventQueries.add({
        goal_id: goalId, kind: 'plan_rejected',
        message: `계획이 검증 규칙을 통과하지 못했습니다 (${errors?.length || 0}건)`,
        payload: { errors },
      });
      return { ok: false, kind: 'error', errors: errors || ['계획을 생성하지 못했습니다.'] };
    }

    const { planId, version } = await planQueries.createFull({
      goal_id: goalId,
      rationale: parsed.rationale,
      risk_notes: parsed.risk_notes,
      scope_cut: parsed.scope_cut,
      planner_provider: 'claude',
      planner_model: PLANNER_MODEL,
      workstreams: parsed.workstreams || [],
      milestones: parsed.milestones || [],
      items: parsed.items || [],
    });

    await goalQueries.setStatus(goalId, 'plan_review');
    await goalEventQueries.add({
      goal_id: goalId, kind: 'plan_ready',
      message: `계획서 v${version} 준비됨 — 항목 ${(parsed.items || []).length}개, 승인 대기`,
      payload: { planId, version, itemCount: (parsed.items || []).length },
    });

    return { ok: true, kind: 'plan', planId, version, itemCount: (parsed.items || []).length };
  } catch (err) {
    await goalQueries.setStatus(goalId, 'paused', `계획 생성 오류: ${err.message}`.slice(0, 300));
    await goalEventQueries.add({
      goal_id: goalId, kind: 'plan_error',
      message: `계획 생성 실패 — ${err.message}`.slice(0, 500),
    });
    return { ok: false, kind: 'error', message: err.message };
  }
}
