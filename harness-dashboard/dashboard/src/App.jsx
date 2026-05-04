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
function Header({ connected, onRefresh, onLogout, showLogout }) {
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
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onRefresh}
          style={{ color: 'var(--text2)', fontSize: 13, padding: '4px 8px' }}
        >
          새로고침
        </button>
        {showLogout && (
          <button
            onClick={onLogout}
            style={{ color: 'var(--text3)', fontSize: 13, padding: '4px 8px' }}
          >
            🔒 잠금
          </button>
        )}
      </div>
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

// ── 컴포넌트: Eval 배지 ───────────────────────────────────
function EvalBadge({ evalResult, isEvaluating }) {
  const [showIssues, setShowIssues] = useState(false);

  if (isEvaluating) {
    return (
      <span style={{
        fontSize: 11, padding: '2px 8px', borderRadius: 20, fontWeight: 600,
        background: '#fb923c22', color: '#fb923c',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}>
        ◉ 평가 중...
      </span>
    );
  }

  if (!evalResult) return null;

  const score   = evalResult.score ?? evalResult.total_score ?? null;
  const passed  = evalResult.passed ?? evalResult.pass ?? null;
  const issues  = evalResult.issues ?? evalResult.failures ?? [];
  const hasScore = score !== null && score !== undefined;

  if (!hasScore && passed === null) return null;

  const color = passed === true ? '#3dd68c' : passed === false ? '#f87171' : '#a78bfa';
  const icon  = passed === true ? '✓' : passed === false ? '✗' : '?';

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button
        onClick={() => issues.length > 0 && setShowIssues(v => !v)}
        style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 20, fontWeight: 600,
          background: `${color}22`, color,
          display: 'inline-flex', alignItems: 'center', gap: 4,
          cursor: issues.length > 0 ? 'pointer' : 'default',
          border: 'none',
        }}
      >
        {icon} {hasScore ? `${score}/100` : (passed === true ? 'PASS' : 'FAIL')}
        {issues.length > 0 && (
          <span style={{
            background: color, color: passed === true ? '#000' : '#fff',
            borderRadius: 10, padding: '0 5px', fontSize: 10, fontWeight: 700,
          }}>
            {issues.length}
          </span>
        )}
      </button>
      {showIssues && issues.length > 0 && (
        <div style={{
          background: 'var(--bg3)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '8px 10px',
          fontSize: 11, color: 'var(--text2)',
          maxWidth: 260, textAlign: 'left',
        }}>
          {issues.map((issue, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: i < issues.length - 1 ? 4 : 0 }}>
              <span style={{ color: 'var(--red)', flexShrink: 0 }}>•</span>
              <span>{typeof issue === 'string' ? issue : (issue.message || issue.description || JSON.stringify(issue))}</span>
            </div>
          ))}
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
  const showEval  = ['done', 'failed', 'evaluating'].includes(task.status);

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
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <p style={{ fontSize: 11, color: 'var(--text3)', flex: 1 }}>
          {task.project_name || task.project_id} · {timeAgo(task.updated_at)}
          {task.round ? ` · R${task.round}` : ''}
        </p>
        {showEval && (
          <EvalBadge
            evalResult={task.eval_result}
            isEvaluating={task.status === 'evaluating'}
          />
        )}
      </div>
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

