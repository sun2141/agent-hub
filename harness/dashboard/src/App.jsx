// src/App.jsx
import { useState, useRef, useEffect, useCallback } from 'react'
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
const rtf = new Intl.RelativeTimeFormat(navigator.language || 'ko', { numeric: 'auto' })

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const utcStr = dateStr.endsWith('Z') ? dateStr : dateStr.replace(' ', 'T') + 'Z'
  const diffSec = (new Date(utcStr).getTime() - Date.now()) / 1000
  const abs = Math.abs(diffSec)
  if (abs < 60)    return rtf.format(Math.round(diffSec), 'second')
  if (abs < 3600)  return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  return rtf.format(Math.round(diffSec / 86400), 'day')
}

// ── 파일 읽기 헬퍼 ────────────────────────────────────────
const TEXT_EXTENSIONS = /\.(md|txt|json|js|ts|jsx|tsx|py|yaml|yml|html|css|sh|env|toml|xml|sql|java|c|cpp|h|go|rs|rb|php|swift|kt|vue|svelte|prisma|graphql|csv|log|conf|ini)$/i

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsText(file)
  })
}

// ── API 헬퍼 (훅 외부에서 사용) ───────────────────────────
const API_KEY_RAW = import.meta.env.VITE_API_KEY || ''
const _API_BASE_URL_RAW = import.meta.env.VITE_API_BASE_URL || ''
const API_BASE_RAW = _API_BASE_URL_RAW ? `${_API_BASE_URL_RAW}/api` : '/api'
function apiFetchRaw(path, options = {}) {
  return fetch(`${API_BASE_RAW}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY_RAW,
      ...options.headers,
    },
  }).then(r => r.json())
}

// ── 파일 트리 노드 렌더러 ─────────────────────────────────
function FileTreeNode({ name, node, depth = 0, selected, onToggle, path = '' }) {
  const [open, setOpen] = useState(depth < 2)
  const isDir = node._type === 'dir'
  const fullPath = path ? `${path}/${name}` : name

  if (isDir) {
    const children = node._children || {}
    const childKeys = Object.keys(children).sort((a, b) => {
      const aDir = children[a]._type === 'dir'
      const bDir = children[b]._type === 'dir'
      if (aDir && !bDir) return -1
      if (!aDir && bDir) return 1
      return a.localeCompare(b)
    })
    return (
      <div>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, width: '100%',
            background: 'none', border: 'none', padding: `3px 0 3px ${depth * 14}px`,
            color: 'var(--text2)', fontSize: 12, cursor: 'pointer', textAlign: 'left',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <span style={{ fontSize: 10 }}>{open ? '▼' : '▶'}</span>
          <span style={{ fontSize: 13 }}>📁</span>
          <span style={{ fontWeight: 500 }}>{name}</span>
        </button>
        {open && childKeys.map(k => (
          <FileTreeNode
            key={k} name={k} node={children[k]} depth={depth + 1}
            selected={selected} onToggle={onToggle} path={fullPath}
          />
        ))}
      </div>
    )
  }

  const filePath = node._path || fullPath
  const isSelected = selected.has(filePath)
  return (
    <div
      onClick={() => onToggle(filePath)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: `3px 4px 3px ${depth * 14 + 4}px`,
        borderRadius: 6, cursor: 'pointer',
        background: isSelected ? 'rgba(107,94,248,0.12)' : 'transparent',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() => onToggle(filePath)}
        onClick={e => e.stopPropagation()}
        style={{ accentColor: 'var(--accent)', flexShrink: 0, cursor: 'pointer' }}
      />
      <span style={{ fontSize: 12 }}>📄</span>
      <span style={{ fontSize: 12, color: 'var(--text2)', flex: 1, wordBreak: 'break-all' }}>{name}</span>
      {node._size > 0 && (
        <span style={{ fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}>
          {node._size < 1024 ? `${node._size}B` : node._size < 1048576 ? `${(node._size/1024).toFixed(1)}K` : `${(node._size/1048576).toFixed(1)}M`}
        </span>
      )}
    </div>
  )
}

// ── 폴더 업로드 패널 ──────────────────────────────────────
function FolderUploadPanel({ onFilesReady, onLinkReady, onClose }) {
  const [mode, setMode] = useState('local') // 'local' | 'gdrive' | 'dropbox' | 'link'
  const [cloudUrl, setCloudUrl] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [linkTitle, setLinkTitle] = useState('')
  const [linkError, setLinkError] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState(null) // { done, total }

  // 파일 트리 상태
  const [tree, setTree] = useState(null)
  const [flatFiles, setFlatFiles] = useState([]) // { path, name, size, text?, downloadUrl?, id?, dropboxPath? }
  const [selected, setSelected] = useState(new Set())
  const [source, setSource] = useState(null) // 'local' | 'gdrive' | 'dropbox'
  const [dropboxSharedLinkUrl, setDropboxSharedLinkUrl] = useState('') // 폴백 다운로드용

  // 드래그앤드롭
  const [dragging, setDragging] = useState(false)
  const dropRef = useRef(null)
  const folderInputRef = useRef(null)

  const TEXT_EXT = /\.(md|txt|json|js|ts|jsx|tsx|py|yaml|yml|html|css|sh|env|toml|xml|sql|java|c|cpp|h|go|rs|rb|php|swift|kt|vue|svelte|prisma|graphql|csv|log|conf|ini)$/i

  // 파일 목록에서 트리 구성
  function buildTreeFromFiles(files) {
    const tree = {}
    for (const f of files) {
      const parts = (f.path || f.name).split('/').filter(Boolean)
      let node = tree
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) node[parts[i]] = { _type: 'dir', _children: {} }
        node = node[parts[i]]._children
      }
      const fname = parts[parts.length - 1] || f.name
      node[fname] = { _type: 'file', _path: f.path || f.name, _size: f.size || 0 }
    }
    return tree
  }

  // 로컬 폴더 파일 처리 (병렬 읽기)
  async function processLocalFiles(fileList) {
    const files = Array.from(fileList)
    const textFiles = files.filter(f => {
      if (f.size > 5 * 1024 * 1024) return false
      return f.type.startsWith('text/') || TEXT_EXT.test(f.name)
    })

    if (textFiles.length === 0) {
      setError('텍스트/코드 파일이 없습니다')
      return
    }

    setLoading(true)
    setError('')
    setProgress({ done: 0, total: textFiles.length })

    const CONCURRENCY = 16
    const processed = []
    let done = 0

    for (let i = 0; i < textFiles.length; i += CONCURRENCY) {
      const chunk = textFiles.slice(i, i + CONCURRENCY)
      const results = await Promise.all(chunk.map(async file => {
        try {
          const text = await readFileAsText(file)
          const relPath = file.webkitRelativePath || file.name
          return { path: relPath, name: file.name, size: file.size, text }
        } catch {
          return null
        }
      }))
      for (const r of results) {
        if (r) processed.push(r)
        done++
      }
      setProgress({ done, total: textFiles.length })
    }

    setLoading(false)
    setProgress(null)
    const tree = buildTreeFromFiles(processed)
    setTree(tree)
    setFlatFiles(processed)
    setSelected(new Set(processed.map(f => f.path)))
    setSource('local')
  }

  // 드래그앤드롭 이벤트
  function handleDragOver(e) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }
  function handleDragLeave(e) {
    if (!dropRef.current?.contains(e.relatedTarget)) setDragging(false)
  }
  async function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const items = e.dataTransfer.items
    if (!items) return

    const allFiles = []
    async function traverseEntry(entry, basePath = '') {
      if (entry.isFile) {
        return new Promise(resolve => {
          entry.file(file => {
            file._customPath = basePath ? `${basePath}/${file.name}` : file.name
            allFiles.push(file)
            resolve()
          }, resolve)
        })
      } else if (entry.isDirectory) {
        const reader = entry.createReader()
        return new Promise(resolve => {
          const readAll = () => {
            reader.readEntries(async entries => {
              if (!entries.length) { resolve(); return }
              await Promise.all(entries.map(e => traverseEntry(e, basePath ? `${basePath}/${entry.name}` : entry.name)))
              readAll()
            }, resolve)
          }
          readAll()
        })
      }
    }

    const promises = []
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.()
      if (entry) promises.push(traverseEntry(entry))
    }
    await Promise.all(promises)

    // _customPath 적용
    const patchedFiles = allFiles.map(f => {
      if (f._customPath) Object.defineProperty(f, 'webkitRelativePath', { value: f._customPath, writable: true })
      return f
    })
    await processLocalFiles(patchedFiles)
  }

  // 폴더 input 변경
  async function handleFolderInput(e) {
    const files = e.target.files
    if (files && files.length) await processLocalFiles(files)
    e.target.value = ''
  }

  // Google Drive 폴더 조회
  async function fetchGDrive() {
    if (!cloudUrl.trim()) { setError('Google Drive 공유 링크를 입력하세요'); return }
    setLoading(true)
    setError('')
    try {
      const data = await apiFetchRaw('/gdrive-folder', {
        method: 'POST',
        body: JSON.stringify({ url: cloudUrl.trim() }),
      })
      if (data.error) { setError(data.error); return }
      setFlatFiles(data.files || [])
      setTree(buildTreeFromFiles(data.files || []))
      setSelected(new Set((data.files || []).map(f => f.path || f.name)))
      setSource('gdrive')
    } catch (err) {
      setError(err.message || '오류 발생')
    } finally {
      setLoading(false)
    }
  }

  // Dropbox 폴더 조회
  async function fetchDropbox() {
    if (!cloudUrl.trim()) { setError('Dropbox 공유 링크를 입력하세요'); return }
    setLoading(true)
    setError('')
    try {
      const data = await apiFetchRaw('/dropbox-folder', {
        method: 'POST',
        body: JSON.stringify({ url: cloudUrl.trim() }),
      })
      if (data.error) { setError(data.error); return }
      setFlatFiles(data.files || [])
      setTree(buildTreeFromFiles(data.files || []))
      setSelected(new Set((data.files || []).map(f => f.path || f.name)))
      setDropboxSharedLinkUrl(data.sharedLinkUrl || cloudUrl.trim())
      setSource('dropbox')
    } catch (err) {
      setError(err.message || '오류 발생')
    } finally {
      setLoading(false)
    }
  }

  function toggleFile(filePath) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  function selectAll() { setSelected(new Set(flatFiles.map(f => f.path || f.name))) }
  function selectNone() { setSelected(new Set()) }

  // 선택된 파일을 에이전트 컨텍스트로 전달
  async function handleConfirm() {
    const selectedFiles = flatFiles.filter(f => selected.has(f.path || f.name))
    if (selectedFiles.length === 0) { setError('분석할 파일을 선택하세요'); return }

    setLoading(true)
    setError('')
    setProgress({ done: 0, total: selectedFiles.length })

    // 로컬 파일은 이미 text가 있으므로 즉시 처리
    // 클라우드 파일은 병렬(최대 8개 동시) 다운로드
    const CONCURRENCY = 8
    const result = []
    let done = 0

    // 청크 단위 병렬 처리
    async function processFile(f) {
      try {
        if (source === 'local' && f.text !== undefined) {
          return { name: f.name, path: f.path, text: f.text }
        } else if (source === 'gdrive' && f.id) {
          const data = await apiFetchRaw('/gdrive-download', {
            method: 'POST',
            body: JSON.stringify({ fileId: f.id, fileName: f.name }),
          })
          if (!data.error) return { name: f.name, path: f.path, text: data.text }
        } else if (source === 'dropbox') {
          if (f.downloadUrl) {
            // 방법 1: 임시 다운로드 URL 직접 사용
            const data = await apiFetchRaw('/dropbox-download', {
              method: 'POST',
              body: JSON.stringify({ url: f.downloadUrl, fileName: f.name }),
            })
            if (!data.error) return { name: f.name, path: f.path, text: data.text }
          }
          // 방법 2: 폴백 - 공유링크 + dropboxPath 조합
          if (dropboxSharedLinkUrl && (f.dropboxPath || f.path)) {
            const data = await apiFetchRaw('/dropbox-download-by-path', {
              method: 'POST',
              body: JSON.stringify({
                sharedLinkUrl: dropboxSharedLinkUrl,
                filePath: f.dropboxPath || f.path,
                fileName: f.name,
              }),
            })
            if (!data.error) return { name: f.name, path: f.path, text: data.text }
          }
        }
      } catch { /* 실패 스킵 */ }
      return null
    }

    for (let i = 0; i < selectedFiles.length; i += CONCURRENCY) {
      const chunk = selectedFiles.slice(i, i + CONCURRENCY)
      const chunkResults = await Promise.all(chunk.map(f => processFile(f)))
      for (const r of chunkResults) {
        if (r) result.push(r)
        done++
        setProgress({ done, total: selectedFiles.length })
      }
    }

    setLoading(false)
    setProgress(null)
    if (result.length === 0) { setError('읽을 수 있는 파일이 없습니다'); return }
    onFilesReady(result)
  }

  const hasTree = tree && flatFiles.length > 0
  const selectedCount = selected.size

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end',
    }}>
      <div style={{
        width: '100%', maxHeight: '90vh',
        background: 'var(--bg)', borderRadius: '20px 20px 0 0',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* 헤더 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 16px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>폴더 / 클라우드 파일 첨부</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--text3)', fontSize: 24,
            minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 10, WebkitTapHighlightColor: 'transparent',
          }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {/* 모드 탭 */}
          {!hasTree && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
              {[['local', '📁 로컬 폴더'], ['gdrive', '🌐 Drive'], ['dropbox', '📦 Dropbox'], ['link', '🔗 링크']].map(([m, label]) => (
                <button key={m} onClick={() => { setMode(m); setError(''); setCloudUrl(''); setLinkUrl(''); setLinkTitle(''); setLinkError('') }} style={{
                  flex: 1, background: mode === m ? 'rgba(107,94,248,0.18)' : 'var(--bg2)',
                  border: '1px solid ' + (mode === m ? 'rgba(107,94,248,0.5)' : 'var(--border)'),
                  borderRadius: 10, padding: '9px 4px', color: mode === m ? 'var(--accent2)' : 'var(--text3)',
                  fontSize: 12, fontWeight: mode === m ? 600 : 400,
                  minHeight: 44, WebkitTapHighlightColor: 'transparent', cursor: 'pointer',
                }}>{label}</button>
              ))}
            </div>
          )}

          {/* 로컬 폴더 업로드 */}
          {!hasTree && mode === 'local' && (
            <>
              <div
                ref={dropRef}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                style={{
                  border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 14, padding: '28px 16px', textAlign: 'center',
                  background: dragging ? 'rgba(107,94,248,0.08)' : 'var(--bg2)',
                  transition: 'all 0.15s', marginBottom: 12, cursor: 'default',
                }}
              >
                <div style={{ fontSize: 36, marginBottom: 10 }}>📁</div>
                <div style={{ fontSize: 14, color: 'var(--text2)', marginBottom: 6, fontWeight: 500 }}>
                  폴더를 여기에 드래그하세요
                </div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14 }}>
                  또는 아래 버튼으로 선택
                </div>
                <input
                  ref={folderInputRef}
                  type="file"
                  // webkitdirectory 폴더 전체 선택
                  {...{ webkitdirectory: '', directory: '' }}
                  multiple
                  onChange={handleFolderInput}
                  style={{ display: 'none' }}
                />
                <button
                  onClick={() => folderInputRef.current?.click()}
                  disabled={loading}
                  style={{
                    background: 'var(--accent)', border: 'none', borderRadius: 10,
                    padding: '11px 22px', color: 'white', fontSize: 13, fontWeight: 600,
                    opacity: loading ? 0.5 : 1, cursor: loading ? 'default' : 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >폴더 선택</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>
                텍스트·코드 파일만 지원 · 파일당 최대 5MB
              </div>
            </>
          )}

          {/* 클라우드 링크 입력 */}
          {!hasTree && (mode === 'gdrive' || mode === 'dropbox') && (
            <>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>
                  {mode === 'gdrive'
                    ? 'Google Drive 폴더 공유 링크를 붙여넣으세요'
                    : 'Dropbox 폴더 공유 링크를 붙여넣으세요'}
                </div>
                <input
                  value={cloudUrl}
                  onChange={e => setCloudUrl(e.target.value)}
                  placeholder={mode === 'gdrive'
                    ? 'https://drive.google.com/drive/folders/...'
                    : 'https://www.dropbox.com/sh/...'}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'var(--bg3)', border: '1px solid var(--border)',
                    borderRadius: 10, padding: '12px 14px', color: 'var(--text)',
                    fontSize: 14, outline: 'none',
                  }}
                />
              </div>
              <button
                onClick={mode === 'gdrive' ? fetchGDrive : fetchDropbox}
                disabled={loading || !cloudUrl.trim()}
                style={{
                  width: '100%', background: 'var(--accent)', border: 'none', borderRadius: 10,
                  padding: '13px', color: 'white', fontSize: 14, fontWeight: 600,
                  opacity: (loading || !cloudUrl.trim()) ? 0.4 : 1,
                  cursor: (loading || !cloudUrl.trim()) ? 'default' : 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >{loading ? '조회 중…' : '파일 목록 조회'}</button>
              {mode === 'gdrive' && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8, lineHeight: 1.5 }}>
                  ※ 공개 공유 폴더만 지원. 서버에 GOOGLE_API_KEY 설정 시 비공개 폴더도 지원.
                </div>
              )}
              {mode === 'dropbox' && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8, lineHeight: 1.5 }}>
                  ※ 공유 링크로 공개된 폴더만 지원. 서버에 DROPBOX_ACCESS_TOKEN 설정 시 확장 가능.
                </div>
              )}
            </>
          )}

          {/* 클라우드 링크 직접 첨부 */}
          {!hasTree && mode === 'link' && (
            <>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>
                  클라우드 링크 또는 URL을 직접 첨부합니다
                </div>
                <input
                  value={linkUrl}
                  onChange={e => { setLinkUrl(e.target.value); setLinkError('') }}
                  placeholder="https://..."
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'var(--bg3)', border: '1px solid ' + (linkError ? 'var(--red)' : 'var(--border)'),
                    borderRadius: 10, padding: '12px 14px', color: 'var(--text)',
                    fontSize: 14, outline: 'none', marginBottom: 8,
                  }}
                />
                <input
                  value={linkTitle}
                  onChange={e => setLinkTitle(e.target.value)}
                  placeholder="링크 제목 (선택)"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'var(--bg3)', border: '1px solid var(--border)',
                    borderRadius: 10, padding: '10px 14px', color: 'var(--text)',
                    fontSize: 13, outline: 'none',
                  }}
                />
              </div>
              {linkError && (
                <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8, padding: '6px 10px', background: 'rgba(248,113,113,0.08)', borderRadius: 8 }}>
                  {linkError}
                </div>
              )}
              <button
                onClick={() => {
                  const url = linkUrl.trim()
                  if (!url) { setLinkError('URL을 입력하세요'); return }
                  try { new URL(url) } catch { setLinkError('유효한 URL이 아닙니다'); return }
                  const hostname = (() => { try { return new URL(url).hostname } catch { return url } })()
                  const title = linkTitle.trim() || hostname
                  onLinkReady({ url, title, hostname })
                }}
                disabled={!linkUrl.trim()}
                style={{
                  width: '100%', background: linkUrl.trim() ? 'var(--accent)' : 'rgba(107,94,248,0.1)',
                  border: '1px solid ' + (linkUrl.trim() ? 'transparent' : 'var(--border)'),
                  borderRadius: 10, padding: '13px', color: 'white', fontSize: 14, fontWeight: 600,
                  opacity: linkUrl.trim() ? 1 : 0.4, cursor: linkUrl.trim() ? 'pointer' : 'default',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >링크 첨부</button>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8, lineHeight: 1.5 }}>
                Google Drive, Dropbox, GitHub, Notion 등 모든 URL 지원
              </div>
            </>
          )}

          {/* 진행률 표시 */}
          {loading && progress && (
            <div style={{ marginTop: 14, padding: '12px 14px', background: 'var(--bg2)', borderRadius: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>파일 처리 중…</span>
                <span style={{ fontSize: 12, color: 'var(--accent2)' }}>{progress.done} / {progress.total}</span>
              </div>
              <div style={{ height: 5, background: 'var(--bg3)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', background: 'var(--accent)', borderRadius: 10,
                  width: `${(progress.done / progress.total * 100).toFixed(0)}%`,
                  transition: 'width 0.2s',
                }} />
              </div>
            </div>
          )}

          {/* 에러 */}
          {error && (
            <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8, padding: '8px 10px', background: 'rgba(248,113,113,0.08)', borderRadius: 8 }}>
              {error}
            </div>
          )}

          {/* 파일 트리 */}
          {hasTree && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontSize: 13, color: 'var(--text2)', fontWeight: 500 }}>
                  파일 {flatFiles.length}개
                  {selectedCount > 0 && (
                    <span style={{ color: 'var(--accent2)', marginLeft: 6 }}>{selectedCount}개 선택됨</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={selectAll} style={{
                    background: 'none', border: '1px solid var(--border)', borderRadius: 7,
                    padding: '5px 10px', color: 'var(--text3)', fontSize: 11, cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                  }}>전체 선택</button>
                  <button onClick={selectNone} style={{
                    background: 'none', border: '1px solid var(--border)', borderRadius: 7,
                    padding: '5px 10px', color: 'var(--text3)', fontSize: 11, cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                  }}>해제</button>
                  <button onClick={() => { setTree(null); setFlatFiles([]); setSelected(new Set()); setSource(null); setError('') }} style={{
                    background: 'none', border: '1px solid var(--border)', borderRadius: 7,
                    padding: '5px 10px', color: 'var(--text3)', fontSize: 11, cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                  }}>다시 선택</button>
                </div>
              </div>
              <div style={{
                background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
                padding: '10px 10px', maxHeight: 320, overflowY: 'auto',
                marginBottom: 12,
              }}>
                {Object.keys(tree).sort((a, b) => {
                  const aDir = tree[a]._type === 'dir'
                  const bDir = tree[b]._type === 'dir'
                  if (aDir && !bDir) return -1
                  if (!aDir && bDir) return 1
                  return a.localeCompare(b)
                }).map(k => (
                  <FileTreeNode
                    key={k} name={k} node={tree[k]} depth={0}
                    selected={selected} onToggle={toggleFile} path=""
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 하단 확인 버튼 */}
        {hasTree && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            {loading && progress && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>파일 다운로드 중…</span>
                  <span style={{ fontSize: 12, color: 'var(--accent2)' }}>{progress.done} / {progress.total}</span>
                </div>
                <div style={{ height: 4, background: 'var(--bg3)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', background: 'var(--accent)', borderRadius: 10,
                    width: `${(progress.done / progress.total * 100).toFixed(0)}%`,
                    transition: 'width 0.2s',
                  }} />
                </div>
              </div>
            )}
            <button
              onClick={handleConfirm}
              disabled={loading || selectedCount === 0}
              style={{
                width: '100%', background: (loading || selectedCount === 0) ? 'rgba(107,94,248,0.1)' : 'var(--accent)',
                border: '1px solid ' + ((loading || selectedCount === 0) ? 'var(--border)' : 'transparent'),
                borderRadius: 12, padding: '14px', color: 'white', fontSize: 15, fontWeight: 600,
                opacity: (loading || selectedCount === 0) ? 0.4 : 1,
                cursor: (loading || selectedCount === 0) ? 'default' : 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >{loading ? '처리 중…' : `${selectedCount}개 파일 컨텍스트에 추가`}</button>
          </div>
        )}
      </div>
    </div>
  )
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

// ── 프로젝트 수정 모달 ────────────────────────────────────
function EditProjectModal({ project, onSave, onClose }) {
  const [form, setForm] = useState({
    name:        project.name        || '',
    path:        project.path        || '',
    stack:       project.stack       || '',
    description: project.description || '',
    github:      project.github      || '',
    deploy:      project.deploy      || '',
  })
  const [error, setError]   = useState('')
  const [saving, setSaving] = useState(false)

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  const handleSave = async () => {
    if (!form.name.trim()) { setError('이름은 필수입니다'); return }
    if (!form.path.trim()) { setError('경로는 필수입니다'); return }
    setError(''); setSaving(true)
    const result = await onSave(project.id, {
      name:        form.name.trim(),
      path:        form.path.trim(),
      stack:       form.stack.trim()       || undefined,
      description: form.description.trim() || undefined,
      github:      form.github.trim()      || undefined,
      deploy:      form.deploy.trim()      || undefined,
    })
    setSaving(false)
    if (result?.error) { setError(result.error); return }
    onClose()
  }

  const overlay = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 200, padding: 16,
  }
  const modal = {
    background: 'var(--bg2)', borderRadius: 16, padding: 24,
    width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 14,
    maxHeight: '90dvh', overflowY: 'auto',
  }
  const fieldStyle = {
    width: '100%', background: 'var(--bg3)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '10px 12px', color: 'var(--text)', fontSize: 14,
    outline: 'none', boxSizing: 'border-box',
  }
  const labelStyle = { fontSize: 12, color: 'var(--text3)', marginBottom: 4, display: 'block' }

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={modal}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>프로젝트 수정</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: 20, cursor: 'pointer', minWidth: 36, minHeight: 36 }}>×</button>
        </div>
        {error && <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}
        <div>
          <label style={labelStyle}>이름 *</label>
          <input value={form.name} onChange={set('name')} style={fieldStyle} placeholder="My Project" />
        </div>
        <div>
          <label style={labelStyle}>로컬 경로 *</label>
          <input value={form.path} onChange={set('path')} style={fieldStyle} placeholder="/Users/sun/my-project" />
        </div>
        <div>
          <label style={labelStyle}>기술 스택</label>
          <input value={form.stack} onChange={set('stack')} style={fieldStyle} placeholder="Next.js, TypeScript..." />
        </div>
        <div>
          <label style={labelStyle}>설명</label>
          <input value={form.description} onChange={set('description')} style={fieldStyle} placeholder="프로젝트 설명" />
        </div>
        <div>
          <label style={labelStyle}>GitHub</label>
          <input value={form.github} onChange={set('github')} style={fieldStyle} placeholder="sun2141/my-project" />
        </div>
        <div>
          <label style={labelStyle}>배포 URL</label>
          <input value={form.deploy} onChange={set('deploy')} style={fieldStyle} placeholder="my-project.vercel.app" />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: '12px', borderRadius: 10, border: '1px solid var(--border)',
            background: 'none', color: 'var(--text3)', fontSize: 14, cursor: 'pointer',
          }}>취소</button>
          <button onClick={handleSave} disabled={saving} style={{
            flex: 1, padding: '12px', borderRadius: 10, border: 'none',
            background: 'var(--accent)', color: '#fff', fontSize: 14,
            fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
          }}>{saving ? '저장 중...' : '저장'}</button>
        </div>
      </div>
    </div>
  )
}

// ── 프로젝트 카드 ─────────────────────────────────────────
function ProjectCard({ project, tasks, running, onClick, onEdit, onHide, onDelete, onForceDelete }) {
  const [showActions, setShowActions] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState(null) // { message, hasTasks, taskCount }

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
    <div style={{ position: 'relative' }}>
      <button onClick={() => { vibrate(); onClick() }} style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 16px', background: 'var(--bg2)',
        border: '1px solid var(--border)', borderRadius: 12,
        textAlign: 'left', width: '100%', minHeight: 64,
        WebkitTapHighlightColor: 'transparent', transition: 'opacity 0.1s, transform 0.1s',
        paddingRight: 44,
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
      </button>

      {/* 더보기 버튼 */}
      {!isInfra && (
        <button
          onClick={e => { e.stopPropagation(); vibrate(6); setShowActions(a => !a); setDeleteConfirm(false) }}
          style={{
            position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', color: 'var(--text3)', fontSize: 18,
            minWidth: 32, minHeight: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 8, cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
          }}
        >⋯</button>
      )}

      {/* 액션 드롭다운 */}
      {showActions && (
        <div style={{
          position: 'absolute', right: 4, top: '100%', marginTop: 4, zIndex: 100,
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)', padding: '6px 0', minWidth: 140,
        }}>
          <button onClick={e => { e.stopPropagation(); setShowActions(false); onEdit(project) }} style={{
            width: '100%', padding: '10px 16px', background: 'none', border: 'none',
            color: 'var(--text)', fontSize: 13, textAlign: 'left', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>✏️ 수정</button>
          <button onClick={e => { e.stopPropagation(); setShowActions(false); onHide(project.id, true) }} style={{
            width: '100%', padding: '10px 16px', background: 'none', border: 'none',
            color: 'var(--text)', fontSize: 13, textAlign: 'left', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>👁 숨기기</button>
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          {!deleteConfirm ? (
            <button onClick={e => { e.stopPropagation(); setDeleteConfirm(true); setDeleteError(null) }} style={{
              width: '100%', padding: '10px 16px', background: 'none', border: 'none',
              color: 'var(--red)', fontSize: 13, textAlign: 'left', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>🗑 삭제</button>
          ) : (
            <div style={{ padding: '8px 12px' }}>
              {deleteError ? (
                <>
                  <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{deleteError.message}</div>
                  {deleteError.hasTasks && (
                    <div style={{ display: 'flex', gap: 6, flexDirection: 'column' }}>
                      <button onClick={e => { e.stopPropagation(); setShowActions(false); setDeleteConfirm(false); setDeleteError(null); onForceDelete && onForceDelete(project.id) }} style={{
                        padding: '6px', borderRadius: 6, border: 'none',
                        background: 'var(--red)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      }}>작업 포함 강제 삭제</button>
                      <button onClick={e => { e.stopPropagation(); setDeleteConfirm(false); setDeleteError(null) }} style={{
                        padding: '6px', borderRadius: 6, border: '1px solid var(--border)',
                        background: 'none', color: 'var(--text3)', fontSize: 12, cursor: 'pointer',
                      }}>취소</button>
                    </div>
                  )}
                  {!deleteError.hasTasks && (
                    <button onClick={e => { e.stopPropagation(); setDeleteConfirm(false); setDeleteError(null) }} style={{
                      width: '100%', padding: '6px', borderRadius: 6, border: '1px solid var(--border)',
                      background: 'none', color: 'var(--text3)', fontSize: 12, cursor: 'pointer',
                    }}>닫기</button>
                  )}
                </>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>정말 삭제하시겠습니까?</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={e => { e.stopPropagation(); setDeleteConfirm(false) }} style={{
                      flex: 1, padding: '6px', borderRadius: 6, border: '1px solid var(--border)',
                      background: 'none', color: 'var(--text3)', fontSize: 12, cursor: 'pointer',
                    }}>취소</button>
                    <button onClick={async e => {
                      e.stopPropagation()
                      const result = await onDelete(project.id)
                      if (result?.error) {
                        setDeleteError({ message: result.error, hasTasks: result.hasTasks, taskCount: result.taskCount })
                      } else {
                        setShowActions(false); setDeleteConfirm(false)
                      }
                    }} style={{
                      flex: 1, padding: '6px', borderRadius: 6, border: 'none',
                      background: 'var(--red)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}>삭제</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* 드롭다운 닫기 오버레이 */}
      {showActions && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => { setShowActions(false); setDeleteConfirm(false) }} />
      )}
    </div>
  )
}

// ── 프로젝트 상세 ─────────────────────────────────────────
function ProjectDetail({ project, tasks, status, wsEvents, onRun, onStop, onResume, onDelete, onBack, fetchTaskLogs, fetchTaskFiles }) {
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [tab, setTab] = useState('tasks')
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [dbLogs, setDbLogs] = useState([])
  const [taskFiles, setTaskFiles] = useState(null) // { ok, files, commit_sha, total }
  const [taskFilesLoading, setTaskFilesLoading] = useState(false)
  const [attachedFiles, setAttachedFiles] = useState([]) // { name, text, _sourceType: 'file'|'folder'|'link', _url?, _hostname? }
  const [attachErr, setAttachErr] = useState('')
  const [showFolderPanel, setShowFolderPanel] = useState(false)
  const logRef = useRef(null)
  const autoScrollRef = useRef(true)
  const fileInputRef = useRef(null)
  const textareaRef = useRef(null)
  const resultRef = useRef(null)

  const PROMPT_MAX = 100000

  // textarea 높이 자동 조정 (최대 400px, 초과 시 스크롤)
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const newHeight = Math.min(el.scrollHeight, 400)
    el.style.height = newHeight + 'px'
    el.style.overflowY = el.scrollHeight > 400 ? 'auto' : 'hidden'
  }, [prompt])

  const projectTasks = [...tasks.filter(t => t.project_id === project.id)]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  const activeRuns = (status?.running || []).filter(r =>
    projectTasks.some(t => t.id === r.taskId)
  )
  const activeRun = activeRuns[0] || null
  const isRunning = activeRun !== null
  const pausedTask = projectTasks.find(t => t.status === 'paused')

  const targetTaskId = activeRun?.taskId || projectTasks[0]?.id || null

  useEffect(() => {
    if (tab !== 'logs' || !targetTaskId) return
    fetchTaskLogs(targetTaskId).then(setDbLogs)
  }, [tab, targetTaskId])

  useEffect(() => {
    if (tab !== 'logs' || !targetTaskId || !isRunning) return
    const timer = setInterval(() => {
      fetchTaskLogs(targetTaskId).then(setDbLogs)
    }, 5000)
    return () => clearInterval(timer)
  }, [tab, targetTaskId, isRunning])

  // 결과물 탭: 최신 완료 작업의 파일 목록 fetch
  const doneTask = projectTasks.find(t => t.status === 'done')
  useEffect(() => {
    if (tab !== 'results' || !doneTask) return
    setTaskFilesLoading(true)
    fetchTaskFiles(doneTask.id).then(data => {
      setTaskFiles(data)
      setTaskFilesLoading(false)
    }).catch(() => setTaskFilesLoading(false))
  }, [tab, doneTask?.id])

  // 작업 완료 시 결과 탭으로 자동 전환
  const projectTaskIdSet = new Set(projectTasks.map(t => t.id))
  const completeEventCount = wsEvents.filter(e => e.type === 'task:complete' && projectTaskIdSet.has(e.taskId)).length
  useEffect(() => {
    if (completeEventCount === 0) return
    setTab('results')
    setTimeout(() => {
      resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 300)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completeEventCount])

  const projectTaskIds = new Set(projectTasks.map(t => t.id))
  const wsLogs = wsEvents.filter(e =>
    e.taskId && projectTaskIds.has(e.taskId) &&
    ['agent:text', 'agent:tool', 'phase:start', 'phase:complete',
     'task:complete', 'task:failed', 'task:paused', 'task:created'].includes(e.type)
  )

  const logs = (() => {
    if (dbLogs.length === 0) return wsLogs
    if (wsLogs.length === 0) return dbLogs
    const dbBuckets = new Set(dbLogs.map(d => `${d.type}:${Math.floor((d.ts || 0) / 1000)}`))
    const wsOnly = wsLogs.filter(e => !dbBuckets.has(`${e.type}:${Math.floor((e.ts || 0) / 1000)}`))
    return [...dbLogs, ...wsOnly].sort((a, b) => (a.ts || 0) - (b.ts || 0))
  })()

  useEffect(() => {
    if (logRef.current && autoScrollRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  function handleLogScroll() {
    if (!logRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = logRef.current
    autoScrollRef.current = scrollTop + clientHeight >= scrollHeight - 40
  }

  // ── 파일 첨부 핸들러 ──────────────────────────────────────
  async function handleFileSelect(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setAttachErr('')

    const errors = []
    const newFiles = []

    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        errors.push(`${file.name}: 5MB 초과`)
        continue
      }
      const isText = file.type.startsWith('text/') || TEXT_EXTENSIONS.test(file.name)
      if (!isText) {
        errors.push(`${file.name}: 텍스트·코드 파일만 지원`)
        continue
      }
      try {
        const text = await readFileAsText(file)
        newFiles.push({ name: file.name, text, _sourceType: 'file' })
      } catch {
        errors.push(`${file.name}: 읽기 실패`)
      }
    }

    if (newFiles.length) setAttachedFiles(prev => [...prev, ...newFiles])
    if (errors.length) setAttachErr(errors.join(' · '))
    e.target.value = ''
  }

  const handleRun = async () => {
    if (!prompt.trim() || sending || isRunning) return
    setSending(true)
    try {
      const attachments = attachedFiles.length > 0
        ? attachedFiles.map(f => ({ type: 'text', name: f.name, text: f.text }))
        : undefined
      await onRun(project.id, prompt.trim(), attachments)
      setPrompt('')
      setAttachedFiles([])
      setAttachErr('')
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

  // 폴더 패널에서 파일이 준비됐을 때 호출
  function handleFolderFilesReady(files) {
    setShowFolderPanel(false)
    // { name, path, text } 배열 → attachedFiles 형식으로 변환
    const newFiles = files.map(f => ({ name: f.path || f.name, text: f.text, _sourceType: 'folder' }))
    setAttachedFiles(prev => {
      const merged = [...prev, ...newFiles]
      const MAX = 200
      if (merged.length > MAX) {
        const omitted = merged.length - MAX
        setAttachErr(`파일이 많아 ${MAX}개까지만 추가되었습니다 (${omitted}개 생략)`)
        return merged.slice(0, MAX)
      }
      if (files.length > 50) {
        setAttachErr(`총 ${merged.length}개 파일이 추가되었습니다. 컨텍스트 토큰 한도에 주의하세요.`)
      }
      return merged
    })
  }

  // 링크 첨부 핸들러
  function handleLinkReady({ url, title, hostname }) {
    setShowFolderPanel(false)
    const linkText = `[링크] ${title}\nURL: ${url}`
    setAttachedFiles(prev => [...prev, { name: title, text: linkText, _sourceType: 'link', _url: url, _hostname: hostname }])
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {showFolderPanel && (
        <FolderUploadPanel
          onFilesReady={handleFolderFilesReady}
          onLinkReady={handleLinkReady}
          onClose={() => setShowFolderPanel(false)}
        />
      )}
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

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 8px', flexShrink: 0, overflowX: 'auto' }}>
        {[['tasks', '작업 이력'], ['logs', '로그'], ['results', '결과물']].map(([key, label]) => (
          <button key={key} onClick={() => { vibrate(8); setTab(key) }} style={{
            background: 'none', border: 'none', padding: '12px 14px', fontSize: 13,
            color: tab === key ? 'var(--text)' : 'var(--text3)',
            borderBottom: tab === key ? '2px solid var(--accent)' : '2px solid transparent',
            fontWeight: tab === key ? 600 : 400,
            minHeight: 48, WebkitTapHighlightColor: 'transparent', whiteSpace: 'nowrap',
            position: 'relative',
          }}>
            {label}
            {key === 'results' && doneTask && tab !== 'results' && (
              <span style={{
                position: 'absolute', top: 8, right: 4, width: 6, height: 6, borderRadius: '50%',
                background: 'var(--green)', boxShadow: '0 0 4px var(--green)',
              }} />
            )}
          </button>
        ))}
        {logs.length > 0 && tab === 'tasks' && (
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
                <TaskReport task={t} onViewResults={t.status === 'done' ? () => { vibrate(8); setTab('results') } : undefined} />
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

        {/* ── 결과물 탭 ── */}
        <div style={{
          position: 'absolute', inset: 0, overflowY: 'auto',
          padding: '12px 16px',
          visibility: tab === 'results' ? 'visible' : 'hidden',
        }}>
          <div ref={resultRef}>
            {!doneTask ? (
              <div style={{ color: 'var(--text3)', marginTop: 40, textAlign: 'center', fontSize: 13 }}>
                {isRunning ? '작업 실행 중... 완료 후 결과물이 여기에 표시됩니다' : '완료된 작업이 없습니다'}
              </div>
            ) : (
              <TaskResultPanel
                task={doneTask}
                files={taskFiles}
                loading={taskFilesLoading}
                onRefresh={() => {
                  setTaskFilesLoading(true)
                  fetchTaskFiles(doneTask.id).then(data => {
                    setTaskFiles(data)
                    setTaskFilesLoading(false)
                  })
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── 하단 입력 영역 ── */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0 }}>
        {isRunning && (
          <div style={{ fontSize: 11, color: 'var(--blue)', marginBottom: 8, textAlign: 'center' }}>
            작업 실행 중에는 새 작업을 시작할 수 없습니다
          </div>
        )}

        {/* 첨부된 파일명 표시 */}
        {attachedFiles.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                📎 {attachedFiles.length}개 항목 첨부됨
              </span>
              <button
                onClick={() => { setAttachedFiles([]); setAttachErr('') }}
                style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: 13, cursor: 'pointer', padding: '2px 6px', borderRadius: 6 }}
              >전체 삭제</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {attachedFiles.slice(0, 20).map((f, i) => {
                const srcIcon = f._sourceType === 'folder' ? '📁' : f._sourceType === 'link' ? '🔗' : '📄'
                const badgeBg = f._sourceType === 'link'
                  ? 'rgba(34,197,94,0.12)'
                  : f._sourceType === 'folder'
                    ? 'rgba(251,146,60,0.12)'
                    : 'rgba(107,94,248,0.15)'
                const badgeBorder = f._sourceType === 'link'
                  ? 'rgba(34,197,94,0.35)'
                  : f._sourceType === 'folder'
                    ? 'rgba(251,146,60,0.35)'
                    : 'rgba(107,94,248,0.3)'
                const badgeColor = f._sourceType === 'link'
                  ? 'var(--green, #22c55e)'
                  : f._sourceType === 'folder'
                    ? 'var(--orange, #fb923c)'
                    : 'var(--accent2)'
                return (
                  <span key={i} style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 12,
                    background: badgeBg, color: badgeColor,
                    border: `1px solid ${badgeBorder}`,
                    display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                  }} onClick={() => setAttachedFiles(prev => prev.filter((_, idx) => idx !== i))}
                     title={f._url || f.name}>
                    {srcIcon} <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.name.length > 20 ? f.name.slice(0, 10) + '…' + f.name.slice(-8) : f.name}
                    </span>
                    <span style={{ opacity: 0.6, fontSize: 12 }}>×</span>
                  </span>
                )
              })}
              {attachedFiles.length > 20 && (
                <span style={{ fontSize: 11, color: 'var(--text3)', padding: '2px 6px' }}>+{attachedFiles.length - 20}개 더</span>
              )}
            </div>
          </div>
        )}

        {/* 에러 메시지 */}
        {attachErr && (
          <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 6 }}>{attachErr}</div>
        )}

        {/* 숨김 파일 input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".md,.txt,.json,.js,.ts,.jsx,.tsx,.py,.yaml,.yml,.html,.css,.sh,.env,.toml,.xml,.sql,.java,.c,.cpp,.h,.go,.rs,.rb,.php,.swift,.kt,.vue,.svelte,.prisma,.graphql,.csv,.log,.conf,.ini"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />

        {/* 입력 행: 📎 📁 | textarea | ↑ */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          {/* 파일·폴더 첨부 버튼 묶음 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
            {/* 파일 첨부 버튼 */}
            <button
              onClick={() => { vibrate(8); fileInputRef.current?.click() }}
              disabled={isRunning}
              title="파일 첨부 (텍스트·코드 파일)"
              style={{
                background: attachedFiles.length > 0 ? 'rgba(107,94,248,0.2)' : 'var(--bg3)',
                border: '1px solid ' + (attachedFiles.length > 0 ? 'rgba(107,94,248,0.5)' : 'var(--border)'),
                borderRadius: 10, minWidth: 44, minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, flexShrink: 0,
                opacity: isRunning ? 0.3 : 1,
                WebkitTapHighlightColor: 'transparent',
                cursor: isRunning ? 'default' : 'pointer',
              }}
            >📎</button>
            {/* 폴더/클라우드 첨부 버튼 */}
            <button
              onClick={() => { vibrate(8); setShowFolderPanel(true) }}
              disabled={isRunning}
              title="폴더·Google Drive·Dropbox 첨부"
              style={{
                background: 'var(--bg3)',
                border: '1px solid var(--border)',
                borderRadius: 10, minWidth: 44, minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, flexShrink: 0,
                opacity: isRunning ? 0.3 : 1,
                WebkitTapHighlightColor: 'transparent',
                cursor: isRunning ? 'default' : 'pointer',
              }}
            >📁</button>
          </div>

          <div style={{ flex: 1, position: 'relative' }}>
            <textarea
              ref={textareaRef}
              id={`prompt-${project.id}`}
              name={`prompt-${project.id}`}
              value={prompt}
              onChange={e => setPrompt(e.target.value.slice(0, PROMPT_MAX))}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRun() } }}
              placeholder={isRunning ? '실행 중...' : '작업 지시 입력 (Enter 실행, Shift+Enter 줄바꿈)'}
              disabled={isRunning}
              rows={2}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: isRunning ? 'var(--bg)' : 'var(--bg3)',
                border: '1px solid ' + (prompt.length >= PROMPT_MAX * 0.95 ? 'var(--red, #ff5555)' : 'var(--border)'),
                borderRadius: 10,
                padding: '12px 14px', paddingBottom: prompt.length > 200 ? '24px' : '12px',
                color: 'var(--text)',
                fontSize: 16, resize: 'none', outline: 'none',
                opacity: isRunning ? 0.4 : 1,
                minHeight: 52, overflowY: 'hidden',
              }}
            />
            {prompt.length > 200 && (
              <span style={{
                position: 'absolute', bottom: 6, right: 10,
                fontSize: 11, color: prompt.length >= PROMPT_MAX * 0.95 ? 'var(--red, #ff5555)' : 'var(--text3)',
                pointerEvents: 'none', userSelect: 'none',
              }}>
                {prompt.length.toLocaleString()} / {PROMPT_MAX.toLocaleString()}
              </span>
            )}
            {prompt.length >= 50000 && (
              <div style={{
                position: 'absolute', top: 6, left: 10,
                fontSize: 10, color: 'var(--orange, #f59e0b)',
                background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)',
                borderRadius: 6, padding: '2px 7px',
                pointerEvents: 'none', userSelect: 'none',
              }}>
                ⚠ 토큰 한도 근접 (한글 ~50K자)
              </div>
            )}
          </div>
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

// ── 프로젝트 등록 모달 ────────────────────────────────────
function RegisterProjectModal({ onAdd, onCreate, onClose, onRestoreHidden }) {
  const [mode, setMode] = useState('register') // 'register' | 'create'
  const [form, setForm] = useState({
    id: '', name: '', path: '', stack: '', description: '',
    github: '', deploy: '',
    githubRepo: true,
    githubPrivate: 'private',
  })
  const [idEdited, setIdEdited] = useState(false) // 사용자가 ID를 직접 수정했는지
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState(null)
  const [hiddenConflict, setHiddenConflict] = useState(null) // { existingId, existingName }

  const set = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm(f => ({ ...f, [key]: val }))
  }

  const handleIdChange = (e) => {
    setIdEdited(true)
    setForm(f => ({ ...f, id: e.target.value }))
  }

  const handleNameChange = (e) => {
    const name = e.target.value
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    setForm(f => ({
      ...f,
      name,
      // ID를 직접 수정하지 않은 경우에만 자동 채움
      id: idEdited ? f.id : slug,
      path: f.path && f.path !== `/Users/sun/${f.id}` ? f.path : (slug ? `/Users/sun/${slug}` : ''),
    }))
  }

  const handleSubmit = async () => {
    if (!form.id.trim()) { setError('프로젝트 ID는 필수입니다'); return }
    if (!/^[a-z0-9-]{1,50}$/.test(form.id.trim())) {
      setError('프로젝트 ID: 영문 소문자/숫자/하이픈만 허용 (최대 50자)')
      return
    }
    if (!form.name.trim()) { setError('프로젝트 이름은 필수입니다'); return }
    if (!form.path.trim()) { setError('로컬 경로는 필수입니다'); return }
    setError('')
    setSaving(true)
    setResult(null)

    try {
      const payload = {
        id: form.id.trim(),
        name: form.name.trim(),
        path: form.path.trim(),
        stack: form.stack.trim() || undefined,
        description: form.description.trim() || undefined,
        github: form.github.trim() || undefined,
        deploy: form.deploy.trim() || undefined,
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
        if (res.hidden && res.existingId) {
          // 숨겨진 프로젝트와 ID 충돌 → 복원 안내
          setHiddenConflict({ existingId: res.existingId, existingName: res.existingName })
        } else {
          setError(res.error)
        }
      } else {
        setResult(res)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleRestoreHidden = async () => {
    if (!hiddenConflict) return
    setSaving(true)
    try {
      const result = await onRestoreHidden(hiddenConflict.existingId)
      if (result?.error) {
        setError(result.error)
        setHiddenConflict(null)
      } else {
        setHiddenConflict(null)
        setResult({ id: hiddenConflict.existingId, name: hiddenConflict.existingName, _restored: true })
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

  // 배경 오버레이 클릭 시 닫기
  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div style={{
        width: '100%', maxWidth: 480, maxHeight: '90dvh',
        background: 'var(--bg2)', borderRadius: '16px 16px 0 0',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 -8px 40px rgba(0,0,0,0.5)',
      }}>
        {/* 헤더 */}
        <div style={{
          display: 'flex', alignItems: 'center', padding: '16px 16px 12px',
          borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>새 프로젝트 등록</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--text3)',
            fontSize: 22, minWidth: 40, minHeight: 40, display: 'flex',
            alignItems: 'center', justifyContent: 'center', borderRadius: 8,
            WebkitTapHighlightColor: 'transparent',
          }}>×</button>
        </div>

        {hiddenConflict ? (
          /* 숨겨진 프로젝트 충돌 화면 */
          <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--orange)' }}>⚠️ 숨겨진 프로젝트 있음</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
              <b>{hiddenConflict.existingName}</b> (<code style={{ fontSize: 11 }}>{hiddenConflict.existingId}</code>) 프로젝트가 이미 숨겨진 상태로 존재합니다.
              <br />복원하시겠습니까?
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={handleRestoreHidden} disabled={saving} style={{
                padding: '13px', borderRadius: 8, border: 'none',
                background: 'var(--accent)', color: 'white', fontSize: 14, fontWeight: 600,
                opacity: saving ? 0.5 : 1, minHeight: 52, cursor: saving ? 'not-allowed' : 'pointer',
              }}>{saving ? '복원 중…' : '복원 (보이기)'}</button>
              <button onClick={() => setHiddenConflict(null)} style={{
                padding: '13px', borderRadius: 8, border: '1px solid var(--border)',
                background: 'none', color: 'var(--text3)', fontSize: 14, minHeight: 52,
              }}>취소 (다른 ID 사용)</button>
            </div>
          </div>
        ) : result ? (
          /* 완료 화면 */
          <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)', marginBottom: 10 }}>
              {result._restored ? '✅ 프로젝트 복원 완료' : (mode === 'create' ? '✅ 프로젝트 생성 완료' : '✅ 프로젝트 등록 완료')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.8 }}>
              {mode === 'create' ? (
                <>
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
                </>
              ) : (
                <>
                  <div>프로젝트 ID: <span style={{ color: 'var(--accent2)' }}>{result.id}</span></div>
                  <div>이름: <span style={{ color: 'var(--text)' }}>{result.name}</span></div>
                  <div>경로: <span style={{ color: 'var(--text2)', fontSize: 11 }}>{result.path}</span></div>
                  <div>DB 등록: <span style={{ color: 'var(--green)' }}>✓</span></div>
                </>
              )}
              {result.claudeMd && (
                <div>CLAUDE.md: <span style={{ color: result.claudeMd.ok ? 'var(--green)' : 'var(--orange)' }}>
                  {result.claudeMd.ok ? '✓ 레지스트리 업데이트됨' : `△ ${result.claudeMd.reason || '스킵'}`}
                </span></div>
              )}
              {result.directive && (
                <div>Directive: <span style={{ color: result.directive.ok ? 'var(--green)' : 'var(--orange)' }}>
                  {result.directive.ok ? '✓ directives/projects 파일 생성됨' : `△ ${result.directive.reason || '스킵'}`}
                </span></div>
              )}
              {result.projectClaudeMd && (
                <div>프로젝트 CLAUDE.md: <span style={{ color: result.projectClaudeMd.ok ? 'var(--green)' : 'var(--orange)' }}>
                  {result.projectClaudeMd.ok ? '✓ 프로젝트 폴더에 생성됨' : `△ ${result.projectClaudeMd.reason || '스킵'}`}
                </span></div>
              )}
            </div>
            <button onClick={() => { vibrate(10); onClose() }} style={{
              marginTop: 16, width: '100%', background: 'var(--accent)', border: 'none',
              borderRadius: 8, padding: '13px', color: 'white', fontSize: 14, fontWeight: 600,
              minHeight: 52, WebkitTapHighlightColor: 'transparent',
            }}>닫기</button>
          </div>
        ) : (
          <>
            {/* 스크롤 가능한 폼 영역 */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* 모드 탭 */}
              <div style={{ display: 'flex', gap: 4 }}>
                {[['register', '기존 프로젝트 등록'], ['create', '새 폴더 생성']].map(([m, label]) => (
                  <button key={m} onClick={() => { vibrate(8); setMode(m) }} style={{
                    flex: 1, background: mode === m ? 'rgba(107,94,248,0.2)' : 'none',
                    border: '1px solid ' + (mode === m ? 'rgba(107,94,248,0.5)' : 'var(--border)'),
                    borderRadius: 8, padding: '10px 6px', color: mode === m ? 'var(--accent2)' : 'var(--text3)',
                    fontSize: 13, fontWeight: mode === m ? 600 : 400,
                    minHeight: 44, WebkitTapHighlightColor: 'transparent',
                  }}>{label}</button>
                ))}
              </div>

              {/* 프로젝트 ID */}
              <div>
                <label style={labelStyle}>프로젝트 ID <span style={{ color: 'var(--red)' }}>*</span></label>
                <input
                  value={form.id}
                  onChange={handleIdChange}
                  placeholder="my-project (소문자, 숫자, 하이픈)"
                  style={fieldStyle}
                />
              </div>

              {/* 이름 */}
              <div>
                <label style={labelStyle}>프로젝트 이름 *</label>
                <input value={form.name} onChange={handleNameChange} placeholder="My Project" style={fieldStyle} />
              </div>

              {/* 로컬 경로 */}
              <div>
                <label style={labelStyle}>로컬 경로 *</label>
                <input value={form.path} onChange={set('path')} placeholder="/Users/sun/my-project" style={fieldStyle} />
              </div>

              {/* 스택 */}
              <div>
                <label style={labelStyle}>스택</label>
                <input value={form.stack} onChange={set('stack')} placeholder="Next.js, Supabase, …" style={fieldStyle} />
              </div>

              {/* 설명 */}
              <div>
                <label style={labelStyle}>설명</label>
                <input value={form.description} onChange={set('description')} placeholder="한 줄 설명" style={fieldStyle} />
              </div>

              {/* GitHub URL */}
              <div>
                <label style={labelStyle}>GitHub <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(선택)</span></label>
                <input value={form.github} onChange={set('github')} placeholder="sun2141/my-project" style={fieldStyle} />
              </div>

              {/* 배포 URL */}
              <div>
                <label style={labelStyle}>배포 URL <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(선택)</span></label>
                <input value={form.deploy} onChange={set('deploy')} placeholder="my-project.vercel.app" style={fieldStyle} />
              </div>

              {/* 새 폴더 생성 모드: GitHub 연동 옵션 */}
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
            </div>

            {/* 하단 버튼 */}
            <div style={{
              padding: '12px 16px', borderTop: '1px solid var(--border)',
              display: 'flex', gap: 8, flexShrink: 0,
            }}>
              <button onClick={() => { vibrate(15); handleSubmit() }} disabled={saving} style={{
                flex: 1, background: 'var(--accent)', border: 'none', borderRadius: 8,
                padding: '13px', color: 'white', fontSize: 14, fontWeight: 600,
                opacity: saving ? 0.5 : 1, minHeight: 52, WebkitTapHighlightColor: 'transparent',
              }}>{saving ? '저장 중…' : (mode === 'create' ? '프로젝트 생성' : '등록')}</button>
              <button onClick={() => { vibrate(8); onClose() }} style={{
                background: 'none', border: '1px solid var(--border)', borderRadius: 8,
                padding: '13px 18px', color: 'var(--text3)', fontSize: 14,
                minHeight: 52, WebkitTapHighlightColor: 'transparent',
              }}>취소</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── 결과물 패널 (결과물 탭 전용) ──────────────────────────
const API_KEY_FOR_DL = import.meta.env.VITE_API_KEY || ''
const _API_BASE_FOR_DL = import.meta.env.VITE_API_BASE_URL || ''
const API_BASE_FOR_DL = _API_BASE_FOR_DL ? `${_API_BASE_FOR_DL}/api` : '/api'

const FILE_STATUS_LABEL = { A: '추가', M: '수정', D: '삭제', R: '이름변경' }
const FILE_STATUS_COLOR = { A: 'var(--green)', M: 'var(--blue)', D: 'var(--red)', R: 'var(--orange)' }


function TaskResultPanel({ task, files, loading, onRefresh }) {
  let evalResult = null
  if (task.eval_result) {
    try { evalResult = JSON.parse(task.eval_result) } catch { evalResult = { raw: task.eval_result } }
  }
  const passed = evalResult?.passed ?? evalResult?.success ?? evalResult?.result === 'pass'

  function handleDownload(filePath, fileName) {
    const url = `${API_BASE_FOR_DL}/tasks/${task.id}/files/download?filePath=${encodeURIComponent(filePath)}`
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    // API 키를 헤더로 보내기 위해 fetch로 blob 다운로드
    fetch(url, { headers: { 'x-api-key': API_KEY_FOR_DL } })
      .then(r => {
        if (!r.ok) throw new Error('다운로드 실패')
        return r.blob()
      })
      .then(blob => {
        const objectUrl = URL.createObjectURL(blob)
        a.href = objectUrl
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      })
      .catch(err => alert(`다운로드 실패: ${err.message}`))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 상태 배너 */}
      <div style={{
        padding: '14px 16px',
        background: task.status === 'done' ? 'rgba(61,214,140,0.08)' : 'rgba(248,113,113,0.08)',
        border: '1px solid ' + (task.status === 'done' ? 'rgba(61,214,140,0.3)' : 'rgba(248,113,113,0.3)'),
        borderRadius: 12,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: task.status === 'done' ? 'var(--green)' : 'var(--red)' }}>
            {task.status === 'done' ? '✅ 작업 완료' : '❌ 작업 실패'}
          </span>
          {task.round > 0 && (
            <span style={{
              fontSize: 12, padding: '2px 8px', borderRadius: 20,
              background: 'rgba(107,94,248,0.12)', color: 'var(--accent2)',
              border: '1px solid rgba(107,94,248,0.25)',
            }}>{task.round}/{task.max_rounds} 라운드</span>
          )}
          {evalResult && (
            <span style={{
              fontSize: 12, padding: '2px 8px', borderRadius: 20, fontWeight: 600,
              background: passed ? 'rgba(61,214,140,0.12)' : 'rgba(248,113,113,0.12)',
              color: passed ? 'var(--green)' : 'var(--red)',
              border: '1px solid ' + (passed ? 'rgba(61,214,140,0.3)' : 'rgba(248,113,113,0.3)'),
            }}>Eval: {passed ? '합격' : '불합격'}</span>
          )}
          {evalResult?.score !== undefined && (
            <span style={{
              fontSize: 13, fontWeight: 700,
              color: evalResult.score >= 70 ? 'var(--green)' : evalResult.score >= 40 ? 'var(--orange)' : 'var(--red)',
            }}>{evalResult.score}/100점</span>
          )}
        </div>
        {evalResult?.summary && (
          <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.6 }}>
            {evalResult.summary}
          </div>
        )}
        {task.error && (
          <div style={{ fontSize: 12, color: 'var(--red)', wordBreak: 'break-word' }}>
            오류: {task.error}
          </div>
        )}
        {task.commit_sha && (
          <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
            커밋: {task.commit_sha.slice(0, 12)}
          </div>
        )}
      </div>

      {/* 수정된 파일 목록 */}
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 14px', borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>수정된 파일</span>
            {files?.files && (
              <span style={{
                fontSize: 11, padding: '1px 7px', borderRadius: 10,
                background: 'rgba(107,94,248,0.12)', color: 'var(--accent2)',
                border: '1px solid rgba(107,94,248,0.25)',
              }}>{files.files.length}개</span>
            )}
          </div>
          <button
            onClick={onRefresh}
            disabled={loading}
            style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 8,
              color: 'var(--text3)', fontSize: 12, padding: '5px 10px', minHeight: 30,
              cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1,
              WebkitTapHighlightColor: 'transparent',
            }}
          >{loading ? '로딩...' : '새로고침'}</button>
        </div>

        {loading ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
            파일 목록 불러오는 중...
          </div>
        ) : files?.error ? (
          <div style={{ padding: '14px', color: 'var(--red)', fontSize: 12 }}>
            {files.error}
          </div>
        ) : !files?.files?.length ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
            {files ? '수정된 파일이 없거나 git 정보를 가져올 수 없습니다' : '결과물 탭을 열면 파일 목록을 불러옵니다'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {files.files.map((f, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px',
                borderBottom: i < files.files.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, minWidth: 28, textAlign: 'center',
                  padding: '2px 5px', borderRadius: 4,
                  color: FILE_STATUS_COLOR[f.status?.[0]] || 'var(--text3)',
                  background: (FILE_STATUS_COLOR[f.status?.[0]] || 'var(--text3)') + '18',
                  border: '1px solid ' + (FILE_STATUS_COLOR[f.status?.[0]] || 'var(--border)') + '40',
                  flexShrink: 0,
                }}>{FILE_STATUS_LABEL[f.status?.[0]] || f.status}</span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 12, fontWeight: 600, color: 'var(--text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontFamily: 'var(--mono)',
                  }} title={f.path}>{f.name}</div>
                  {f.path !== f.name && (
                    <div style={{
                      fontSize: 10, color: 'var(--text3)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={f.path}>{f.path}</div>
                  )}
                </div>

                {f.size > 0 && (
                  <span style={{ fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}>
                    {f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)}MB` : f.size > 1024 ? `${(f.size / 1024).toFixed(0)}KB` : `${f.size}B`}
                  </span>
                )}

                <button
                  onClick={() => { vibrate(10); handleDownload(f.path, f.name) }}
                  title={`${f.name} 다운로드`}
                  style={{
                    background: 'rgba(107,94,248,0.12)', border: '1px solid rgba(107,94,248,0.3)',
                    borderRadius: 8, padding: '6px 10px', color: 'var(--accent2)',
                    fontSize: 12, fontWeight: 600, flexShrink: 0,
                    cursor: 'pointer', minHeight: 32, display: 'flex', alignItems: 'center', gap: 4,
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  ↓ 다운
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 플랜 요약 */}
      {task.plan && task.plan.trim() && (
        <details style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <summary style={{
            padding: '12px 14px', fontSize: 13, fontWeight: 600,
            cursor: 'pointer', userSelect: 'none', color: 'var(--text)',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span>플랜 상세보기</span>
          </summary>
          <div style={{
            padding: '12px 14px', paddingTop: 0,
            fontSize: 12, color: 'var(--text2)', lineHeight: 1.7,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontFamily: 'var(--mono)', maxHeight: 300, overflowY: 'auto',
          }}>
            {task.plan.slice(0, 2000)}{task.plan.length > 2000 ? '\n…' : ''}
          </div>
        </details>
      )}
    </div>
  )
}

// ── 리포트 섹션 (작업 이력 카드 내 간략 표시) ────────────
function TaskReport({ task, onViewResults }) {
  if (!['done', 'failed'].includes(task.status)) return null

  let evalResult = null
  if (task.eval_result) {
    try { evalResult = JSON.parse(task.eval_result) } catch { evalResult = { raw: task.eval_result } }
  }

  const passed = evalResult?.passed ?? evalResult?.success ?? evalResult?.result === 'pass'

  return (
    <div style={{
      marginTop: 8, padding: '10px 12px', background: 'var(--bg)',
      border: '1px solid var(--border)', borderRadius: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 20, fontWeight: 600,
          background: task.status === 'done' ? 'rgba(61,214,140,0.15)' : 'rgba(248,113,113,0.15)',
          color: task.status === 'done' ? 'var(--green)' : 'var(--red)',
          border: '1px solid ' + (task.status === 'done' ? 'rgba(61,214,140,0.4)' : 'rgba(248,113,113,0.4)'),
        }}>{task.status === 'done' ? '완료' : '실패'}</span>

        {evalResult && (
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 20, fontWeight: 600,
            background: passed ? 'rgba(61,214,140,0.12)' : 'rgba(248,113,113,0.12)',
            color: passed ? 'var(--green)' : 'var(--red)',
            border: '1px solid ' + (passed ? 'rgba(61,214,140,0.3)' : 'rgba(248,113,113,0.3)'),
          }}>Eval: {passed ? '합격' : '불합격'}{evalResult?.score !== undefined ? ` (${evalResult.score}/100)` : ''}</span>
        )}

        {onViewResults && task.status === 'done' && (
          <button
            onClick={() => { vibrate(8); onViewResults() }}
            style={{
              marginLeft: 'auto', background: 'rgba(61,214,140,0.1)', border: '1px solid rgba(61,214,140,0.35)',
              borderRadius: 8, padding: '4px 10px', color: 'var(--green)',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', minHeight: 26,
              display: 'flex', alignItems: 'center', gap: 4,
              WebkitTapHighlightColor: 'transparent',
            }}
          >결과물 보기 →</button>
        )}
      </div>

      {evalResult?.summary && (
        <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.5, marginTop: 6 }}>
          {evalResult.summary}
        </div>
      )}

      {task.error && (
        <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 6, wordBreak: 'break-word' }}>
          오류: {task.error}
        </div>
      )}
    </div>
  )
}

