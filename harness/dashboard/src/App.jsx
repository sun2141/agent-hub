// src/App.jsx
import { useState, useRef, useEffect } from 'react'
import { useHarness } from './hooks/useHarness'

// ── 상수 ──────────────────────────────────────────────────
const PHASE = {
  pending:    { icon: '○', label: '대기',     color: '#585870' },
  planning:   { icon: '◈', label: 'Plan',    color: '#a78bfa' },
  building:   { icon: '◆', label: 'Build',   color: '#60a5fa' },
  evaluating: { icon: '◉', label: 'Eval',    color: '#fb923c' },
  done:       { icon: '●', label: '완료',     color: '#3dd68c' },
  failed:     { icon: '✕', label: '실패',     color: '#f87171' },
  paused:     { icon: '▸', label: '재개대기', color: '#f59e0b' },
}

const INFRA_IDS = ['agent-hub']

// 브라우저 locale + 시간대 기반 상대 시간
// SQLite는 UTC 기준 "2026-04-08 01:23:45" 형식으로 저장 → 'Z' 추가로 UTC 명시 파싱
const rtf = new Intl.RelativeTimeFormat(navigator.language || 'ko', { numeric: 'auto' })

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const utcStr = dateStr.endsWith('Z') ? dateStr : dateStr.replace(' ', 'T') + 'Z'
  const diffSec = (new Date(utcStr).getTime() - Date.now()) / 1000 // 음수
  const abs = Math.abs(diffSec)
  if (abs < 60)    return rtf.format(Math.round(diffSec), 'second')
  if (abs < 3600)  return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  return rtf.format(Math.round(diffSec / 86400), 'day')
}

// ── 상태바 ────────────────────────────────────────────────
function StatusBar({ status, connected, onRefresh }) {
  const running = status?.running || []
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '12px 16px', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: connected ? 'var(--green)' : 'var(--text3)',
          boxShadow: connected ? '0 0 6px var(--green)' : 'none',
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.3px' }}>Agent Harness</span>
        {running.length > 0 && (
          <span style={{
            fontSize: 11, padding: '2px 7px', borderRadius: 20,
            background: 'rgba(107,94,248,0.2)', color: 'var(--accent2)', fontWeight: 500,
          }}>{running.length}개 실행 중</span>
        )}
      </div>
      <button onClick={onRefresh} style={{
        background: 'none', border: 'none', color: 'var(--text3)', fontSize: 16, padding: 4,
      }}>↻</button>
    </div>
  )
}

// ── 프로젝트 카드 ─────────────────────────────────────────
function ProjectCard({ project, tasks, running, onClick }) {
  const projectTasks = tasks.filter(t => t.project_id === project.id)
  const lastTask = [...projectTasks].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]

  const activeRun = running?.find(r =>
    projectTasks.some(t => t.id === r.taskId)
  )

  const phase = activeRun
    ? PHASE[activeRun.phase]
    : (lastTask ? PHASE[lastTask.status] : null)
  const isInfra = INFRA_IDS.includes(project.id)

  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px', background: 'var(--bg2)',
      border: '1px solid var(--border)', borderRadius: 12,
      textAlign: 'left', width: '100%',
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10, flexShrink: 0,
        background: isInfra ? 'rgba(90,90,120,0.3)' : 'rgba(107,94,248,0.15)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
        border: '1px solid ' + (isInfra ? 'rgba(90,90,120,0.4)' : 'rgba(107,94,248,0.3)'),
      }}>
        {isInfra ? '⚙' : project.name[0]}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{project.name}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>
          {project.stack || project.description || ''}
          {lastTask && !activeRun && (
            <span style={{ marginLeft: 6 }}>{timeAgo(lastTask.created_at)}</span>
          )}
        </div>
      </div>

      {phase && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '3px 9px', borderRadius: 20, flexShrink: 0,
          background: phase.color + '18', border: '1px solid ' + phase.color + '40',
        }}>
          <span style={{ fontSize: 10, color: phase.color }}>{phase.icon}</span>
          <span style={{ fontSize: 11, color: phase.color, fontWeight: 500 }}>{phase.label}</span>
          {activeRun && <span style={{ fontSize: 11, color: phase.color }}>R{activeRun.round}</span>}
        </div>
      )}

      <span style={{ color: 'var(--text3)', fontSize: 14, flexShrink: 0 }}>›</span>
    </button>
  )
}

