// src/components/Goals.jsx
// 목표 화면 — 목표 작성(3필드), 계획서 승인, 진행 타임라인, 인박스.
//
// 화면 설계의 기준 하나: 이 탭이 답해야 하는 질문은 "무슨 일이 있었나"가 아니라
// **"내가 지금 해야 할 게 있나"**다. 그래서 인박스가 목록보다 위에 온다.

import { useState, useEffect, useCallback } from 'react';

const STATUS_LABEL = {
  draft: '초안', clarify: '결정 대기', planning: '계획 생성 중',
  plan_review: '승인 대기', active: '진행 중', paused: '일시정지',
  done: '완료', abandoned: '폐기',
};

const STATUS_COLOR = {
  draft: 'var(--text3)', clarify: 'var(--orange)', planning: 'var(--blue)',
  plan_review: 'var(--orange)', active: 'var(--green)', paused: 'var(--red)',
  done: 'var(--text3)', abandoned: 'var(--text3)',
};

const PACE_ICON = { green: '🟢', yellow: '🟡', red: '🔴', none: '⚪' };

const ITEM_ICON = {
  pending: '·', queued: '⋯', running: '▶', needs_review: '⚠️',
  done: '✓', failed: '✕', blocked: '🚫', skipped: '–',
};

function dday(dueDate) {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T23:59:59Z`);
  const days = Math.ceil((due.getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return null;
  return days >= 0 ? `D-${days}` : `D+${-days}`;
}

// ── 공용 조각 ──────────────────────────────────────────────────
function Chip({ children, color }) {
  return (
    <span style={{
      fontSize: 11, padding: '2px 7px', borderRadius: 999,
      background: 'var(--bg3)', color: color || 'var(--text3)', whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Bar({ done, total }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ height: 5, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--green)', transition: 'width .3s' }} />
    </div>
  );
}

function Btn({ children, onClick, kind = 'ghost', disabled, style }) {
  const bg = kind === 'primary' ? 'var(--accent)'
    : kind === 'danger' ? 'transparent' : 'var(--bg3)';
  const color = kind === 'primary' ? '#fff'
    : kind === 'danger' ? 'var(--red)' : 'var(--text2)';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '9px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600,
        background: bg, color, border: kind === 'danger' ? '1px solid var(--red)' : 'none',
        opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer', ...style,
      }}
    >{children}</button>
  );
}

// ── 새 목표 폼 ─────────────────────────────────────────────────
function NewGoalForm({ projects, onCreate, onCancel }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [title, setTitle]     = useState('');
  const [outcome, setOutcome] = useState('');
  const [due, setDue]         = useState('');
  const [kind, setKind]       = useState('build');
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');

  const input = {
    width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 14,
    background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text)',
    fontFamily: 'inherit', boxSizing: 'border-box',
  };
  const label = { fontSize: 12, color: 'var(--text3)', marginBottom: 5, display: 'block' };

  async function submit() {
    if (!title.trim() || !outcome.trim()) { setErr('제목과 완료 조건은 필수입니다.'); return; }
    setBusy(true); setErr('');
    try {
      await onCreate({ project_id: projectId, title, outcome, due_date: due || null, kind });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 14, background: 'var(--bg2)', borderRadius: 12, border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>새 목표</div>

      <div style={{ marginBottom: 12 }}>
        <label style={label}>프로젝트</label>
        <select value={projectId} onChange={e => setProjectId(e.target.value)} style={input}>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={label}>목표</label>
        <input
          value={title} onChange={e => setTitle(e.target.value)} style={input}
          placeholder="예: 결제 도입으로 유료 전환 경로 만들기"
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={label}>완료 조건 — 무엇이 되면 끝인지</label>
        <textarea
          value={outcome} onChange={e => setOutcome(e.target.value)}
          rows={4} style={{ ...input, resize: 'vertical' }}
          placeholder={'검증 가능하게 적을수록 결과가 좋아집니다.\n예: Stripe 구독 단일 플랜 결제가 되고, 결제 완료 시 profiles.plan이 pro로 바뀐다'}
        />
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 5, lineHeight: 1.5 }}>
          이 문장이 그대로 채점 기준이 됩니다. "개선한다" 같은 표현은 계획 단계에서 거절됩니다.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={label}>기한 (선택)</label>
          <input type="date" value={due} onChange={e => setDue(e.target.value)} style={input} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={label}>종류</label>
          <select value={kind} onChange={e => setKind(e.target.value)} style={input}>
            <option value="build">build — 코드 변경·PR</option>
            <option value="research">research — 조사·리포트</option>
          </select>
        </div>
      </div>

      {kind === 'research' && (
        <div style={{
          fontSize: 11, color: 'var(--text2)', background: 'var(--bg3)',
          padding: 10, borderRadius: 8, marginBottom: 12, lineHeight: 1.6,
        }}>
          코드를 건드리지 않고 리포트 파일 하나만 만듭니다. 무엇을 할지 아직 정하지
          못했을 때, 결정에 필요한 재료를 먼저 모으는 용도입니다.
        </div>
      )}

      {err && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <Btn kind="primary" onClick={submit} disabled={busy} style={{ flex: 1 }}>
          {busy ? '계획 생성 중...' : '목표 만들기'}
        </Btn>
        <Btn onClick={onCancel} disabled={busy}>취소</Btn>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8, lineHeight: 1.5 }}>
        저장하면 하네스가 계획서를 만듭니다. 수십 초 걸리고, 준비되면 텔레그램으로 알립니다.
      </div>
    </div>
  );
}

// ── 목표 카드 ──────────────────────────────────────────────────
function GoalCard({ goal, onOpen }) {
  const p = goal.progress || { finished: 0, total: 0, blocked: 0 };
  const pace = goal.pace;
  const d = dday(goal.due_date);

  return (
    <div
      onClick={() => onOpen(goal.id)}
      style={{
        padding: 14, background: 'var(--bg2)', borderRadius: 12,
        border: '1px solid var(--border)', marginBottom: 10, cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1, fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>{goal.title}</div>
        {pace && <span style={{ fontSize: 14 }}>{PACE_ICON[pace.signal?.level] || ''}</span>}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <Chip>{goal.project_name || goal.project_id}</Chip>
        <Chip color={STATUS_COLOR[goal.status]}>{STATUS_LABEL[goal.status] || goal.status}</Chip>
        {goal.kind === 'research' && <Chip color="var(--blue)">조사</Chip>}
        {d && <Chip color={d.startsWith('D+') ? 'var(--red)' : undefined}>{d}</Chip>}
        {p.blocked > 0 && <Chip color="var(--red)">차단 {p.blocked}</Chip>}
      </div>

      {p.total > 0 && (
        <>
          <Bar done={p.finished} total={p.total} />
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
            {p.finished}/{p.total} 완료
            {pace?.signal?.level === 'red' && ' · 기한 안에 어렵습니다'}
          </div>
        </>
      )}
    </div>
  );
}

// ── 계획서 승인 ────────────────────────────────────────────────
function PlanReview({ plan, onApprove, onReplan, onReject, busy }) {
  const [comment, setComment] = useState('');
  const [showComment, setShowComment] = useState(false);
  if (!plan) return null;

  const { plan: meta, workstreams, milestones, items } = plan;
  const msById = Object.fromEntries(milestones.map(m => [m.id, m]));
  const wsById = Object.fromEntries(workstreams.map(w => [w.id, w]));
  const totalRuns = items.reduce((s, i) => s + (i.est_runs || 1), 0);

  return (
    <div>
      <div style={{
        padding: 12, background: 'var(--bg3)', borderRadius: 10, marginBottom: 12,
        fontSize: 12, color: 'var(--text2)', lineHeight: 1.6,
      }}>
        <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
          계획서 v{meta.version} · 항목 {items.length}개 · 예상 실행 {totalRuns}회
        </div>
        {meta.rationale && <div style={{ marginBottom: 6 }}>{meta.rationale}</div>}
        {meta.risk_notes && (
          <div style={{ color: 'var(--orange)' }}>⚠ {meta.risk_notes}</div>
        )}
      </div>

      {milestones.map(ms => {
        const own = items.filter(i => i.milestone_id === ms.id);
        return (
          <div key={ms.id} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
              {ms.title}{ms.target_date ? ` · ${ms.target_date}` : ''}
            </div>
            {ms.exit_criteria && (
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
                통과 조건: {ms.exit_criteria}
              </div>
            )}
            {own.map(it => (
              <div key={it.id} style={{
                padding: 10, background: 'var(--bg2)', borderRadius: 8,
                border: '1px solid var(--border)', marginBottom: 6,
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{it.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.5 }}>
                  {it.acceptance_criteria}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  {it.workstream_id && wsById[it.workstream_id] &&
                    <Chip>{wsById[it.workstream_id].name}</Chip>}
                  {it.verify_cmd && <Chip color="var(--blue)">{it.verify_cmd}</Chip>}
                  <Chip>{it.est_runs || 1}회</Chip>
                </div>
              </div>
            ))}
          </div>
        );
      })}

      {/* 마일스톤에 안 붙은 항목도 빠뜨리지 않는다 */}
      {items.filter(i => !i.milestone_id || !msById[i.milestone_id]).map(it => (
        <div key={it.id} style={{
          padding: 10, background: 'var(--bg2)', borderRadius: 8,
          border: '1px solid var(--border)', marginBottom: 6,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{it.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text2)' }}>{it.acceptance_criteria}</div>
        </div>
      ))}

      {Array.isArray(meta.scope_cut) && meta.scope_cut.length > 0 && (
        <div style={{
          padding: 10, background: 'var(--bg3)', borderRadius: 8, marginBottom: 12,
          fontSize: 11, color: 'var(--text2)', lineHeight: 1.6,
        }}>
          <b>기한이 빠듯할 때 뺄 후보</b><br />
          {meta.scope_cut.join(' · ')}
        </div>
      )}

      {showComment && (
        <textarea
          value={comment} onChange={e => setComment(e.target.value)} rows={3}
          placeholder="무엇을 바꿔야 하는지 적으면 그 내용으로 계획을 다시 만듭니다."
          style={{
            width: '100%', padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 8,
            background: 'var(--bg2)', border: '1px solid var(--border)',
            color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box',
          }}
        />
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn kind="primary" onClick={onApprove} disabled={busy} style={{ flex: 1 }}>
          ✅ 승인하고 자동 실행
        </Btn>
        {showComment
          ? <Btn onClick={() => onReplan(comment)} disabled={busy || !comment.trim()}>다시 만들기</Btn>
          : <Btn onClick={() => setShowComment(true)} disabled={busy}>✏️ 수정 요청</Btn>}
        <Btn kind="danger" onClick={onReject} disabled={busy}>폐기</Btn>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8, lineHeight: 1.5 }}>
        승인하면 항목을 순서대로 자동 실행합니다. PR 병합은 계속 수동입니다.
      </div>
    </div>
  );
}

// ── 되물음 답변 ────────────────────────────────────────────────
function ClarifyForm({ questions, onSubmit, busy }) {
  const [answers, setAnswers] = useState({});
  const filled = questions.every(q => (answers[q.question] || '').trim());

  return (
    <div>
      <div style={{
        padding: 12, background: 'var(--bg3)', borderRadius: 10, marginBottom: 12,
        fontSize: 12, color: 'var(--text2)', lineHeight: 1.6,
      }}>
        이 목표는 그대로 계획을 세울 수 없습니다. 아래는 <b>하네스가 판단할 수 없는 것</b>들입니다 —
        답을 주시면 그 내용으로 계획을 만듭니다.
      </div>

      {questions.map((q, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{i + 1}. {q.question}</div>
          {q.why && <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>{q.why}</div>}

          {q.options?.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {q.options.map(o => (
                <button
                  key={o}
                  onClick={() => setAnswers(a => ({ ...a, [q.question]: o }))}
                  style={{
                    padding: '6px 10px', borderRadius: 999, fontSize: 12,
                    background: answers[q.question] === o ? 'var(--accent)' : 'var(--bg3)',
                    color: answers[q.question] === o ? '#fff' : 'var(--text2)',
                    border: 'none', cursor: 'pointer',
                  }}
                >{o}</button>
              ))}
            </div>
          )}

          <input
            value={answers[q.question] || ''}
            onChange={e => setAnswers(a => ({ ...a, [q.question]: e.target.value }))}
            placeholder="직접 입력"
            style={{
              width: '100%', padding: '9px 11px', borderRadius: 8, fontSize: 13,
              background: 'var(--bg2)', border: '1px solid var(--border)',
              color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        </div>
      ))}

      <Btn kind="primary" onClick={() => onSubmit(answers)} disabled={busy || !filled} style={{ width: '100%' }}>
        {busy ? '계획 다시 만드는 중...' : '답변 저장하고 계획 만들기'}
      </Btn>
    </div>
  );
}

// ── 목표 상세 ──────────────────────────────────────────────────
function GoalDetail({ goalId, api, onBack, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  const load = useCallback(async () => {
    try { setData(await api.getGoal(goalId)); setErr(''); }
    catch (e) { setErr(e.message); }
  }, [api, goalId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function act(fn) {
    setBusy(true); setErr('');
    try { await fn(); await load(); onChanged?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (!data) return <div style={{ padding: 20, color: 'var(--text3)', fontSize: 13 }}>불러오는 중...</div>;

  const d = dday(data.due_date);
  const proposed = data.plan?.plan?.status === 'proposed' ? data.plan : null;

  return (
    <div>
      <button
        onClick={onBack}
        style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: 13, padding: '0 0 12px', cursor: 'pointer' }}
      >← 목표 목록</button>

      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, lineHeight: 1.4 }}>{data.title}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <Chip>{data.project_name}</Chip>
        <Chip color={STATUS_COLOR[data.status]}>{STATUS_LABEL[data.status] || data.status}</Chip>
        {data.kind === 'research' && <Chip color="var(--blue)">조사</Chip>}
        {d && <Chip color={d.startsWith('D+') ? 'var(--red)' : undefined}>{d}</Chip>}
      </div>

      <div style={{
        fontSize: 12, color: 'var(--text2)', background: 'var(--bg2)', padding: 11,
        borderRadius: 8, marginBottom: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap',
      }}>{data.outcome}</div>

      {data.paceText && data.pace?.signal?.level !== 'none' && (
        <div style={{
          fontSize: 11, color: 'var(--text3)', marginBottom: 12,
          padding: '8px 11px', background: 'var(--bg3)', borderRadius: 8, lineHeight: 1.5,
        }}>
          {PACE_ICON[data.pace.signal.level]} {data.paceText}
        </div>
      )}

      {data.paused_reason && (
        <div style={{
          fontSize: 12, color: 'var(--red)', background: '#f8717118',
          padding: 11, borderRadius: 8, marginBottom: 12, lineHeight: 1.5,
        }}>⏸ {data.paused_reason}</div>
      )}

      {err && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>{err}</div>}

      {data.status === 'clarify' && data.clarify_questions?.length > 0 && (
        <ClarifyForm
          questions={data.clarify_questions}
          busy={busy}
          onSubmit={(answers) => act(() => api.answerClarify(goalId, answers))}
        />
      )}

      {data.status === 'planning' && (
        <div style={{ fontSize: 13, color: 'var(--text3)', padding: '16px 0' }}>
          계획을 만들고 있습니다. 수십 초 걸립니다 — 준비되면 텔레그램으로도 알립니다.
        </div>
      )}

      {proposed && (
        <PlanReview
          plan={proposed}
          busy={busy}
          onApprove={() => act(() => api.approvePlan(proposed.plan.id))}
          onReplan={(c) => act(() => api.replan(goalId, c))}
          onReject={() => act(() => api.rejectPlan(proposed.plan.id))}
        />
      )}

      {data.items?.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>항목</div>
          {data.items.map(it => (
            <div key={it.id} style={{
              padding: 10, background: 'var(--bg2)', borderRadius: 8,
              border: '1px solid var(--border)', marginBottom: 6,
            }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 13 }}>{ITEM_ICON[it.status] || '·'}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>{it.title}</div>
                  {it.blocked_reason && (
                    <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, lineHeight: 1.5 }}>
                      {it.blocked_reason}
                    </div>
                  )}
                  {it.pr_url && (
                    <a href={it.pr_url} target="_blank" rel="noreferrer"
                       style={{ fontSize: 11, color: 'var(--accent2)', display: 'inline-block', marginTop: 4 }}>
                      PR 보기 →
                    </a>
                  )}
                </div>
                {(it.status === 'blocked' || it.status === 'failed') && (
                  <Btn onClick={() => act(() => api.setItemStatus(it.id, 'pending'))} disabled={busy}
                       style={{ padding: '5px 9px', fontSize: 11 }}>재시도</Btn>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {data.events?.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>진행 기록</div>
          {data.events.slice(0, 30).map(e => (
            <div key={e.id} style={{
              display: 'flex', gap: 8, fontSize: 11, color: 'var(--text3)',
              padding: '5px 0', borderBottom: '1px solid var(--border)', lineHeight: 1.5,
            }}>
              <span style={{ fontFamily: 'var(--mono)', flexShrink: 0 }}>{(e.created_at || '').slice(5, 16)}</span>
              <span style={{ color: 'var(--text2)' }}>{e.message}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
        {data.status === 'active' && (
          <Btn onClick={() => act(() => api.setGoalStatus(goalId, 'paused', '수동 정지'))} disabled={busy}>
            ⏸ 일시정지
          </Btn>
        )}
        {data.status === 'paused' && (
          <Btn kind="primary" onClick={() => act(() => api.setGoalStatus(goalId, 'active'))} disabled={busy}>
            ▶ 재개
          </Btn>
        )}
        <Btn kind="danger" onClick={() => act(async () => { await api.deleteGoal(goalId); onBack(); })} disabled={busy}>
          삭제
        </Btn>
      </div>
    </div>
  );
}

// ── 인박스 ─────────────────────────────────────────────────────
function Inbox({ inbox, onOpen }) {
  if (!inbox) return null;
  const count = (inbox.items?.length || 0)
    + (inbox.awaitingApproval?.length || 0)
    + (inbox.awaitingAnswers?.length || 0)
    + (inbox.paused?.length || 0);
  if (count === 0) return null;

  const rows = [
    ...(inbox.awaitingAnswers || []).map(g => ({ id: g.id, icon: '❓', text: `결정 필요 — ${g.title}` })),
    ...(inbox.awaitingApproval || []).map(g => ({ id: g.id, icon: '📋', text: `계획 승인 대기 — ${g.title}` })),
    ...(inbox.paused || []).map(g => ({ id: g.id, icon: '⏸', text: `일시정지 — ${g.title}` })),
    ...(inbox.items || []).map(i => ({ id: i.goal_id, icon: '⚠️', text: `${i.title} (${i.status})` })),
  ];

  return (
    <div style={{
      padding: 12, background: '#fb923c18', border: '1px solid var(--orange)',
      borderRadius: 12, marginBottom: 14,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--orange)' }}>
        확인 필요 {count}건
      </div>
      {rows.slice(0, 6).map((r, i) => (
        <div key={i} onClick={() => r.id && onOpen(r.id)}
          style={{ fontSize: 12, color: 'var(--text2)', padding: '4px 0', cursor: r.id ? 'pointer' : 'default', lineHeight: 1.5 }}>
          {r.icon} {r.text}
        </div>
      ))}
    </div>
  );
}

// ── 탭 본체 ────────────────────────────────────────────────────
export default function Goals({ projects, api }) {
  const { goals, inbox, error, refresh } = api;
  const [openId, setOpenId] = useState(null);
  const [showNew, setShowNew] = useState(false);

  if (openId) {
    return (
      <GoalDetail
        goalId={openId} api={api}
        onBack={() => { setOpenId(null); refresh(); }}
        onChanged={refresh}
      />
    );
  }

  const live = goals.filter(g => !['done', 'abandoned'].includes(g.status));
  const past = goals.filter(g => ['done', 'abandoned'].includes(g.status));

  return (
    <div>
      {error && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>{error}</div>}

      <Inbox inbox={inbox} onOpen={setOpenId} />

      {showNew ? (
        <NewGoalForm
          projects={projects}
          onCancel={() => setShowNew(false)}
          onCreate={async (body) => {
            const r = await api.createGoal(body);
            setShowNew(false);
            refresh();
            if (r?.id) setOpenId(r.id);
          }}
        />
      ) : (
        <Btn kind="primary" onClick={() => setShowNew(true)} style={{ width: '100%', marginBottom: 14 }}>
          + 새 목표
        </Btn>
      )}

      {!showNew && live.length === 0 && (
        <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--text3)', fontSize: 13, lineHeight: 1.7 }}>
          진행 중인 목표가 없습니다.<br />
          목표와 완료 조건을 넣으면 하네스가 계획을 만들어 옵니다.
        </div>
      )}

      {live.map(g => <GoalCard key={g.id} goal={g} onOpen={setOpenId} />)}

      {past.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>지난 목표 {past.length}건</div>
          {past.map(g => <GoalCard key={g.id} goal={g} onOpen={setOpenId} />)}
        </div>
      )}
    </div>
  );
}
