// dashboard/src/App.jsx
import { useState, useRef } from 'react';
import { useHarness } from './hooks/useHarness';

// ── 상수 ──────────────────────────────────────────────────
const PHASE = {
  pending:    { icon: '○', label: '대기',     color: '#585870' },
  planning:   { icon: '◈', label: 'Plan',    color: '#a78bfa' },
  building:   { icon: '◆', label: 'Build',   color: '#60a5fa' },
  evaluating: { icon: '◉', label: 'Eval',    color: '#fb923c' },
  done:       { icon: '●', label: '완료',     color: '#3dd68c' },
  failed:     { icon: '✕', label: '실패',     color: '#f87171' },
  paused:     { icon: '▸', label: '재개대기', color: '#f59e0b' },
};

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

// ── 탭 ────────────────────────────────────────────────────
const TABS = ['프로젝트', '작업', '로그'];

// ── 컴포넌트: 상단 헤더 ───────────────────────────────────
function Header({ connected, onRefresh }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 16px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg)',
      position: 'sticky', top: 0, zIndex: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: connected ? 'var(--green)' : 'var(--text3)',
          flexShrink: 0,
        }} />
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.3px' }}>
          Agent Harness
        </span>
      </div>
      <button
        onClick={onRefresh}
        style={{ color: 'var(--text2)', fontSize: 13, padding: '4px 8px' }}
      >
        새로고침
      </button>
    </div>
  );
}