// ── 프로젝트 상세 ─────────────────────────────────────────
function ProjectDetail({ project, tasks, status, wsEvents, onRun, onStop, onResume, onBack }) {
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [tab, setTab] = useState('tasks')
  const logRef = useRef(null)

  const projectTasks = [...tasks.filter(t => t.project_id === project.id)]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  const activeRuns = (status?.running || []).filter(r =>
    projectTasks.some(t => t.id === r.taskId)
  )
  const activeRun = activeRuns[0] || null
  const isRunning = activeRun !== null
  const pausedTask = projectTasks.find(t => t.status === 'paused')

  const projectTaskIds = new Set(projectTasks.map(t => t.id))
  const logs = wsEvents.filter(e =>
    e.taskId && projectTaskIds.has(e.taskId) &&
    ['agent:text', 'agent:tool', 'phase:start', 'phase:complete',
     'task:complete', 'task:failed', 'task:paused', 'task:created'].includes(e.type)
  )

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  const handleRun = async () => {
    if (!prompt.trim() || sending || isRunning) return
    setSending(true)
    try {
      await onRun(project.id, prompt.trim())
      setPrompt('')
      setTab('logs')
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <button onClick={onBack} style={{
          background: 'none', border: 'none', color: 'var(--text3)', fontSize: 22, lineHeight: 1, padding: 0,
        }}>‹</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{project.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>{project.stack}</div>
        </div>

        {isRunning && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)', animation: 'pulse 1.5s infinite' }} />
            <span style={{ fontSize: 12, color: 'var(--blue)' }}>
              {PHASE[activeRun.phase]?.label} R{activeRun.round}
            </span>
            <button onClick={() => onStop(activeRun.taskId)} style={{
              background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.3)',
              color: 'var(--red)', borderRadius: 8, padding: '4px 10px', fontSize: 12,
            }}>중지</button>
          </div>
        )}

        {!isRunning && pausedTask && (
          <button onClick={() => onResume(pausedTask.id)} style={{
            background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)',
            color: 'var(--orange)', borderRadius: 8, padding: '4px 10px', fontSize: 12,
          }}>재개</button>
        )}
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 16px', flexShrink: 0 }}>
        {[['tasks', '작업 이력'], ['logs', '실시간 로그']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            background: 'none', border: 'none', padding: '10px 12px', fontSize: 13,
            color: tab === key ? 'var(--text)' : 'var(--text3)',
            borderBottom: tab === key ? '2px solid var(--accent)' : '2px solid transparent',
            fontWeight: tab === key ? 600 : 400,
          }}>{label}</button>
        ))}
        {logs.length > 0 && tab !== 'logs' && (
          <span style={{
            alignSelf: 'center', marginLeft: 4, fontSize: 10, padding: '1px 6px', borderRadius: 10,
            background: 'rgba(107,94,248,0.2)', color: 'var(--accent2)',
          }}>{logs.length}</span>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <div style={{
          position: 'absolute', inset: 0, overflowY: 'auto',
          padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8,
          visibility: tab === 'tasks' ? 'visible' : 'hidden',
        }}>
          {projectTasks.length === 0 ? (
            <div style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
              아직 작업이 없습니다<br />
              <span style={{ fontSize: 12, marginTop: 6, display: 'block' }}>아래 입력창에 작업을 입력하고 실행하세요</span>
            </div>
          ) : projectTasks.map(t => {
            const p = PHASE[t.status] || PHASE.pending
            return (
              <div key={t.id} style={{
                padding: '10px 12px', background: 'var(--bg3)',
                borderRadius: 10, border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: p.color }}>{p.icon}</span>
                  <span style={{ fontSize: 12, color: p.color, fontWeight: 500 }}>{p.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 'auto' }}>
                    {timeAgo(t.created_at)}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.4 }}>{t.prompt}</div>
                {t.round > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                    {t.round}/{t.max_rounds} 라운드
                  </div>
                )}
                <TaskReport task={t} />
              </div>
            )
          })}
        </div>

        <div ref={logRef} style={{
          position: 'absolute', inset: 0, overflowY: 'auto',
          padding: '12px 16px', fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.7,
          visibility: tab === 'logs' ? 'visible' : 'hidden',
        }}>
          {logs.length === 0 ? (
            <div style={{ color: 'var(--text3)', marginTop: 40, textAlign: 'center', fontFamily: 'var(--font)', fontSize: 13 }}>
              {isRunning ? '로그 수신 중...' : '실시간 로그가 여기에 표시됩니다'}
            </div>
          ) : logs.map((e, i) => {
            const p = PHASE[e.phase] || {}
            let text = '', color = 'var(--text2)'
            if (e.type === 'task:created')   { text = `▶ 작업 시작`;                       color = 'var(--accent2)' }
            else if (e.type === 'phase:start')    { text = `\n── ${p.label||e.phase} R${e.round} ──`; color = p.color||'var(--text3)' }
            else if (e.type === 'phase:complete') { text = `✓ ${p.label||e.phase} 완료`;    color = 'var(--green)' }
            else if (e.type === 'agent:tool')     { text = `  [${e.tool}]`;                 color = 'var(--text3)' }
            else if (e.type === 'agent:text')     { text = `  ${(e.content||'').slice(0,300)}`; color = 'var(--text2)' }
            else if (e.type === 'task:complete')  { text = `\n✅ 완료 — ${e.round} 라운드`; color = 'var(--green)' }
            else if (e.type === 'task:failed')    { text = `\n❌ 실패: ${e.error||''}`;     color = 'var(--red)' }
            else if (e.type === 'task:paused')    { text = `\n⏸ 일시정지: ${e.reason||''}`; color = 'var(--orange)' }
            return text ? (
              <div key={i} style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{text}</div>
            ) : null
          })}
        </div>
      </div>

      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0 }}>
        {isRunning && (
          <div style={{ fontSize: 11, color: 'var(--blue)', marginBottom: 8, textAlign: 'center' }}>
            작업 실행 중에는 새 작업을 시작할 수 없습니다
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            id={`prompt-${project.id}`}
            name={`prompt-${project.id}`}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRun() } }}
            placeholder={isRunning ? '실행 중...' : '작업 지시 입력 (Enter 실행, Shift+Enter 줄바꿈)'}
            disabled={isRunning}
            rows={2}
            style={{
              flex: 1, background: isRunning ? 'var(--bg)' : 'var(--bg3)',
              border: '1px solid var(--border)', borderRadius: 10,
              padding: '10px 12px', color: 'var(--text)',
              fontSize: 13, resize: 'none', outline: 'none',
              opacity: isRunning ? 0.4 : 1,
            }}
          />
          <button
            onClick={handleRun}
            disabled={!prompt.trim() || sending || isRunning}
            style={{
              background: (!prompt.trim() || sending || isRunning) ? 'rgba(107,94,248,0.1)' : 'var(--accent)',
              border: '1px solid ' + ((!prompt.trim() || sending || isRunning) ? 'var(--border)' : 'transparent'),
              borderRadius: 10, padding: '0 18px', color: 'white', fontSize: 20,
              opacity: (!prompt.trim() || sending || isRunning) ? 0.3 : 1, transition: 'all 0.15s',
            }}
          >{sending ? '…' : '↑'}</button>
        </div>
      </div>
    </div>
  )
}

