// src/hooks/useHarness.js
import { useState, useEffect, useRef, useCallback } from 'react'

// API_KEY를 브라우저 번들에 노출하지 않기 위해 VITE_API_KEY 제거
// 대시보드 인증은 세션 쿠키(로그인 후 자동 첲부)  방식으로만 처리
const _API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''
const API_BASE = _API_BASE_URL ? `${_API_BASE_URL}/api` : '/api'
const DEBUG_WS = import.meta.env.DEV && import.meta.env.VITE_DEBUG_WS === 'true'
const POLL_INTERVAL_MS = 30_000
const WS_CONNECTED_REFRESH_MS = 120_000
const RATE_LIMIT_BACKOFF_MS = 30_000

const inFlightGets = new Map()
let readBackoffUntil = 0

function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const isRead = method === 'GET'
  const now = Date.now()

  if (isRead && now < readBackoffUntil) {
    return Promise.reject(new Error('rate_limited_backoff'))
  }

  const cacheKey = isRead ? path : null
  if (cacheKey && inFlightGets.has(cacheKey)) {
    return inFlightGets.get(cacheKey)
  }

  const request = fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include', // 세션 쿠키 자동 첲부
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  }).then(async r => {
    const data = await r.json()
    if (r.status === 429) readBackoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
    return data
  }).finally(() => {
    if (cacheKey) inFlightGets.delete(cacheKey)
  })

  if (cacheKey) inFlightGets.set(cacheKey, request)
  return request
}

// 실행 중으로 간주하는 상태 목록 — DB 폴링이 이 상태의 작업을 덮어쓰지 않음
const ACTIVE_STATUSES = new Set(['planning', 'building', 'evaluating', 'deploying'])

