// src/telegram/goalMessages.js
// 목표 계층의 텔레그램 표면 — 명령 파싱, 콜백 코덱, 메시지 조립.
//
// 왜 별도 파일인가: 목표 알림은 goalActions(백엔드)가 보내고, 버튼 처리는
// bot.js가 한다. 둘 다 같은 코덱과 문구를 써야 하는데 서로 import하면
// 순환이 된다. 순수 함수만 여기 모아 양쪽이 함께 import한다.
//
// 이 계층이 없던 동안 목표 알림은 전부 "대시보드에서 검토하세요"로 끝났다.
// needs_review와 같은 실패 패턴이었다 — 알림은 오는데 거기서 아무것도 못 한다.

export const GOAL_CALLBACK_PREFIX = 'goal';
export const GOAL_CALLBACK_LIMIT = 64;
export const GOAL_ID_RE = /^goal_[0-9]+_[a-z0-9]+$/;
export const PLAN_ID_RE = /^plan_[0-9]+_[a-z0-9]+$/;
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

// apv/rej는 계획서(plan) id, rpl은 목표(goal) id를 받는다.
export const GOAL_ACTION_ID_RE = { apv: PLAN_ID_RE, rej: PLAN_ID_RE, rpl: GOAL_ID_RE };

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function encodeGoalCallback(action, id) {
  const re = GOAL_ACTION_ID_RE[action];
  if (!re || !re.test(String(id ?? ''))) return null;
  const data = `${GOAL_CALLBACK_PREFIX}|${action}|${id}`;
  if (Buffer.byteLength(data, 'utf8') > GOAL_CALLBACK_LIMIT) return null;
  return data;
}

export function decodeGoalCallback(data) {
  const parts = String(data ?? '').split('|');
  if (parts.length !== 3 || parts[0] !== GOAL_CALLBACK_PREFIX) return null;
  const [, action, id] = parts;
  const re = GOAL_ACTION_ID_RE[action];
  if (!re || !re.test(id)) return null;
  return { action, id };
}

// ── 명령 파싱 ────────────────────────────────────────────────
// 폰에서 치는 걸 전제로 한다. 줄바꿈 형식이 기본이고, 한 줄로 쓸 땐 | 로 나눈다.
//
//   /goal palmoni
//   로그인 이탈 줄이기
//   완료: 소셜 로그인 3종 복귀 동작 + e2e 통과
//   기한: 2026-09-30
//
//   /goal palmoni | 로그인 이탈 줄이기 | 소셜 3종 복귀 동작 | 2026-09-30
//
// 완료 조건은 선택이다. 없으면 제목을 그대로 쓰고, 계획 생성기가 모호하다고
// 판단하면 알아서 되묻는다(clarify). 입력 문턱을 낮추는 게 이 기능의 요점이라
// 필수 필드를 늘리지 않는다.
export const GOAL_OUTCOME_TAGS = ['완료', '완료조건', '완료 조건', 'outcome'];
export const GOAL_DUE_TAGS = ['기한', '마감', 'due'];
export const GOAL_RESEARCH_WORDS = ['조사', 'research'];

export function parseGoalCommand(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: '내용이 비어 있습니다.' };

  let projectId = null, title = null, outcome = null, dueDate = null, kind = 'build';

  if (!text.includes('\n') && text.includes('|')) {
    const parts = text.split('|').map(s => s.trim());
    projectId = parts[0] || null;
    title = parts[1] || null;
    outcome = parts[2] || null;
    dueDate = parts[3] || null;
  } else {
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    projectId = lines.shift() || null;
    for (const line of lines) {
      const tag = line.match(/^([^:：]{1,12})\s*[:：]\s*(.*)$/);
      const key = tag ? tag[1].trim().toLowerCase() : null;
      const val = tag ? tag[2].trim() : null;

      if (key && GOAL_OUTCOME_TAGS.includes(key) && val) { outcome = val; continue; }
      if (key && GOAL_DUE_TAGS.includes(key) && val)     { dueDate = val; continue; }
      if (GOAL_RESEARCH_WORDS.includes(line.toLowerCase())) { kind = 'research'; continue; }
      if (!title) title = line;
    }
  }

  if (!projectId || !PROJECT_ID_RE.test(projectId)) {
    return { ok: false, error: '첫 줄에 프로젝트 id를 적으세요. /projects 로 확인할 수 있습니다.' };
  }
  if (!title) return { ok: false, error: '목표 문장이 없습니다.' };
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return { ok: false, error: `기한은 YYYY-MM-DD 형식이어야 합니다 (받은 값: ${dueDate})` };
  }

  return {
    ok: true,
    projectId,
    title: title.slice(0, 300),
    outcome: (outcome || title).slice(0, 2000),
    outcomeInferred: !outcome,
    dueDate: dueDate || null,
    kind,
  };
}