// ── 작업 이력 ─────────────────────────────────────────────
function TaskHistory({ tasks, projects }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {tasks.length === 0 ? (
        <div style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', marginTop: 60 }}>작업 이력이 없습니다</div>
      ) : tasks.map(t => {
        const p = PHASE[t.status] || PHASE.pending
        const proj = projects.find(pr => pr.id === t.project_id)
        return (
          <div key={t.id} style={{ padding: '11px 13px', background: 'var(--bg2)', borderRadius: 11, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: 12, color: p.color }}>{p.icon}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: p.color }}>{p.label}</span>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{proj?.name || t.project_id}</span>
              <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 'auto' }}>{timeAgo(t.created_at)}</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.4 }}>
              {t.prompt?.slice(0, 120)}{t.prompt?.length > 120 ? '…' : ''}
            </div>
            {t.round > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{t.round}/{t.max_rounds} 라운드</div>
            )}
            <TaskReport task={t} />
          </div>
        )
      })}
    </div>
  )
}

// ── 프로젝트 추가 폼 ──────────────────────────────────────
function AddProjectForm({ onAdd, onCancel }) {
  const [form, setForm] = useState({ name: '', path: '', stack: '', description: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('프로젝트 이름은 필수입니다'); return }
    if (!form.path.trim()) { setError('경로는 필수입니다'); return }
    setError('')
    setSaving(true)
    try {
      const result = await onAdd({
        name: form.name.trim(),
        path: form.path.trim(),
        stack: form.stack.trim() || undefined,
        description: form.description.trim() || undefined,
      })
      if (result?.error) { setError(result.error) }
      else { onCancel() }
    } finally {
      setSaving(false)
    }
  }

  const fieldStyle = {
    width: '100%', background: 'var(--bg3)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '9px 11px', color: 'var(--text)',
    fontSize: 13, outline: 'none', boxSizing: 'border-box',
  }
  const labelStyle = { fontSize: 11, color: 'var(--text3)', fontWeight: 600, marginBottom: 4, display: 'block' }

  return (
    <form onSubmit={handleSubmit} style={{
      margin: '8px 0 16px', padding: '14px', background: 'var(--bg2)',
      border: '1px solid var(--border)', borderRadius: 12,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div>
        <label style={labelStyle}>이름 *</label>
        <input value={form.name} onChange={set('name')} placeholder="My Project" style={fieldStyle} />
      </div>
      <div>
        <label style={labelStyle}>경로 *</label>
        <input value={form.path} onChange={set('path')} placeholder="/Users/…/project" style={fieldStyle} />
      </div>
      <div>
        <label style={labelStyle}>스택</label>
        <input value={form.stack} onChange={set('stack')} placeholder="Node.js, React, …" style={fieldStyle} />
      </div>
      <div>
        <label style={labelStyle}>설명</label>
        <input value={form.description} onChange={set('description')} placeholder="한 줄 설명" style={fieldStyle} />
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={saving} style={{
          flex: 1, background: 'var(--accent)', border: 'none', borderRadius: 8,
          padding: '9px', color: 'white', fontSize: 13, fontWeight: 600,
          opacity: saving ? 0.5 : 1,
        }}>{saving ? '저장 중…' : '추가'}</button>
        <button type="button" onClick={onCancel} style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 8,
          padding: '9px 14px', color: 'var(--text3)', fontSize: 13,
        }}>취소</button>
      </div>
    </form>
  )
}