// ── 메인 ─────────────────────────────────────────────────
export default function App() {
  const { projects, tasks, status, connected, wsEvents, runTask, stopTask, resumeTask, deleteTask, fetchTaskLogs, fetchTaskFiles, addProject, createProject, updateProject, deleteProject, forceDeleteProject, toggleProjectVisibility, refresh } = useHarness()
  const [view, setView]               = useState('list')
  const [selected, setSelected]       = useState(null)
  const [showRegisterModal, setShowRegisterModal] = useState(false)
  const [editingProject, setEditingProject] = useState(null)
  const [showHidden, setShowHidden]   = useState(false)

  const productProjects = projects.filter(p => !INFRA_IDS.includes(p.id) && !p.hidden)
  const infraProjects   = projects.filter(p =>  INFRA_IDS.includes(p.id))
  const hiddenProjects  = projects.filter(p => !INFRA_IDS.includes(p.id) &&  p.hidden)
  const running = status?.running || []

  const handleRun = async (projectId, prompt, attachments) => {
    const result = await runTask(projectId, prompt, 10, attachments)
    if (result?.taskId) setTimeout(refresh, 500)
    return result
  }

  const handleRegisterClose = () => {
    setShowRegisterModal(false)
    refresh()
  }

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto', background: 'var(--bg)' }}>
      <StatusBar status={status} connected={connected} onRefresh={refresh} />

      {/* 프로젝트 등록 모달 */}
      {showRegisterModal && (
        <RegisterProjectModal
          onAdd={addProject}
          onCreate={createProject}
          onClose={handleRegisterClose}
          onRestoreHidden={async (id) => {
            const result = await toggleProjectVisibility(id, false)
            return result
          }}
        />
      )}

      {/* 프로젝트 수정 모달 */}
      {editingProject && (
        <EditProjectModal
          project={editingProject}
          onSave={updateProject}
          onClose={() => setEditingProject(null)}
        />
      )}

      {view === 'detail' && selected ? (
        <ProjectDetail
          project={selected} tasks={tasks} status={status} wsEvents={wsEvents}
          onRun={handleRun}
          onStop={async id => { await stopTask(id); refresh() }}
          onResume={async id => { await resumeTask(id); refresh() }}
          onDelete={async id => { await deleteTask(id); refresh() }}
          onBack={() => setView('list')}
          fetchTaskLogs={fetchTaskLogs}
          fetchTaskFiles={fetchTaskFiles}
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
            <button onClick={() => { vibrate(8); setShowRegisterModal(true) }} style={{
              background: 'rgba(107,94,248,0.1)',
              border: '1px solid rgba(107,94,248,0.3)',
              borderRadius: 8, padding: '0 12px', height: 36, display: 'flex', alignItems: 'center', gap: 5,
              color: 'var(--accent2)', fontSize: 12, fontWeight: 600, lineHeight: 1,
              WebkitTapHighlightColor: 'transparent', whiteSpace: 'nowrap',
            }}>
              <span style={{ fontSize: 16, marginTop: -1 }}>+</span>
              <span>새 프로젝트 등록</span>
            </button>
          </div>
          <div className="project-list" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
            {productProjects.map(p => (
              <ProjectCard key={p.id} project={p} tasks={tasks} running={running}
                onClick={() => { setSelected(p); setView('detail') }}
                onEdit={setEditingProject}
                onHide={async (id, hidden) => { await toggleProjectVisibility(id, hidden) }}
                onDelete={async (id) => { return await deleteProject(id) }}
                onForceDelete={async (id) => { await forceDeleteProject(id) }}
              />
            ))}
            {productProjects.length === 0 && !showRegisterModal && (
              <div style={{ color: 'var(--text3)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>연결 중...</div>
            )}
          </div>

          {/* 숨긴 프로젝트 섹션 */}
          {hiddenProjects.length > 0 && (
            <>
              <button
                onClick={() => { vibrate(6); setShowHidden(h => !h) }}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  display: 'flex', alignItems: 'center', gap: 6,
                  color: 'var(--text3)', fontSize: 11, fontWeight: 600,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  marginBottom: showHidden ? 8 : 16, cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <span style={{ fontSize: 10 }}>{showHidden ? '▼' : '▶'}</span>
                숨긴 프로젝트 ({hiddenProjects.length})
              </button>
              {showHidden && (
                <div className="project-list" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24, opacity: 0.65 }}>
                  {hiddenProjects.map(p => (
                    <div key={p.id} style={{ position: 'relative' }}>
                      <button onClick={() => { setSelected(p); setView('detail') }} style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '12px 16px', background: 'var(--bg2)',
                        border: '1px solid var(--border)', borderRadius: 12,
                        textAlign: 'left', width: '100%', minHeight: 56,
                        WebkitTapHighlightColor: 'transparent', paddingRight: 96,
                      }}>
                        <div style={{
                          width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                          background: 'rgba(80,80,100,0.2)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
                          border: '1px solid rgba(80,80,100,0.3)',
                        }}>{p.name[0]}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)' }}>{p.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>{p.stack || p.description || ''}</div>
                        </div>
                      </button>
                      <div style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: 4 }}>
                        <button onClick={() => setEditingProject(p)} style={{
                          background: 'rgba(107,94,248,0.1)', border: '1px solid rgba(107,94,248,0.3)',
                          borderRadius: 6, padding: '4px 8px', color: 'var(--accent2)', fontSize: 11, cursor: 'pointer',
                        }}>수정</button>
                        <button onClick={async () => { await toggleProjectVisibility(p.id, false) }} style={{
                          background: 'rgba(61,214,140,0.1)', border: '1px solid rgba(61,214,140,0.3)',
                          borderRadius: 6, padding: '4px 8px', color: 'var(--green)', fontSize: 11, cursor: 'pointer',
                        }}>보이기</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {infraProjects.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', letterSpacing: '0.08em', marginBottom: 8, textTransform: 'uppercase' }}>인프라</div>
              <div className="project-list" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                {infraProjects.map(p => (
                  <ProjectCard key={p.id} project={p} tasks={tasks} running={running}
                    onClick={() => { setSelected(p); setView('detail') }}
                    onEdit={setEditingProject}
                    onHide={async (id, hidden) => { await toggleProjectVisibility(id, hidden) }}
                    onDelete={async (id) => { return await deleteProject(id) }}
                    onForceDelete={async (id) => { await forceDeleteProject(id) }}
                  />
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
        button:active {
          opacity: 0.6;
          transform: scale(0.96);
          transition: opacity 0.05s, transform 0.05s !important;
        }
        button:not(:active) {
          transition: opacity 0.15s, transform 0.15s;
        }
        button[data-card]:active {
          background: var(--bg3) !important;
        }
        @media (max-width: 768px) {
          .task-result-grid { flex-direction: column !important; }
          .file-row { flex-wrap: wrap !important; gap: 6px !important; }
          .file-row button { width: 100% !important; justify-content: center !important; }
          .tab-bar { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; }
          .tab-bar button { flex-shrink: 0 !important; }
          .details-panel { padding: 12px !important; }
        }
        @media (max-width: 480px) {
          .project-list { gap: 12px !important; }
          textarea { font-size: 16px !important; }
          .task-card { padding: 12px !important; border-radius: 12px !important; }
          .task-card h3 { font-size: 13px !important; }
          .phase-badge { font-size: 10px !important; padding: 2px 6px !important; }
          .result-panel { padding: 10px !important; }
          .file-name { font-size: 12px !important; }
        }
        @media (hover: none) {
          button:hover { opacity: 1; }
        }
      `}</style>
    </div>
  )
}