export function goalUsageMessage() {
  return '📌 <b>목표 만들기</b>\n\n'
    + '<pre>/goal palmoni\n'
    + '로그인 이탈 줄이기\n'
    + '완료: 소셜 3종 복귀 동작 + e2e 통과\n'
    + '기한: 2026-09-30</pre>\n'
    + '첫 줄은 프로젝트 id, 둘째 줄은 목표입니다.\n'
    + '<b>완료</b>·<b>기한</b>은 선택 — 없으면 하네스가 되묻습니다.\n'
    + '코드를 바꾸지 않는 조사 목표는 <code>조사</code> 한 줄을 추가하세요.\n\n'
    + '한 줄로: <code>/goal palmoni | 목표 | 완료조건 | 2026-09-30</code>';
}

// ── 메시지 조립 ──────────────────────────────────────────────
export function buildPlanReadyMessage({ goalTitle, version, itemCount, planId, goalId, dueDate }) {
  let text = `📋 <b>계획서 준비됨</b> v${version}\n`;
  text += `${esc(String(goalTitle || '').slice(0, 80))}\n`;
  text += `항목 ${itemCount}개${dueDate ? ` · 기한 ${esc(dueDate)}` : ''}\n`;
  text += '\n승인하면 항목을 순서대로 자동 실행합니다. (병합은 항상 수동)';

  const row = [];
  const apv = encodeGoalCallback('apv', planId);
  const rpl = encodeGoalCallback('rpl', goalId);
  const rej = encodeGoalCallback('rej', planId);
  if (apv) row.push({ text: '✅ 승인', callback_data: apv });
  if (rpl) row.push({ text: '🔄 다시 계획', callback_data: rpl });
  if (rej) row.push({ text: '🚫 폐기', callback_data: rej });

  if (!row.length) {
    text += '\n\n⚠️ 버튼을 만들 수 없습니다 — 대시보드에서 검토하세요.';
    return { text, reply_markup: undefined };
  }
  return { text, reply_markup: { inline_keyboard: [row] } };
}

export function buildClarifyMessage({ goalId, goalTitle, questions = [] }) {
  let text = '❓ <b>결정이 필요합니다</b>\n';
  text += `${esc(String(goalTitle || '').slice(0, 80))}\n\n`;
  text += '하네스가 판단할 수 없는 것들입니다.\n\n';
  questions.forEach((q, i) => {
    const body = typeof q === 'string' ? q : (q?.question || '');
    text += `${i + 1}. ${esc(String(body).slice(0, 300))}\n`;
  });
  text += `\n답은 번호 순서대로 한 번에 보내세요:\n<pre>/answer ${esc(goalId)}\n`;
  text += questions.map((_, i) => `${i + 1}) 답변`).join('\n');
  text += '</pre>';
  return { text, reply_markup: undefined };
}

// "/answer <goalId>" 뒤의 본문에서 번호별 답을 뽑는다.
// "1) 구독", "2. 광고", "3 - 둘 다" 를 모두 받는다.
export function parseAnswerCommand(raw) {
  const text = String(raw ?? '').trim();
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const goalId = lines.shift() || '';
  if (!GOAL_ID_RE.test(goalId)) {
    return { ok: false, error: '목표 id 형식이 아닙니다. 질문 메시지의 /answer 줄을 그대로 쓰세요.' };
  }
  const byIndex = new Map();
  for (const line of lines) {
    const m = line.match(/^(\d{1,2})\s*[).\-:]?\s*(.+)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const val = m[2].trim();
    if (idx >= 1 && val) byIndex.set(idx, val);
  }
  if (byIndex.size === 0) {
    return { ok: false, error: '답변을 찾지 못했습니다. "1) 내용" 형식으로 줄마다 적으세요.' };
  }
  return { ok: true, goalId, byIndex };
}

// 번호 답변을 질문 텍스트로 키를 바꾼 객체로 만든다(API가 question→answer 맵을 받는다).
export function mapAnswersToQuestions(byIndex, questions = []) {
  const answers = {};
  for (const [idx, val] of byIndex) {
    const q = questions[idx - 1];
    const key = typeof q === 'string' ? q : (q?.question || `질문 ${idx}`);
    answers[String(key).slice(0, 300)] = val;
  }
  return answers;
}

// db/goals.js의 GOAL_STATUS와 같은 집합을 쓴다.
export const GOAL_STATUS_LABEL = {
  draft: '초안', clarify: '답변 대기', planning: '계획 중', plan_review: '승인 대기',
  active: '실행 중', paused: '일시정지', done: '완료', abandoned: '폐기',
};

export function buildGoalListMessage(goals = []) {
  if (!goals.length) {
    return '아직 목표가 없습니다.\n\n' + goalUsageMessage();
  }
  let text = `🎯 <b>목표 ${goals.length}개</b>\n\n`;
  for (const g of goals) {
    const p = g.progress || {};
    const total = p.total ?? 0;
    const finished = p.finished ?? 0;
    text += `<b>${esc(String(g.title || '').slice(0, 60))}</b>\n`;
    text += `${esc(g.project_id || '-')} · ${GOAL_STATUS_LABEL[g.status] || esc(g.status)}`;
    if (total > 0) text += ` · ${finished}/${total}`;
    if (p.blocked) text += ` · 차단 ${p.blocked}`;
    if (g.due_date) text += ` · ~${esc(g.due_date)}`;
    text += `\n<code>${esc(g.id)}</code>\n\n`;
  }
  return text.trimEnd();
}
