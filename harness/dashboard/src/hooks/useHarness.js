// src/hooks/useHarness.js
import { useState, useEffect, useRef, useCallback } from 'react'

// API_KEY를 브라우저 번들에 노출하지 않기 위해 VITE_API_KEY 제거
// 대시보드 인증은 세션 쿠키(로그인 후 자동 첲부)  방식으로만 처리
const _API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''
const API_BASE = _API_BASE_URL ? `${_API_BASE_URL}/api` : '/api'

function apiFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include', // 세션 쿠키 자동 첲부
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  }).then(r => r.json())
}

export function useHarness() {
  const [projects, setProjects]   = useState([])
  const [tasks, setTasks]         = useState([])
  const [status, setStatus]       = useState(null)
  const [wsEvents, setWsEvents]   = useState([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)

  const loadProjects = useCallback(async () => {
    try {
      const data = await apiFetch('/projects?includeHidden=true')
      if (Array.isArray(data)) setProjects(data)
    } catch (e) { console.error('projects:', e) }
  }, [])

  const loadTasks = useCallback(async () => {
    try {
      const data = await apiFetch('/tasks?limit=30')
      if (Array.isArray(data)) setTasks(data)
    } catch (e) { console.error('tasks:', e) }
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/status')
      if (data?.ok) setStatus(data.harness)
    } catch (e) { console.error('status:', e) }
  }, [])

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
      console.log('[WS] HTTPS 환경에서 ws:// 불가 → polling 모드 사용')
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
        console.log('[WS] 연결됨')
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
          console.log('[WS msg]', msg.type)
          setWsEvents(prev => [...prev.slice(-200), msg])
          if (['task:complete', 'task:failed', 'task:paused', 'task:rate_limited', 'task:resuming', 'phase:complete'].includes(msg.type)) {
            loadTasks()
            loadStatus()
          }
          if (msg.type === 'task:created') {
            loadTasks()
            loadStatus()
          }
          if (msg.type === 'task:deleted') {
            setTasks(prev => prev.filter(t => t.id !== msg.taskId))
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
          console.log(`[WS] 연결 끊김, ${delay / 1000}초 후 재연결 (${reconnectCount}/10)`)
          reconnectTimer = setTimeout(connect, delay)
        } else {
          console.log('[WS] 재연결 한도 초과 → polling 모드 전환')
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
    // HTTPS 배포 환경에서는 WS 연결이 불가하므로 polling 간격을 10초로 단축
    const isPollingOnly = location.protocol === 'https:'
    const timer = setInterval(() => {
      loadStatus()
      loadTasks()
    }, isPollingOnly ? 10000 : 30000)
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
      setTasks(prev => prev.filter(t => t.id !== taskId))
    }
    return result
  }, [])

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
