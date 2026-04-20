// src/hooks/useHarness.js
// 백엔드 API + WebSocket 연결 훅

import { useState, useEffect, useRef, useCallback } from 'react';

const API_KEY = import.meta.env.VITE_API_KEY || '';
const BASE    = import.meta.env.VITE_API_BASE || '';

// ── API 헬퍼 ─────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
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

  const wsRef   = useRef(null);
  const retryRef = useRef(null);

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
    refresh();
    connectWs();
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
    refresh, runTask, resumeTask, stopTask, deleteTask, createProject,
  };
}