// ── 리포트 섹션 ───────────────────────────────────────────
function TaskReport({ task }) {
  if (!['done', 'failed'].includes(task.status)) return null

  let evalResult = null
  if (task.eval_result) {
    try { evalResult = JSON.parse(task.eval_result) } catch { evalResult = { raw: task.eval_result } }
  }

  const passed = evalResult?.passed ?? evalResult?.success ?? evalResult?.result === 'pass'
  const hasPlan = task.plan && task.plan.trim()

  return (
    <div style={{
      marginTop: 8, padding: '12px', background: 'var(--bg)',
      border: '1px solid var(--border)', borderRadius: 10,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', letterSpacing: '0.08em', marginBottom: 8, textTransform: 'uppercase' }}>
        리포트
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 12, padding: '3px 9px', borderRadius: 20, fontWeight: 600,
          background: task.status === 'done' ? 'rgba(61,214,140,0.15)' : 'rgba(248,113,113,0.15)',
          color: task.status === 'done' ? 'var(--green)' : 'var(--red)',
          border: '1px solid ' + (task.status === 'done' ? 'rgba(61,214,140,0.4)' : 'rgba(248,113,113,0.4)'),
        }}>{task.status === 'done' ? '완료' : '실패'}</span>

        {task.round > 0 && (
          <span style={{
            fontSize: 12, padding: '3px 9px', borderRadius: 20,
            background: 'rgba(107,94,248,0.12)', color: 'var(--accent2)',
            border: '1px solid rgba(107,94,248,0.25)',
          }}>{task.round}/{task.max_rounds} 라운드</span>
        )}

        {evalResult && (
          <span style={{
            fontSize: 12, padding: '3px 9px', borderRadius: 20, fontWeight: 600,
            background: passed ? 'rgba(61,214,140,0.12)' : 'rgba(248,113,113,0.12)',
            color: passed ? 'var(--green)' : 'var(--red)',
            border: '1px solid ' + (passed ? 'rgba(61,214,140,0.3)' : 'rgba(248,113,113,0.3)'),
          }}>Eval: {passed ? '합격' : '불합격'}</span>
        )}

        {evalResult?.score !== undefined && (
          <span style={{
            fontSize: 12, padding: '3px 9px', borderRadius: 20, fontWeight: 700,
            background: evalResult.score >= 70 ? 'rgba(61,214,140,0.12)' : evalResult.score >= 40 ? 'rgba(245,158,11,0.12)' : 'rgba(248,113,113,0.12)',
            color: evalResult.score >= 70 ? 'var(--green)' : evalResult.score >= 40 ? 'var(--orange)' : 'var(--red)',
            border: '1px solid ' + (evalResult.score >= 70 ? 'rgba(61,214,140,0.3)' : evalResult.score >= 40 ? 'rgba(245,158,11,0.3)' : 'rgba(248,113,113,0.3)'),
          }}>{evalResult.score}/100</span>
        )}
      </div>

      {evalResult?.summary && (
        <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5, marginBottom: 6 }}>
          <span style={{ color: 'var(--text3)' }}>Eval 요약: </span>{evalResult.summary}
        </div>
      )}

      {hasPlan && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ fontSize: 12, color: 'var(--text3)', cursor: 'pointer', userSelect: 'none' }}>플랜 보기</summary>
          <div style={{
            marginTop: 6, fontSize: 11, color: 'var(--text2)', lineHeight: 1.6,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontFamily: 'var(--mono)', background: 'var(--bg3)',
            padding: '8px', borderRadius: 7, maxHeight: 200, overflowY: 'auto',
          }}>{task.plan.slice(0, 1000)}{task.plan.length > 1000 ? '\n…' : ''}</div>
        </details>
      )}

      {task.error && (
        <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6, wordBreak: 'break-word' }}>
          오류: {task.error}
        </div>
      )}
    </div>
  )
}

