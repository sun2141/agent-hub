// src/hooks/useHarness.js
import { useState, useEffect, useRef, useCallback } from 'react'

const API_KEY = import.meta.env.VITE_API_KEY || ''
const API_BASE = '/api'

function apiFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
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
      const data = await apiFetch('/projects')
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

  // WebSocket — Vite 프록시를 통해 연결
  useEffect(() => {
    // ws:// 프로토콜로 현재 호스트에 연결 → vite가 백엔드로 프록시
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${location.host}/ws`

    let reconnectTimer = null
    let ws = null

    function connect() {
      ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        console.log('[WS] 연결됨')
        // API_KEY로 인증
        ws.send(JSON.stringify({ type: 'auth', key: API_KEY }))
      }

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          console.log('[WS msg]', msg.type)
          setWsEvents(prev => [...prev.slice(-200), msg])
          if (['task:complete', 'task:failed', 'task:paused', 'phase:complete'].includes(msg.type)) {
            loadTasks()
            loadStatus()
          }
        } catch {}
      }

      ws.onclose = () => {
        setConnected(false)
        console.log('[WS] 연결 끊김, 3초 후 재연결')
        reconnectTimer = setTimeout(connect, 3000)
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
    const timer = setInterval(() => {
      loadStatus()
      loadTasks()
    }, 30000)
    return () => clearInterval(timer)
  }, [])

  const runTask = useCallback((projectId, prompt, maxRounds = 3) => {
    return apiFetch('/run', {
      method: 'POST',
      body: JSON.stringify({ projectId, prompt, maxRounds }),
    })
  }, [])

  const stopTask = useCallback((taskId) => {
    return apiFetch(`/stop/${taskId}`, { method: 'DELETE' })
  }, [])

  const resumeTask = useCallback((taskId) => {
    return apiFetch('/resume', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    })
  }, [])

  const getTaskLogs = useCallback((taskId) => {
    return wsEvents.filter(e =>
      e.taskId === taskId &&
      ['agent:text', 'agent:tool', 'phase:start', 'phase:complete'].includes(e.type)
    )
  }, [wsEvents])

  return {
    projects, tasks, status, connected, wsEvents,
    runTask, stopTask, resumeTask, getTaskLogs,
    refresh: () => { loadProjects(); loadTasks(); loadStatus() },
  }
}
