// src/App.jsx
import { useState, useRef, useEffect } from 'react'
import { useHarness } from './hooks/useHarness'

// ── 진동 피드백 (iOS Safari 미지원 → try-catch) ──────────
function vibrate(pattern = 10) {
  try { navigator.vibrate?.(pattern) } catch {}
}

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
      <button onClick={() => { vibrate(); onRefresh() }} style={{
        background: 'none', border: 'none', color: 'var(--text3)', fontSize: 20,
        minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 10, WebkitTapHighlightColor: 'transparent',
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
    <button onClick={() => { vibrate(); onClick() }} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '14px 16px', background: 'var(--bg2)',
      border: '1px solid var(--border)', borderRadius: 12,
      textAlign: 'left', width: '100%', minHeight: 64,
      WebkitTapHighlightColor: 'transparent', transition: 'opacity 0.1s, transform 0.1s',
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
function ProjectDetail({ project, tasks, status, wsEvents, onRun, onStop, onResume, onDelete, onBack, fetchTaskLogs }) {
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [tab, setTab] = useState('tasks')
  const [deleteConfirm, setDeleteConfirm] = useState(null) // { taskId, status, prompt }
  const [dbLogs, setDbLogs] = useState([])
  const logRef = useRef(null)
  const autoScrollRef = useRef(true)

  const projectTasks = [...tasks.filter(t => t.project_id === project.id)]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  const activeRuns = (status?.running || []).filter(r =>
    projectTasks.some(t => t.id === r.taskId)
  )
  const activeRun = activeRuns[0] || null
  const isRunning = activeRun !== null
  const pausedTask = projectTasks.find(t => t.status === 'paused')

  // 로그 fetch 대상 taskId: 실행 중인 작업 또는 가장 최근 작업
  const targetTaskId = activeRun?.taskId || projectTasks[0]?.id || null

  // 로그 탭 전환 또는 targetTaskId 변경 시 DB 로그 로드
  useEffect(() => {
    if (tab !== 'logs' || !targetTaskId) return
    fetchTaskLogs(targetTaskId).then(setDbLogs)
  }, [tab, targetTaskId])

  // 실행 중일 때 주기적으로 DB 로그 갱신
  useEffect(() => {
    if (tab !== 'logs' || !targetTaskId || !isRunning) return
    const timer = setInterval(() => {
      fetchTaskLogs(targetTaskId).then(setDbLogs)
    }, 5000)
    return () => clearInterval(timer)
  }, [tab, targetTaskId, isRunning])

  const projectTaskIds = new Set(projectTasks.map(t => t.id))
  const wsLogs = wsEvents.filter(e =>
    e.taskId && projectTaskIds.has(e.taskId) &&
    ['agent:text', 'agent:tool', 'phase:start', 'phase:complete',
     'task:complete', 'task:failed', 'task:paused', 'task:created'].includes(e.type)
  )

  // DB 로그와 WS 이벤트 병합 (중복 제거: WS 이벤트는 ts가 ms 단위, DB 로그는 초 단위이므로
  // DB 로그를 기본으로 하고 WS 이벤트 중 DB에 없는 것(1초 이내 같은 type+content)만 추가)
  const logs = (() => {
    if (dbLogs.length === 0) return wsLogs
    if (wsLogs.length === 0) return dbLogs
    // DB 로그 ts를 초 단위로 버킷화하여 중복 탐지
    const dbBuckets = new Set(dbLogs.map(d => `${d.type}:${Math.floor((d.ts || 0) / 1000)}`))
    const wsOnly = wsLogs.filter(e => !dbBuckets.has(`${e.type}:${Math.floor((e.ts || 0) / 1000)}`))
    return [...dbLogs, ...wsOnly].sort((a, b) => (a.ts || 0) - (b.ts || 0))
  })()

  useEffect(() => {
    if (logRef.current && autoScrollRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  // 스크롤 이벤트: 사용자가 위로 올리면 자동 스크롤 중단
  function handleLogScroll() {
    if (!logRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = logRef.current
    autoScrollRef.current = scrollTop + clientHeight >= scrollHeight - 40
  }

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

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return
    const { taskId } = deleteConfirm
    setDeleteConfirm(null)
    await onDelete(taskId)
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {deleteConfirm && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 100,
          background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0 24px',
        }}>
          <div style={{
            background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16,
            padding: '24px', width: '100%', maxWidth: 360,
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
              작업을 삭제하시겠습니까?
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>
              상태: <span style={{ color: (PHASE[deleteConfirm.status] || PHASE.pending).color, fontWeight: 600 }}>
                {(PHASE[deleteConfirm.status] || PHASE.pending).label}
              </span>
            </div>
            <div style={{
              fontSize: 12, color: 'var(--text2)', lineHeight: 1.5, marginBottom: 16,
              padding: '8px 10px', background: 'var(--bg3)', borderRadius: 8, wordBreak: 'break-word',
            }}>
              {deleteConfirm.prompt?.slice(0, 120)}{deleteConfirm.prompt?.length > 120 ? '…' : ''}
            </div>
            <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 16 }}>
              이 작업과 관련된 모든 로그가 영구 삭제됩니다.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { vibrate(10); handleDeleteConfirm() }}
                style={{
                  flex: 1, background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.4)',
                  color: 'var(--red)', borderRadius: 10, padding: '13px', fontSize: 14, fontWeight: 600,
                  minHeight: 52, WebkitTapHighlightColor: 'transparent',
                }}
              >삭제</button>
              <button
                onClick={() => { vibrate(8); setDeleteConfirm(null) }}
                style={{
                  flex: 1, background: 'none', border: '1px solid var(--border)',
                  color: 'var(--text3)', borderRadius: 10, padding: '13px', fontSize: 14,
                  minHeight: 52, WebkitTapHighlightColor: 'transparent',
                }}
              >취소</button>
            </div>
          </div>
        </div>
      )}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <button onClick={() => { vibrate(); onBack() }} style={{
          background: 'none', border: 'none', color: 'var(--text3)', fontSize: 26, lineHeight: 1,
          minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 10, marginLeft: -8, WebkitTapHighlightColor: 'transparent',
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
            <button onClick={() => { vibrate([10, 30, 10]); onStop(activeRun.taskId) }} style={{
              background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.3)',
              color: 'var(--red)', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600,
              minHeight: 44, WebkitTapHighlightColor: 'transparent',
            }}>중지</button>
          </div>
        )}

        {!isRunning && pausedTask && (
          <button onClick={() => { vibrate(15); onResume(pausedTask.id) }} style={{
            background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)',
            color: 'var(--orange)', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600,
            minHeight: 44, WebkitTapHighlightColor: 'transparent',
          }}>재개</button>
        )}
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 8px', flexShrink: 0 }}>
        {[['tasks', '작업 이력'], ['logs', '실시간 로그']].map(([key, label]) => (
          <button key={key} onClick={() => { vibrate(8); setTab(key) }} style={{
            background: 'none', border: 'none', padding: '12px 16px', fontSize: 14,
            color: tab === key ? 'var(--text)' : 'var(--text3)',
            borderBottom: tab === key ? '2px solid var(--accent)' : '2px solid transparent',
            fontWeight: tab === key ? 600 : 400,
            minHeight: 48, WebkitTapHighlightColor: 'transparent',
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
            const canDelete = ['failed', 'paused', 'building', 'pending', 'planning', 'evaluating'].includes(t.status)
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
                  {canDelete && (
                    <button
                      onClick={() => { vibrate(10); setDeleteConfirm({ taskId: t.id, status: t.status, prompt: t.prompt }) }}
                      style={{
                        background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)',
                        color: 'var(--red)', borderRadius: 6, padding: '3px 9px', fontSize: 11, fontWeight: 500,
                        minHeight: 28, WebkitTapHighlightColor: 'transparent', lineHeight: 1,
                      }}
                    >삭제</button>
                  )}
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

        <div ref={logRef} onScroll={handleLogScroll} style={{
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
              padding: '12px 14px', color: 'var(--text)',
              fontSize: 16, resize: 'none', outline: 'none',
              opacity: isRunning ? 0.4 : 1,
            }}
          />
          <button
            onClick={() => { vibrate(15); handleRun() }}
            disabled={!prompt.trim() || sending || isRunning}
            style={{
              background: (!prompt.trim() || sending || isRunning) ? 'rgba(107,94,248,0.1)' : 'var(--accent)',
              border: '1px solid ' + ((!prompt.trim() || sending || isRunning) ? 'var(--border)' : 'transparent'),
              borderRadius: 10, padding: '0 20px', color: 'white', fontSize: 22,
              minWidth: 52, minHeight: 52,
              opacity: (!prompt.trim() || sending || isRunning) ? 0.3 : 1, transition: 'all 0.15s',
              WebkitTapHighlightColor: 'transparent',
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

// ── 프로젝트 생성 폼 (GitHub 연동 포함) ────────────────────
function AddProjectForm({ onAdd, onCreate, onCancel }) {
  const [mode, setMode] = useState('create') // 'create' | 'add'
  const [form, setForm] = useState({
    name: '', path: '', stack: '', description: '',
    githubRepo: true,
    githubPrivate: 'private',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState(null)

  const set = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm(f => ({ ...f, [key]: val }))
  }

  // 이름 입력 시 경로 자동 야
  const handleNameChange = (e) => {
    const name = e.target.value
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    setForm(f => ({
      ...f,
      name,
      path: slug ? `/Users/sun/${slug}` : '',
    }))
  }

  const handleSubmit = async () => {
    if (!form.name.trim()) { setError('프로젝트 이름은 필수입니다'); return }
    if (!form.path.trim()) { setError('경로는 필수입니다'); return }
    setError('')
    setSaving(true)
    setResult(null)

    try {
      const payload = {
        name: form.name.trim(),
        path: form.path.trim(),
        stack: form.stack.trim() || undefined,
        description: form.description.trim() || undefined,
      }

      let res
      if (mode === 'create') {
        res = await onCreate({
          ...payload,
          githubRepo: form.githubRepo ? 'auto' : false,
          githubPrivate: form.githubPrivate !== 'public',
        })
      } else {
        res = await onAdd(payload)
      }

      if (res?.error) {
        setError(res.error)
      } else if (mode === 'create') {
        setResult(res)
      } else {
        onCancel()
      }
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

  // 성공 화면
  if (result) {
    return (
      <div style={{
        margin: '8px 0 16px', padding: '16px', background: 'var(--bg2)',
        border: '1px solid rgba(61,214,140,0.3)', borderRadius: 12,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)', marginBottom: 10 }}>✅ 프로젝트 생성 완료</div>
        <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.8 }}>
          <div>폴더: <span style={{ color: 'var(--green)' }}>{result.folderCreated ? '✓' : '×'}</span> {result.project?.path}</div>
          <div>git init: <span style={{ color: result.gitInit ? 'var(--green)' : 'var(--red)' }}>{result.gitInit ? '✓' : '×'}</span></div>
          {result.githubRepo && (
            <div>GitHub: <span style={{ color: 'var(--green)' }}>✓</span>{' '}
              <a href={result.githubRepo.url} target="_blank" rel="noreferrer"
                style={{ color: 'var(--accent2)', fontSize: 11 }}>{result.githubRepo.url}</a>
            </div>
          )}
          {result.githubError && (
            <div style={{ color: 'var(--orange)' }}>GitHub 오류: {result.githubError}</div>
          )}
          <div>DB 등록: <span style={{ color: result.dbInserted ? 'var(--green)' : 'var(--red)' }}>{result.dbInserted ? '✓' : '×'}</span></div>
        </div>
        <button onClick={() => { vibrate(10); onCancel() }} style={{
          marginTop: 12, width: '100%', background: 'var(--accent)', border: 'none',
          borderRadius: 8, padding: '13px', color: 'white', fontSize: 14, fontWeight: 600,
          minHeight: 52, WebkitTapHighlightColor: 'transparent',
        }}>닫기</button>
      </div>
    )
  }

  return (
    <div style={{
      margin: '8px 0 16px', padding: '14px', background: 'var(--bg2)',
      border: '1px solid var(--border)', borderRadius: 12,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      {/* 모드 탭 */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
        {[['create', '새 프로젝트 생성'], ['add', '기존 등록']].map(([m, label]) => (
          <button key={m} onClick={() => { vibrate(8); setMode(m) }} style={{
            flex: 1, background: mode === m ? 'rgba(107,94,248,0.2)' : 'none',
            border: '1px solid ' + (mode === m ? 'rgba(107,94,248,0.5)' : 'var(--border)'),
            borderRadius: 8, padding: '10px 6px', color: mode === m ? 'var(--accent2)' : 'var(--text3)',
            fontSize: 13, fontWeight: mode === m ? 600 : 400,
            minHeight: 44, WebkitTapHighlightColor: 'transparent',
          }}>{label}</button>
        ))}
      </div>

      <div>
        <label style={labelStyle}>이름 *</label>
        <input value={form.name} onChange={handleNameChange} placeholder="My Project" style={fieldStyle} />
      </div>
      <div>
        <label style={labelStyle}>로컈 경로 *</label>
        <input value={form.path} onChange={set('path')} placeholder="/Users/sun/my-project" style={fieldStyle} />
      </div>
      <div>
        <label style={labelStyle}>스택</label>
        <input value={form.stack} onChange={set('stack')} placeholder="Node.js, React, …" style={fieldStyle} />
      </div>
      <div>
        <label style={labelStyle}>설명</label>
        <input value={form.description} onChange={set('description')} placeholder="한 줄 설명" style={fieldStyle} />
      </div>

      {mode === 'create' && (
        <div style={{
          padding: '10px 12px', background: 'var(--bg3)',
          border: '1px solid var(--border)', borderRadius: 10,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              id="githubRepo"
              checked={form.githubRepo}
              onChange={set('githubRepo')}
              style={{ accentColor: 'var(--accent)' }}
            />
            <label htmlFor="githubRepo" style={{ fontSize: 13, color: 'var(--text2)', cursor: 'pointer' }}>
              GitHub 레포 자동 생성
            </label>
          </div>
          {form.githubRepo && (
            <div style={{ display: 'flex', gap: 6, paddingLeft: 22 }}>
              {[['private', '프라이빗'], ['public', '퍼블릭']].map(([val, label]) => (
                <button key={val} onClick={() => { vibrate(8); setForm(f => ({ ...f, githubPrivate: val })) }} style={{
                  flex: 1, background: form.githubPrivate === val ? 'rgba(107,94,248,0.2)' : 'none',
                  border: '1px solid ' + (form.githubPrivate === val ? 'rgba(107,94,248,0.5)' : 'var(--border)'),
                  borderRadius: 7, padding: '9px 5px', color: form.githubPrivate === val ? 'var(--accent2)' : 'var(--text3)',
                  fontSize: 13, minHeight: 44, WebkitTapHighlightColor: 'transparent',
                }}>{label}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => { vibrate(15); handleSubmit() }} disabled={saving} style={{
          flex: 1, background: 'var(--accent)', border: 'none', borderRadius: 8,
          padding: '13px', color: 'white', fontSize: 14, fontWeight: 600,
          opacity: saving ? 0.5 : 1, minHeight: 52, WebkitTapHighlightColor: 'transparent',
        }}>{saving ? (
          mode === 'create' ? '생성 중…' : '등록 중…'
        ) : (
          mode === 'create' ? '프로젝트 생성' : '등록'
        )}</button>
        <button onClick={() => { vibrate(8); onCancel() }} style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 8,
          padding: '13px 18px', color: 'var(--text3)', fontSize: 14,
          minHeight: 52, WebkitTapHighlightColor: 'transparent',
        }}>취소</button>
      </div>
    </div>
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
  const { projects, tasks, status, connected, wsEvents, runTask, stopTask, resumeTask, deleteTask, fetchTaskLogs, addProject, createProject, refresh } = useHarness()
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
          onDelete={async id => { await deleteTask(id); refresh() }}
          onBack={() => setView('list')}
          fetchTaskLogs={fetchTaskLogs}
        />
      ) : view === 'history' ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <button onClick={() => { vibrate(); setView('list') }} style={{
              background: 'none', border: 'none', color: 'var(--text3)', fontSize: 26,
              minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 10, marginLeft: -8, WebkitTapHighlightColor: 'transparent',
            }}>‹</button>
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
            <button onClick={() => { vibrate(8); setShowAddForm(f => !f) }} style={{
              background: showAddForm ? 'rgba(107,94,248,0.2)' : 'none',
              border: '1px solid ' + (showAddForm ? 'rgba(107,94,248,0.4)' : 'var(--border)'),
              borderRadius: 8, minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: showAddForm ? 'var(--accent2)' : 'var(--text3)', fontSize: 20, lineHeight: 1,
              WebkitTapHighlightColor: 'transparent',
            }}>{showAddForm ? '×' : '+'}</button>
          </div>
          {showAddForm && (
            <AddProjectForm
              onAdd={addProject}
              onCreate={createProject}
              onCancel={() => setShowAddForm(false)}
            />
          )}
          <div className="project-list" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
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
              <div className="project-list" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                {infraProjects.map(p => (
                  <ProjectCard key={p.id} project={p} tasks={tasks} running={running}
                    onClick={() => { setSelected(p); setView('detail') }} />
                ))}
              </div>
            </>
          )}

          <button onClick={() => { vibrate(8); setView('history') }} style={{
            width: '100%', background: 'none', border: '1px solid var(--border)',
            borderRadius: 10, padding: '14px', color: 'var(--text3)', fontSize: 14,
            minHeight: 52, WebkitTapHighlightColor: 'transparent',
          }}>전체 작업 이력 →</button>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(96,165,250,0.4); }
          50% { opacity: 0.7; box-shadow: 0 0 0 4px rgba(96,165,250,0); }
        }
        * { -webkit-tap-highlight-color: transparent; }

        /* 모바일 버튼 active 피드백: 즉각적인 시각 변화 */
        button:active {
          opacity: 0.6;
          transform: scale(0.96);
          transition: opacity 0.05s, transform 0.05s !important;
        }
        button:not(:active) {
          transition: opacity 0.15s, transform 0.15s;
        }

        /* 프로젝트 카드 active 시 배경색 변화 */
        button[data-card]:active {
          background: var(--bg3) !important;
        }

        /* 모바일 전용 스타일 */
        @media (max-width: 480px) {
          /* 프로젝트 목록 카드 간격 확대 */
          .project-list { gap: 12px !important; }

          /* textarea 모바일 최적화: 더 큰 폰트로 iOS 자동 확대 방지 */
          textarea { font-size: 16px !important; }
        }

        /* 터치 디바이스에서 hover 효과 제거 (오터치 방지) */
        @media (hover: none) {
          button:hover { opacity: 1; }
        }
      `}</style>
    </div>
  )
}