// ── 컴포넌트: 탭 바 ───────────────────────────────────────
function TabBar({ active, onChange }) {
  return (
    <div style={{
      display: 'flex',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg)',
      position: 'sticky', top: 49, zIndex: 9,
    }}>
      {TABS.map(tab => (
        <button
          key={tab}
          onClick={() => onChange(tab)}
          style={{
            flex: 1, padding: '10px 0', fontSize: 13,
            color: active === tab ? 'var(--text)' : 'var(--text3)',
            borderBottom: active === tab ? '2px solid var(--accent2)' : '2px solid transparent',
            fontWeight: active === tab ? 600 : 400,
            transition: 'color 0.15s',
          }}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

const FILE_SIZE_WARN = 5 * 1024 * 1024; // 5MB
// 텍스트로 읽을 수 있는 파일 확장자
const TEXT_EXTENSIONS = /\.(md|txt|json|js|ts|jsx|tsx|py|yaml|yml|html|css|sh|env|toml|xml|sql|java|c|cpp|h|go|rs|rb|php|swift|kt|vue|svelte|prisma|graphql|csv|log|conf|ini|gitignore|dockerfile)$/i;

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

// ── 첨부된 파일명 뱃지 ────────────────────────────────────
function AttachedFileBadges({ fileNames, onRemoveAll }) {
  if (!fileNames.length) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
      {fileNames.map((name, i) => (
        <span key={i} style={{
          background: 'var(--accent)22',
          border: '1px solid var(--accent)',
          borderRadius: 12,
          padding: '2px 10px',
          fontSize: 11, color: 'var(--accent2)',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          📄 {name}
        </span>
      ))}
      {fileNames.length > 1 && (
        <button
          onClick={onRemoveAll}
          style={{ fontSize: 11, color: 'var(--text3)', padding: '2px 6px' }}
        >
          모두 제거
        </button>
      )}
    </div>
  );
}

// ── 컴포넌트: 프로젝트 카드 ───────────────────────────────
function ProjectCard({ project, onRun, currentTask }) {
  const [showForm, setShowForm]       = useState(false);
  const [prompt, setPrompt]           = useState('');
  const [attachedFiles, setAttachedFiles] = useState([]); // { name, text }
  const [sending, setSending]         = useState(false);
  const [err, setErr]                 = useState('');
  const fileInputRef = useRef(null);

  const latest    = project.latestTask;
  const phaseInfo = latest ? (PHASE[latest.status] || PHASE.pending) : null;
  const isActive  = currentTask?.project === project.id;

  async function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const errors = [];
    const newFiles = [];

    for (const file of files) {
      if (file.size > FILE_SIZE_WARN) {
        errors.push(`${file.name}: 5MB 초과 파일입니다`);
        continue;
      }

      const isText = file.type.startsWith('text/') || TEXT_EXTENSIONS.test(file.name);
      if (!isText) {
        errors.push(`${file.name}: 텍스트/코드 파일만 지원합니다 (이미지 불가)`);
        continue;
      }

      try {
        const text = await readFileAsText(file);
        newFiles.push({ name: file.name, text });
      } catch {
        errors.push(`${file.name}: 파일 읽기 실패`);
      }
    }

    if (newFiles.length) setAttachedFiles(prev => [...prev, ...newFiles]);
    if (errors.length) setErr(errors.join('\n'));
    else setErr('');

    e.target.value = '';
  }

  function handleRemoveAllAttachments() {
    setAttachedFiles([]);
  }

  async function handleRun() {
    if (!prompt.trim()) { setErr('작업 내용을 입력하세요'); return; }
    setSending(true); setErr('');
    try {
      const attachments = attachedFiles.length > 0
        ? attachedFiles.map(f => ({ type: 'text', name: f.name, text: f.text }))
        : undefined;
      await onRun({
        projectId: project.id,
        prompt: prompt.trim(),
        attachments,
      });
      setPrompt(''); setAttachedFiles([]); setShowForm(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  }

  function handleCancel() {
    setShowForm(false);
    setPrompt('');
    setAttachedFiles([]);
    setErr('');
  }

  return (
    <div style={{
      background: 'var(--bg2)',
      border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
      borderRadius: 12,
      padding: '14px 16px',
      marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{project.name}</span>
          <span style={{ color: 'var(--text3)', fontSize: 11, marginLeft: 8 }}>
            {project.stack}
          </span>
        </div>
        {phaseInfo && (
          <span style={{
            fontSize: 11, color: phaseInfo.color,
            background: `${phaseInfo.color}22`,
            padding: '2px 8px', borderRadius: 20, fontWeight: 600,
          }}>
            {phaseInfo.icon} {phaseInfo.label}
          </span>
        )}
      </div>

      {project.description && (
        <p style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 8 }}>
          {project.description}
        </p>
      )}

      {latest && (
        <p style={{ color: 'var(--text3)', fontSize: 11, marginBottom: 10 }}>
          마지막: {(latest.prompt || '').slice(0, 50)} · {timeAgo(latest.updated_at)}
        </p>
      )}

      {/* 파일 input (항상 DOM에 존재, display:none) */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.txt,.json,.js,.ts,.jsx,.tsx,.py,.yaml,.yml,.html,.css,.sh,.env,.toml,.xml,.sql,.java,.c,.cpp,.h,.go,.rs,.rb,.php,.swift,.kt,.vue,.svelte,.prisma,.graphql,.csv,.log,.conf,.ini"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />

      {!showForm ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setShowForm(true)}
            style={{
              flex: 1, padding: '8px', borderRadius: 8,
              background: 'var(--accent)', color: '#fff',
              fontSize: 13, fontWeight: 600,
            }}
          >
            + 작업 실행
          </button>
          <button
            onClick={() => { setShowForm(true); setTimeout(() => fileInputRef.current?.click(), 50); }}
            title="파일 첨부 후 작업 실행"
            style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'var(--bg3)',
              border: '1px solid var(--border)',
              color: 'var(--text)', fontSize: 13,
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontWeight: 500,
            }}
          >
            <span style={{ fontSize: 16 }}>📎</span>
          </button>
        </div>
      ) : (
        <div>
          <textarea
            value={prompt}
            onChange={e => { setPrompt(e.target.value); setErr(''); }}
            placeholder="작업 내용을 입력하세요..."
            rows={4}
            style={{
              width: '100%', padding: '10px', borderRadius: 8,
              background: 'var(--bg3)', border: '1px solid var(--border)',
              color: 'var(--text)', fontSize: 13, resize: 'vertical',
              marginBottom: 8,
              fontFamily: 'var(--mono)',
            }}
          />

          {/* 첨부된 파일명 뱃지 */}
          <AttachedFileBadges
            fileNames={attachedFiles.map(f => f.name)}
            onRemoveAll={handleRemoveAllAttachments}
          />

          {/* 파일 첨부 버튼 */}
          <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                padding: '6px 14px', borderRadius: 6,
                background: 'var(--bg3)',
                border: '1px solid rgba(255,255,255,0.18)',
                color: 'var(--text)', fontSize: 12,
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontWeight: 500,
              }}
            >
              <span style={{ fontSize: 14 }}>📎</span>
              파일 첨부
              {attachedFiles.length > 0 && (
                <span style={{
                  background: 'var(--accent)', color: '#fff',
                  borderRadius: 10, padding: '1px 6px', fontSize: 10, fontWeight: 700,
                }}>
                  {attachedFiles.length}
                </span>
              )}
            </button>
            <span style={{ color: 'var(--text3)', fontSize: 11 }}>
              텍스트·코드 파일 지원 (내용이 지시에 포함됨)
            </span>
          </div>

          {err && (
            <p style={{
              color: 'var(--red)', fontSize: 12, marginBottom: 6,
              whiteSpace: 'pre-line',
            }}>
              {err}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleRun}
              disabled={sending}
              style={{
                flex: 1, padding: '8px', borderRadius: 8,
                background: sending ? 'var(--bg3)' : 'var(--accent)',
                color: sending ? 'var(--text2)' : '#fff',
                fontSize: 13, fontWeight: 600,
              }}
            >
              {sending ? '실행 중...' : '실행'}
            </button>
            <button
              onClick={handleCancel}
              style={{
                padding: '8px 16px', borderRadius: 8,
                background: 'var(--bg3)', color: 'var(--text2)', fontSize: 13,
              }}
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 컴포넌트: 작업 행 ─────────────────────────────────────
function TaskRow({ task, onResume, onStop, onDelete }) {
  const p = PHASE[task.status] || PHASE.pending;
  const canResume = task.status === 'paused';
  const canStop   = ['planning', 'building', 'evaluating', 'pending'].includes(task.status);
  const canDelete = !['done'].includes(task.status);

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 14px', marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
          {task.id.slice(-12)}
        </span>
        <span style={{ fontSize: 11, color: p.color, fontWeight: 600 }}>
          {p.icon} {p.label}
        </span>
      </div>
      <p style={{ fontSize: 13, marginBottom: 4, color: 'var(--text)' }}>
        {(task.prompt || '').slice(0, 80)}{task.prompt?.length > 80 ? '...' : ''}
      </p>
      <p style={{ fontSize: 11, color: 'var(--text3)' }}>
        {task.project_name || task.project_id} · {timeAgo(task.updated_at)}
        {task.round ? ` · R${task.round}` : ''}
      </p>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        {canResume && (
          <button onClick={() => onResume(task.id)} style={{
            padding: '4px 12px', borderRadius: 6,
            background: 'var(--green)', color: '#000', fontSize: 12, fontWeight: 600,
          }}>재개</button>
        )}
        {canStop && (
          <button onClick={() => onStop(task.id)} style={{
            padding: '4px 12px', borderRadius: 6,
            background: 'var(--bg3)', color: 'var(--text2)', fontSize: 12,
          }}>중지</button>
        )}
        {canDelete && (
          <button onClick={() => onDelete(task.id)} style={{
            padding: '4px 12px', borderRadius: 6,
            background: 'var(--bg3)', color: 'var(--red)', fontSize: 12,
          }}>삭제</button>
        )}
      </div>
    </div>
  );
}

// ── 컴포넌트: 스트림 로그 ─────────────────────────────────
function StreamLog({ logs }) {
  const phaseColors = { planning: '#a78bfa', building: '#60a5fa', evaluating: '#fb923c' };

  if (logs.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
        실행 중인 작업이 없습니다
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
      {logs.map(entry => (
        <div key={entry.id} style={{
          padding: '6px 16px',
          borderBottom: '1px solid var(--border)',
          color: entry.isTool ? 'var(--text3)' : 'var(--text)',
        }}>
          <span style={{
            color: phaseColors[entry.phase] || 'var(--text3)',
            marginRight: 8, fontSize: 10,
          }}>
            [{entry.phase} R{entry.round}]
          </span>
          {entry.text}
        </div>
      ))}
    </div>
  );
}

// ── 메인 App ──────────────────────────────────────────────
export default function App() {
  const {
    projects, tasks, status, connected, streamLog,
    loading, error,
    refresh, runTask, resumeTask, stopTask, deleteTask,
  } = useHarness();

  const [tab, setTab]       = useState('프로젝트');
  const [actionErr, setErr] = useState('');

  async function withErr(fn) {
    try { setErr(''); await fn(); }
    catch (e) { setErr(e.message); }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text2)' }}>
        로딩 중...
      </div>
    );
  }

  const currentTask = status?.currentTask;

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header connected={connected} onRefresh={refresh} />
      <TabBar active={tab} onChange={setTab} />

      {error && (
        <div style={{ padding: '10px 16px', background: '#f8717122', color: 'var(--red)', fontSize: 12 }}>
          {error}
        </div>
      )}
      {actionErr && (
        <div style={{ padding: '10px 16px', background: '#f8717122', color: 'var(--red)', fontSize: 12 }}>
          {actionErr}
        </div>
      )}

      {/* 현재 실행 중 배너 */}
      {currentTask && (
        <div style={{
          margin: '10px 16px 0',
          padding: '10px 14px',
          background: 'var(--accent)22',
          border: '1px solid var(--accent)',
          borderRadius: 10,
          fontSize: 12,
        }}>
          <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>실행 중</span>
          {' '}— {currentTask.project} · {(PHASE[currentTask.phase] || PHASE.pending).label} R{currentTask.round}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: tab === '로그' ? 0 : '12px 16px' }}>
        {tab === '프로젝트' && (
          <div>
            {projects.length === 0 ? (
              <p style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', paddingTop: 40 }}>
                등록된 프로젝트가 없습니다
              </p>
            ) : projects.map(p => (
              <ProjectCard
                key={p.id}
                project={p}
                currentTask={currentTask}
                onRun={data => withErr(() => runTask(data))}
              />
            ))}
          </div>
        )}

        {tab === '작업' && (
          <div>
            {tasks.length === 0 ? (
              <p style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', paddingTop: 40 }}>
                작업 이력이 없습니다
              </p>
            ) : tasks.map(t => (
              <TaskRow
                key={t.id}
                task={t}
                onResume={id => withErr(() => resumeTask(id))}
                onStop={id   => withErr(() => stopTask(id))}
                onDelete={id => withErr(() => deleteTask(id))}
              />
            ))}
          </div>
        )}

        {tab === '로그' && <StreamLog logs={streamLog} />}
      </div>
    </div>
  );
}
