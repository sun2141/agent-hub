// src/hooks/useHarness.js
// 백엔드 API + WebSocket 연결 훅

import { useState, useEffect, useRef, useCallback } from 'react';

const API_KEY = import.meta.env.VITE_API_KEY || '';
const BASE    = import.meta.env.VITE_API_BASE || '';

// ── API 헬퍼 ─────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    API_KEY,
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── useHarness ────────────────────────────────────────────
export function useHarness() {
  const [projects,   setProjects]   = useState([]);
  const [tasks,      setTasks]      = useState([]);
  const [status,     setStatus]     = useState(null);
  const [connected,  setConnected]  = useState(false);
  const [streamLog,  setStreamLog]  = useState([]); // 실시간 agent 텍스트
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);

  const wsRef   = useRef(null);
  const retryRef = useRef(null);

  // ── 인증 확인 ───────────────────────────────────────────
  const checkAuth = useCallback(async () => {
    try {
      const data = await fetch(`${BASE}/auth/status`, { credentials: 'include' }).then(r => r.json());
      setPasswordRequired(data.passwordRequired);
      setAuthenticated(data.authenticated);
      return data.authenticated;
    } catch {
      setAuthenticated(false);
      return false;
    }
  }, []);

  // ── 로그인 ──────────────────────────────────────────────
  const login = useCallback(async (password) => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '로그인 실패');
    setAuthenticated(true);
    setLoading(true);
    // 로그인 후 데이터 로드 및 WS 연결
    await refresh();
    connectWs();
    return data;
  }, [refresh, connectWs]);

  // ── 로그아웃 ────────────────────────────────────────────
  const logout = useCallback(async () => {
    await fetch(`${BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
    setAuthenticated(false);
  }, []);

  // ── 초기 데이터 로드 ────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const [proj, taskList, stat] = await Promise.all([
        apiFetch('/api/projects'),
        apiFetch('/api/tasks?limit=30'),
        apiFetch('/api/status'),
      ]);
      setProjects(proj);
      setTasks(taskList);
      setStatus(stat.harness);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── WebSocket 연결 ───────────────────────────────────────
  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const host  = BASE ? new URL(BASE).host : location.host;
    const ws    = new WebSocket(`${proto}://${host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      // API_KEY 있으면 인증 메시지 전송
      if (API_KEY) ws.send(JSON.stringify({ type: 'auth', key: API_KEY }));
      else setConnected(true);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleWsMessage(msg);
      } catch { /* 무시 */ }
    };

    ws.onclose = () => {
      setConnected(false);
      // 5초 후 재연결
      retryRef.current = setTimeout(connectWs, 5000);
    };

    ws.onerror = () => ws.close();
  }, []);

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'authenticated':
      case 'connected':
        setConnected(true);
        if (msg.status) setStatus(msg.status);
        break;

      case 'task:created':
      case 'task:queued':
      case 'task:complete':
      case 'task:paused':
      case 'task:failed':
      case 'task:deleted':
      case 'phase:start':
      case 'phase:complete':
        // 상태 갱신
        refresh();
        break;

      case 'agent:text':
        setStreamLog(prev => {
          const entry = { id: Date.now(), phase: msg.phase, round: msg.round, text: msg.text };
          return [entry, ...prev].slice(0, 200);
        });
        break;

      case 'agent:tool':
        setStreamLog(prev => {
          const entry = {
            id:    Date.now(),
            phase: msg.phase,
            round: msg.round,
            text:  `[Tool: ${msg.tool}]`,
            isTool: true,
          };
          return [entry, ...prev].slice(0, 200);
        });
        break;

      default:
        break;
    }
  }

  useEffect(() => {
    checkAuth().then(isAuth => {
      if (isAuth) {
        refresh();
        connectWs();
      } else {
        setLoading(false);
      }
    });
    return () => {
      clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, []);

  // ── 액션 ────────────────────────────────────────────────
  const runTask = useCallback(async ({ projectId, prompt, maxRounds, attachments }) => {
    const result = await apiFetch('/api/run', {
      method: 'POST',
      body: JSON.stringify({ projectId, prompt, maxRounds, attachments }),
    });
    await refresh();
    return result;
  }, [refresh]);

  const resumeTask = useCallback(async (taskId) => {
    const result = await apiFetch('/api/resume', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    });
    await refresh();
    return result;
  }, [refresh]);

  const stopTask = useCallback(async (taskId) => {
    const result = await apiFetch(`/api/stop/${taskId}`, { method: 'DELETE' });
    await refresh();
    return result;
  }, [refresh]);

  const deleteTask = useCallback(async (taskId) => {
    const result = await apiFetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    await refresh();
    return result;
  }, [refresh]);

  const createProject = useCallback(async (data) => {
    const result = await apiFetch('/api/projects/create', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    await refresh();
    return result;
  }, [refresh]);

  return {
    projects, tasks, status, connected, streamLog,
    loading, error,
    authenticated, passwordRequired,
    refresh, runTask, resumeTask, stopTask, deleteTask, createProject,
    login, logout, checkAuth,
  };
}