export function useHarness() {
  const [projects, setProjects]   = useState([])
  const [tasks, setTasks]         = useState([])
  const [status, setStatus]       = useState(null)
  const [wsEvents, setWsEvents]   = useState([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)
  const connectedRef = useRef(false)
  // 현재 tasks 상태를 ref로 유지 — loadTasks 클로저에서 최신 값 참조용
  const tasksRef = useRef([])

  // tasks 상태 변경 시 ref도 동기화
  const setTasksSafe = useCallback((updater) => {
    setTasks(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      tasksRef.current = next
      return next
    })
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const data = await apiFetch('/projects?includeHidden=true')
      if (Array.isArray(data)) setProjects(data)
    } catch (e) {
      if (e.message !== 'rate_limited_backoff') console.error('projects:', e)
    }
  }, [])

  const loadTasks = useCallback(async () => {
    try {
      const data = await apiFetch('/tasks?limit=30')
      if (!Array.isArray(data)) return
      // 현재 로컬에서 실행 중(active)인 작업은 DB 결과로 덮어쓰지 않음
      // — DB 폴링이 도착했을 때 메모리 상의 최신 상태가 더 정확할 수 있음
      setTasksSafe(prev => {
        const localActiveMap = new Map(
          prev.filter(t => ACTIVE_STATUSES.has(t.status)).map(t => [t.id, t])
        )
        if (localActiveMap.size === 0) return data
        return data.map(dbTask => {
          const localTask = localActiveMap.get(dbTask.id)
          // 로컬에 실행 중 상태가 있고, DB가 아직 이전 상태(paused/queued 등)를 반환한다면
          // 로컬 상태를 우선 유지 (단, DB가 이미 더 최신 활성 상태라면 DB 사용)
          if (localTask && !ACTIVE_STATUSES.has(dbTask.status)) {
            return localTask
          }
          return dbTask
        })
      })
    } catch (e) {
      if (e.message !== 'rate_limited_backoff') console.error('tasks:', e)
    }
  }, [setTasksSafe])

  const loadStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/status')
      if (data?.ok) setStatus(data.harness)
    } catch (e) {
      if (e.message !== 'rate_limited_backoff') console.error('status:', e)
    }
  }, [])

  useEffect(() => {
    connectedRef.current = connected
  }, [connected])

  // WebSocket — Vite 프록시(로컬) 또는 VPS 직접 연결(배포)
  useEffect(() => {
    // VITE_API_BASE_URL이 설정된 경우 VPS로 직접 연결 (http → ws, https → wss)
    let wsUrl
    if (_API_BASE_URL) {
      wsUrl = _API_BASE_URL
        .replace(/^https:/, 'wss:')
        .replace(/^http:/, 'ws:') + '/ws'
    } else {
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      wsUrl = `${wsProtocol}//${location.host}/ws`
    }

    // HTTPS 페이지에서 ws:// 연결은 Mixed Content로 차단됨 → polling fallback
    if (location.protocol === 'https:' && wsUrl.startsWith('ws://')) {
      if (DEBUG_WS) console.log('[WS] HTTPS 환경에서 ws:// 불가 → polling 모드 사용')
      return
    }

    let reconnectTimer = null
    let reconnectCount = 0
    let ws = null

    function connect() {
      ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = async () => {
        setConnected(true)
        reconnectCount = 0
        if (DEBUG_WS) console.log('[WS] 연결됨')
        // WS 재연결 시 최신 task 목록을 즉시 갱신 (연결 끊김 동안의 상태 손실 복구)
        loadTasks()
        loadStatus()
        // 세션 기반 WS 토큰 발급 (브라우저 번들에 API_KEY 불필요)
        try {
          const BASE = _API_BASE_URL || ''
          const tokenRes = await fetch(`${BASE}/auth/ws-token`, { credentials: 'include' })
          const tokenData = await tokenRes.json()
          if (tokenData.token) {
            ws.send(JSON.stringify({ type: 'auth', token: tokenData.token }))
          } else {
            console.warn('[WS] ws-token 발급 실패:', tokenData)
            ws.close()
          }
        } catch (e) {
          console.warn('[WS] ws-token fetch 실패:', e)
          ws.close()
        }
      }

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (DEBUG_WS) console.log('[WS msg]', msg.type)
          setWsEvents(prev => [...prev.slice(-200), msg])

          // phase:start — 로컬 상태를 즉시 업데이트하여 폴링 덮어쓰기 방지
          if (msg.type === 'phase:start' && msg.taskId && msg.phase) {
            setTasksSafe(prev => prev.map(t =>
              t.id === msg.taskId ? { ...t, status: msg.phase, round: msg.round ?? t.round } : t
            ))
          }

          // 작업 종료/일시정지 이벤트 — DB 재조회로 최종 상태 반영
          if (['task:complete', 'task:failed', 'task:paused', 'task:rate_limited', 'task:resuming'].includes(msg.type)) {
            loadTasks()
            loadStatus()
          }

          // phase:complete — 다음 phase 전환을 DB에서 확인 (단, 즉각적인 상태는 phase:start가 처리)
          if (msg.type === 'phase:complete') {
            loadStatus()
          }

          // task:queued — 큐에 추가된 작업의 상태를 로컬에서 즉시 반영
          if (msg.type === 'task:queued' && msg.taskId) {
            setTasksSafe(prev => prev.map(t =>
              t.id === msg.taskId ? { ...t, status: 'queued' } : t
            ))
          }

          if (msg.type === 'task:created') {
            loadTasks()
            loadStatus()
          }
          if (msg.type === 'task:deleted') {
            setTasksSafe(prev => prev.filter(t => t.id !== msg.taskId))
            loadStatus()
          }
        } catch {}
      }

      ws.onclose = () => {
        setConnected(false)
        reconnectCount++
        // 최대 10회 재시도 후 포기 (무한 루프 방지)
        if (reconnectCount <= 10) {
          const delay = Math.min(3000 * reconnectCount, 30000)
          if (DEBUG_WS) console.log(`[WS] 연결 끊김, ${delay / 1000}초 후 재연결 (${reconnectCount}/10)`)
          reconnectTimer = setTimeout(connect, delay)
        } else {
          if (DEBUG_WS) console.log('[WS] 재연결 한도 초과 → polling 모드 전환')
        }
      }

      ws.onerror = (e) => {
        console.error('[WS] 에러', e)
        ws.close()
      }
    }

    connect()

    return () => {
      clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [])

  useEffect(() => {
    loadProjects()
    loadTasks()
    loadStatus()
    let lastConnectedRefreshAt = 0
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      if (connectedRef.current) {
        const now = Date.now()
        if (now - lastConnectedRefreshAt < WS_CONNECTED_REFRESH_MS) return
        lastConnectedRefreshAt = now
      }
      loadStatus()
      loadTasks()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  const updateProject = useCallback(async (id, data) => {
    try {
      const result = await apiFetch(`/projects/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })
      if (result && !result.error) {
        await loadProjects()
      }
      return result
    } catch (e) {
      return { error: e.message || '프로젝트 수정 실패' }
    }
  }, [loadProjects])

  const deleteProject = useCallback(async (id) => {
    try {
      const result = await apiFetch(`/projects/${id}`, { method: 'DELETE' })
      if (result && !result.error) {
        await loadProjects()
      }
      return result
    } catch (e) {
      return { error: e.message || '프로젝트 삭제 실패' }
    }
  }, [loadProjects])

  const forceDeleteProject = useCallback(async (id) => {
    try {
      const result = await apiFetch(`/projects/${id}/force`, { method: 'DELETE' })
      if (result && !result.error) {
        await loadProjects()
      }
      return result
    } catch (e) {
      return { error: e.message || '프로젝트 강제 삭제 실패' }
    }
  }, [loadProjects])

  const toggleProjectVisibility = useCallback(async (id, hidden) => {
    try {
      const result = await apiFetch(`/projects/${id}/visibility`, {
        method: 'PATCH',
        body: JSON.stringify({ hidden }),
      })
      if (result && !result.error) {
        await loadProjects()
      }
      return result
    } catch (e) {
      return { error: e.message || '프로젝트 숨기기 실패' }
    }
  }, [loadProjects])

  const addProject = useCallback(async (data) => {
    try {
      const result = await apiFetch('/projects', {
        method: 'POST',
        body: JSON.stringify(data),
      })
      if (result && !result.error) {
        await loadProjects()
        return result
      }
      return result
    } catch (e) {
      return { error: e.message || '프로젝트 추가 실패' }
    }
  }, [loadProjects])

  // 폴더 + GitHub 레포 + DB 한 번에 생성
  const createProject = useCallback(async (data) => {
    try {
      const result = await apiFetch('/projects/create', {
        method: 'POST',
        body: JSON.stringify(data),
      })
      if (result && !result.error) {
        await loadProjects()
      }
      return result
    } catch (e) {
      return { error: e.message || '프로젝트 생성 실패' }
    }
  }, [loadProjects])

  const runTask = useCallback((projectId, prompt, maxRounds = 10, attachments) => {
    return apiFetch('/run', {
      method: 'POST',
      body: JSON.stringify({ projectId, prompt, maxRounds, attachments }),
    })
  }, [])

  const stopTask = useCallback((taskId) => {
    return apiFetch(`/stop/${taskId}`, { method: 'DELETE' })
  }, [])

  const deleteTask = useCallback(async (taskId) => {
    const result = await apiFetch(`/tasks/${taskId}`, { method: 'DELETE' })
    if (!result?.error) {
      setTasksSafe(prev => prev.filter(t => t.id !== taskId))
    }
    return result
  }, [setTasksSafe])

  const resumeTask = useCallback((taskId) => {
    return apiFetch('/resume', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    })
  }, [])

  const resumeNow = useCallback((taskId) => {
    return apiFetch(`/tasks/${taskId}/resume-now`, { method: 'POST' })
  }, [])

  const getTaskLogs = useCallback((taskId) => {
    return wsEvents.filter(e =>
      e.taskId === taskId &&
      ['agent:text', 'agent:tool', 'phase:start', 'phase:complete'].includes(e.type)
    )
  }, [wsEvents])

  // DB 저장 로그를 fetch하여 WS 이벤트 형식으로 변환
  const fetchTaskLogs = useCallback(async (taskId) => {
    try {
      const data = await apiFetch(`/tasks/${taskId}`)
      if (!data || !Array.isArray(data.logs)) return []
      // DESC로 저장된 로그를 오름차순으로 정렬
      const sorted = [...data.logs].sort((a, b) => a.id - b.id)
      return sorted.map(log => {
        const type = log.level === 'tool' ? 'agent:tool' : 'agent:text'
        return {
          type,
          taskId: log.task_id,
          phase: log.phase,
          round: log.round,
          content: log.content,
          tool: log.level === 'tool' ? log.content : undefined,
          ts: new Date(log.created_at.endsWith('Z') ? log.created_at : log.created_at.replace(' ', 'T') + 'Z').getTime(),
          _fromDb: true,
        }
      })
    } catch (e) {
      console.error('fetchTaskLogs:', e)
      return []
    }
  }, [])

  // 작업 결과 파일 목록 fetch
  const fetchTaskFiles = useCallback(async (taskId) => {
    try {
      const data = await apiFetch(`/tasks/${taskId}/files`)
      return data
    } catch (e) {
      console.error('fetchTaskFiles:', e)
      return { ok: false, files: [], error: e.message }
    }
  }, [])

  const fetchGDriveFolder = useCallback(async (url) => {
    return apiFetch('/gdrive-folder', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
  }, [])

  const fetchDropboxFolder = useCallback(async (url) => {
    return apiFetch('/dropbox-folder', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
  }, [])

  const downloadGDriveFile = useCallback(async (fileId, fileName) => {
    return apiFetch('/gdrive-download', {
      method: 'POST',
      body: JSON.stringify({ fileId, fileName }),
    })
  }, [])

  const downloadDropboxFile = useCallback(async (url, fileName) => {
    return apiFetch('/dropbox-download', {
      method: 'POST',
      body: JSON.stringify({ url, fileName }),
    })
  }, [])

  return {
    projects, tasks, status, connected, wsEvents,
    runTask, stopTask, resumeTask, resumeNow, deleteTask, getTaskLogs, fetchTaskLogs, fetchTaskFiles,
    addProject, createProject, updateProject, deleteProject, forceDeleteProject, toggleProjectVisibility,
    fetchGDriveFolder, fetchDropboxFolder, downloadGDriveFile, downloadDropboxFile,
    refresh: () => { loadProjects(); loadTasks(); loadStatus() },
  }
}