// ── 컴포넌트: 로그인 화면 ─────────────────────────────────
function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!password) { setError('비밀번호를 입력하세요'); return; }
    setLoading(true);
    setError('');
    try {
      await onLogin(password);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: 'var(--bg)',
    }}>
      <div style={{
        width: 320, padding: '32px 24px',
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 16,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
          <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Agent Harness</h1>
          <p style={{ fontSize: 13, color: 'var(--text3)' }}>비밀번호를 입력하세요</p>
        </div>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }}
            placeholder="비밀번호"
            autoFocus
            style={{
              width: '100%', padding: '10px 12px',
              borderRadius: 8, marginBottom: 12,
              background: 'var(--bg3)', border: '1px solid var(--border)',
              color: 'var(--text)', fontSize: 14,
              boxSizing: 'border-box',
            }}
          />

          {error && (
            <p style={{ color: 'var(--red)', fontSize: 12, marginBottom: 10 }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '10px',
              borderRadius: 8, fontWeight: 600, fontSize: 14,
              background: loading ? 'var(--bg3)' : 'var(--accent)',
              color: loading ? 'var(--text2)' : '#fff',
            }}
          >
            {loading ? '확인 중...' : '접속'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── 컴포넌트: 프로젝트 등록 모달 ──────────────────────────
function RegisterProjectModal({ onAdd, onCreate, onClose }) {
  const [mode, setMode] = useState('register'); // 'register' | 'create'
  const [form, setForm] = useState({
    id: '', name: '', path: '', stack: '', description: '',
    github: '', deploy: '',
    githubRepo: true,
    githubPrivate: 'private',
  });
  const [idEdited, setIdEdited] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  const set = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm(f => ({ ...f, [key]: val }));
  };

  const handleIdChange = (e) => {
    setIdEdited(true);
    setForm(f => ({ ...f, id: e.target.value }));
  };

  const handleNameChange = (e) => {
    const name = e.target.value;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    setForm(f => ({
      ...f,
      name,
      id: idEdited ? f.id : slug,
      path: f.path && f.path !== `/Users/sun/${f.id}` ? f.path : (slug ? `/Users/sun/${slug}` : ''),
    }));
  };

  const handleSubmit = async () => {
    if (!form.id.trim()) { setError('프로젝트 ID는 필수입니다'); return; }
    if (!/^[a-z0-9-]{1,50}$/.test(form.id.trim())) {
      setError('프로젝트 ID: 영문 소문자/숫자/하이픈만 허용 (최대 50자)');
      return;
    }
    if (!form.name.trim()) { setError('프로젝트 이름은 필수입니다'); return; }
    if (!form.path.trim()) { setError('로컬 경로는 필수입니다'); return; }
    setError('');
    setSaving(true);
    setResult(null);

    try {
      const payload = {
        id: form.id.trim(),
        name: form.name.trim(),
        path: form.path.trim(),
        stack: form.stack.trim() || undefined,
        description: form.description.trim() || undefined,
        github: form.github.trim() || undefined,
        deploy: form.deploy.trim() || undefined,
      };

      let res;
      if (mode === 'create') {
        res = await onCreate({
          ...payload,
          githubRepo: form.githubRepo ? 'auto' : false,
          githubPrivate: form.githubPrivate !== 'public',
        });
      } else {
        res = await onAdd(payload);
      }

      if (res?.error) {
        setError(res.error);
      } else {
        setResult(res);
      }
    } catch (e) {
      setError(e.message || '오류가 발생했습니다');
    } finally {
      setSaving(false);
    }
  };

  const fieldStyle = {
    width: '100%', background: 'var(--bg3)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '9px 11px', color: 'var(--text)',
    fontSize: 13, outline: 'none', boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: 11, color: 'var(--text3)', fontWeight: 600, marginBottom: 4, display: 'block' };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div style={{
        width: '100%', maxWidth: 480,
        background: 'var(--bg2)', borderRadius: '16px 16px 0 0',
        border: '1px solid var(--border)', borderBottom: 'none',
        padding: '20px 16px 32px',
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        {/* 헤더 */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ flex: 1, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>프로젝트 등록</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--text3)',
            fontSize: 22, minWidth: 44, minHeight: 44,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
        </div>

        {/* 모드 탭 */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
          {[['register', '기존 프로젝트 등록'], ['create', '새 폴더 생성']].map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)} style={{
              flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: mode === m ? 'rgba(107,94,248,0.15)' : 'var(--bg3)',
              border: '1px solid ' + (mode === m ? 'rgba(107,94,248,0.4)' : 'var(--border)'),
              color: mode === m ? 'var(--accent2)' : 'var(--text2)',
            }}>{label}</button>
          ))}
        </div>

        {result ? (
          <div>
            <div style={{
              padding: '16px', background: 'rgba(61,214,140,0.1)',
              border: '1px solid rgba(61,214,140,0.3)', borderRadius: 10, marginBottom: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--green)', marginBottom: 6 }}>
                등록 완료!
              </div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                <div>ID: <span style={{ color: 'var(--text)', fontFamily: 'monospace' }}>{result.id}</span></div>
                <div>이름: {result.name}</div>
              </div>
            </div>
            <button onClick={onClose} style={{
              width: '100%', padding: '12px', borderRadius: 8, fontWeight: 600, fontSize: 13,
              background: 'var(--accent)', border: 'none', color: '#fff',
            }}>닫기</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* 프로젝트 이름 */}
            <div>
              <label style={labelStyle}>프로젝트 이름 *</label>
              <input value={form.name} onChange={handleNameChange} placeholder="My Project" style={fieldStyle} />
            </div>

            {/* 프로젝트 ID */}
            <div>
              <label style={labelStyle}>프로젝트 ID *</label>
              <input value={form.id} onChange={handleIdChange}
                placeholder="my-project" style={fieldStyle} />
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 3 }}>영문 소문자, 숫자, 하이픈만 허용</div>
            </div>

            {/* 로컬 경로 */}
            <div>
              <label style={labelStyle}>로컬 경로 *</label>
              <input value={form.path} onChange={set('path')}
                placeholder="/Users/sun/my-project" style={fieldStyle} />
            </div>

            {/* 스택 */}
            <div>
              <label style={labelStyle}>스택 (선택)</label>
              <input value={form.stack} onChange={set('stack')}
                placeholder="Next.js, Supabase" style={fieldStyle} />
            </div>

            {/* 설명 */}
            <div>
              <label style={labelStyle}>설명 (선택)</label>
              <input value={form.description} onChange={set('description')}
                placeholder="프로젝트 설명" style={fieldStyle} />
            </div>

            {/* GitHub URL */}
            <div>
              <label style={labelStyle}>GitHub URL (선택)</label>
              <input value={form.github} onChange={set('github')}
                placeholder="https://github.com/user/repo" style={fieldStyle} />
            </div>

            {/* 배포 URL */}
            <div>
              <label style={labelStyle}>배포 URL (선택)</label>
              <input value={form.deploy} onChange={set('deploy')}
                placeholder="https://my-project.vercel.app" style={fieldStyle} />
            </div>

            {/* GitHub 자동 생성 (create 모드만) */}
            {mode === 'create' && (
              <div style={{
                padding: '12px', background: 'var(--bg3)',
                border: '1px solid var(--border)', borderRadius: 8,
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.githubRepo} onChange={set('githubRepo')} />
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>GitHub 레포 자동 생성</span>
                </label>
                {form.githubRepo && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                    {['private', 'public'].map(v => (
                      <button key={v} onClick={() => setForm(f => ({ ...f, githubPrivate: v }))} style={{
                        flex: 1, padding: '6px 0', borderRadius: 6, fontSize: 11, fontWeight: 600,
                        background: form.githubPrivate === v ? 'rgba(107,94,248,0.15)' : 'var(--bg2)',
                        border: '1px solid ' + (form.githubPrivate === v ? 'rgba(107,94,248,0.4)' : 'var(--border)'),
                        color: form.githubPrivate === v ? 'var(--accent2)' : 'var(--text3)',
                      }}>{v === 'private' ? '비공개' : '공개'}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {error && (
              <div style={{ fontSize: 12, color: 'var(--red)', padding: '8px 10px', background: 'rgba(248,113,113,0.1)', borderRadius: 6 }}>
                {error}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={saving}
              style={{
                width: '100%', padding: '12px', borderRadius: 8, fontWeight: 600, fontSize: 13,
                background: saving ? 'var(--bg3)' : 'var(--accent)', border: 'none',
                color: saving ? 'var(--text2)' : '#fff', marginTop: 4,
              }}
            >
              {saving ? '처리 중...' : (mode === 'create' ? '생성' : '등록')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 메인 App ──────────────────────────────────────────────
export default function App() {
  const {
    projects, tasks, status, connected, streamLog, dbLogs,
    loading, error,
    authenticated, passwordRequired,
    refresh, runTask, resumeTask, stopTask, deleteTask, addProject, createProject,
    login, logout, checkAuth,
  } = useHarness();

  // 스트림 로그가 있으면 스트림 우선, 없으면 DB 로그 표시
  const displayLogs = streamLog.length > 0 ? streamLog : dbLogs;

  const [tab, setTab]                     = useState('프로젝트');
  const [actionErr, setErr]               = useState('');
  const [showRegisterModal, setShowRegisterModal] = useState(false);

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

  // 백엔드 URL 미설정 오류 (VITE_API_BASE 없음)
  if (error && !authenticated && !passwordRequired) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)', padding: '0 24px' }}>
        <div style={{ maxWidth: 400, width: '100%' }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🔌</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: 'var(--text)' }}>백엔드 연결 실패</h2>
            <p style={{ fontSize: 13, color: 'var(--text3)', lineHeight: 1.6 }}>{error}</p>
          </div>
          <div style={{
            padding: '16px', background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 12, fontSize: 12, color: 'var(--text2)', lineHeight: 1.8,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>설정 방법:</div>
            <div>1. Cloudflare Tunnel 시작: <code style={{ color: 'var(--accent2)' }}>npm run tunnel:cf</code></div>
            <div>2. 출력된 URL을 <code style={{ color: 'var(--accent2)' }}>VITE_API_BASE</code>에 설정</div>
            <div>3. Vercel 환경변수에도 동일하게 설정 후 재배포</div>
          </div>
          <button
            onClick={checkAuth}
            style={{
              marginTop: 16, width: '100%', padding: '12px',
              background: 'var(--accent)', border: 'none', borderRadius: 8,
              color: '#fff', fontSize: 14, fontWeight: 600,
            }}
          >
            다시 연결 시도
          </button>
        </div>
      </div>
    );
  }

  // 비밀번호 설정됨 & 미인증 상태
  if (passwordRequired && !authenticated) {
    return <LoginScreen onLogin={login} />;
  }

  const currentTask = status?.currentTask;

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header connected={connected} onRefresh={refresh} onLogout={logout} showLogout={passwordRequired} />
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

      {/* 프로젝트 등록 모달 */}
      {showRegisterModal && (
        <RegisterProjectModal
          onAdd={addProject}
          onCreate={createProject}
          onClose={() => { setShowRegisterModal(false); refresh(); }}
        />
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: tab === '로그' ? 0 : '12px 16px' }}>
        {tab === '프로젝트' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>프로젝트</span>
              <button onClick={() => setShowRegisterModal(true)} style={{
                background: 'rgba(107,94,248,0.1)',
                border: '1px solid rgba(107,94,248,0.3)',
                borderRadius: 8, padding: '0 12px', height: 32,
                display: 'flex', alignItems: 'center', gap: 5,
                color: 'var(--accent2)', fontSize: 12, fontWeight: 600,
              }}>
                <span style={{ fontSize: 16, marginTop: -1 }}>+</span>
                <span>새 프로젝트 등록</span>
              </button>
            </div>
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

        {tab === '로그' && <StreamLog logs={displayLogs} />}
      </div>
    </div>
  );
}