// ── 메인 ─────────────────────────────────────────────────
export default function App() {
  const { projects, tasks, status, connected, wsEvents, runTask, stopTask, resumeTask, addProject, refresh } = useHarness()
  const [view, setView]         = useState('list')
  const [selected, setSelected] = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)

  const productProjects = projects.filter(p => !INFRA_IDS.includes(p.id))
  const infraProjects   = projects.filter(p => INFRA_IDS.includes(p.id))
  const running = status?.running || []

  const handleRun = async (projectId, prompt) => {
    const result = await runTask(projectId, prompt)
    if (result?.taskId) setTimeout(refresh, 500)
    return result
  }

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto', background: 'var(--bg)' }}>
      <StatusBar status={status} connected={connected} onRefresh={refresh} />

      {view === 'detail' && selected ? (
        <ProjectDetail
          project={selected} tasks={tasks} status={status} wsEvents={wsEvents}
          onRun={handleRun}
          onStop={async id => { await stopTask(id); refresh() }}
          onResume={async id => { await resumeTask(id); refresh() }}
          onBack={() => setView('list')}
        />
      ) : view === 'history' ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <button onClick={() => setView('list')} style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: 22 }}>‹</button>
            <span style={{ fontSize: 15, fontWeight: 700 }}>전체 작업 이력</span>
          </div>
          <TaskHistory tasks={tasks} projects={projects} />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {running.length > 0 && (
            <div style={{
              padding: '10px 14px', borderRadius: 12, marginBottom: 16,
              background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--blue)', animation: 'pulse 1.5s infinite', flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 13, color: 'var(--blue)' }}>
                {running.map(r => `${PHASE[r.phase]?.label||r.phase} R${r.round}`).join(', ')} 실행 중
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', letterSpacing: '0.08em', textTransform: 'uppercase', flex: 1 }}>프로젝트</div>
            <button onClick={() => setShowAddForm(f => !f)} style={{
              background: showAddForm ? 'rgba(107,94,248,0.2)' : 'none',
              border: '1px solid ' + (showAddForm ? 'rgba(107,94,248,0.4)' : 'var(--border)'),
              borderRadius: 8, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: showAddForm ? 'var(--accent2)' : 'var(--text3)', fontSize: 16, lineHeight: 1,
            }}>{showAddForm ? '×' : '+'}</button>
          </div>
          {showAddForm && (
            <AddProjectForm
              onAdd={addProject}
              onCancel={() => setShowAddForm(false)}
            />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
            {productProjects.map(p => (
              <ProjectCard key={p.id} project={p} tasks={tasks} running={running}
                onClick={() => { setSelected(p); setView('detail') }} />
            ))}
            {productProjects.length === 0 && !showAddForm && (
              <div style={{ color: 'var(--text3)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>연결 중...</div>
            )}
          </div>

          {infraProjects.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', letterSpacing: '0.08em', marginBottom: 8, textTransform: 'uppercase' }}>인프라</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
                {infraProjects.map(p => (
                  <ProjectCard key={p.id} project={p} tasks={tasks} running={running}
                    onClick={() => { setSelected(p); setView('detail') }} />
                ))}
              </div>
            </>
          )}

          <button onClick={() => setView('history')} style={{
            width: '100%', background: 'none', border: '1px solid var(--border)',
            borderRadius: 10, padding: '11px', color: 'var(--text3)', fontSize: 13,
          }}>전체 작업 이력 →</button>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(96,165,250,0.4); }
          50% { opacity: 0.7; box-shadow: 0 0 0 4px rgba(96,165,250,0); }
        }
        * { -webkit-tap-highlight-color: transparent; }
        button:active { opacity: 0.7; }
      `}</style>
    </div>
  )
}
