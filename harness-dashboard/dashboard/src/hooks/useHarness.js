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

// ── localStorage 잠금 상태 키 ─────────────────────────────
const LOCK_KEY = 'harness_locked';
const LOCK_HASH_KEY = 'harness_pw_hash';

async function sha256(text) {
  // crypto.subtle은 Secure Context(HTTPS/localhost)에서만 동작
  // HTTP 환경(원격 서버)을 위해 fallback 구현 포함
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const msgBuffer = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback: 순수 JS SHA-256 구현 (HTTP 환경)
  return sha256Fallback(text);
}

function sha256Fallback(str) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }
  // 멀티바이트(한국어 등) 지원: TextEncoder로 UTF-8 바이트 배열 변환
  const bytes = new TextEncoder().encode(str);
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let result = '';
  const words = [];
  const bitLength = bytes.length * 8;

  let hash = [];
  const k = [];
  let primeCounter = 0;

  const isComposite = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = candidate * candidate; i < 313; i += candidate) {
        isComposite[i] = true;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  // UTF-8 바이트 배열을 직접 words 배열로 변환 (0x80 패딩 + 길이 추가)
  const paddedBytes = new Uint8Array(bytes.length + 1 + 64); // 충분한 공간 확보
  paddedBytes.set(bytes);
  paddedBytes[bytes.length] = 0x80;
  let byteLen = bytes.length + 1;
  // 56 mod 64 바이트가 될 때까지 0x00 패딩
  while (byteLen % 64 !== 56) byteLen++;
  // 실제 사용할 패딩된 배열
  const msgBytes = new Uint8Array(byteLen + 8);
  msgBytes.set(paddedBytes.subarray(0, byteLen));
  // 64비트 big-endian 비트 길이 추가
  const bigBitLen = bytes.length * 8;
  // JavaScript 숫자는 53비트 정수까지 안전하므로 상위 32비트는 0
  msgBytes[byteLen]     = 0;
  msgBytes[byteLen + 1] = 0;
  msgBytes[byteLen + 2] = 0;
  msgBytes[byteLen + 3] = 0;
  msgBytes[byteLen + 4] = (bigBitLen / 0x1000000) & 0xff;
  msgBytes[byteLen + 5] = (bigBitLen / 0x10000)   & 0xff;
  msgBytes[byteLen + 6] = (bigBitLen / 0x100)     & 0xff;
  msgBytes[byteLen + 7] =  bigBitLen              & 0xff;

  // 바이트 배열을 32비트 words 배열로 변환
  for (let i = 0; i < msgBytes.length; i++) {
    words[i >> 2] = (words[i >> 2] || 0) | (msgBytes[i] << ((3 - (i & 3)) * 8));
  }

  for (let j = 0; j < words.length;) {
    const w = words.slice(j, j += 16);
    const oldHash = hash.slice(0);
    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15], w2 = w[i - 2];
      const a = hash[0], e = hash[4];
      const temp1 = hash[7]
        + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
        + ((e & hash[5]) ^ (~e & hash[6]))
        + k[i]
        + (w[i] = (i < 16) ? w[i] : (
          w[i - 16]
          + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
          + w[i - 7]
          + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
        ) | 0);
      const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
        + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(temp1 + temp2) | 0, a, hash[1], hash[2], (hash[3] + temp1) | 0, e, hash[5], hash[6]];
    }
    for (let i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }

  for (let i = 0; i < 8; i++) {
    for (let j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += ((b < 16) ? '0' : '') + b.toString(16);
    }
  }
  return result;
}

// ── useHarness ────────────────────────────────────────────
export function useHarness() {
  const [projects,   setProjects]   = useState([]);
  const [tasks,      setTasks]      = useState([]);
  const [status,     setStatus]     = useState(null);
  const [connected,  setConnected]  = useState(false);
  const [streamLog,  setStreamLog]  = useState([]); // 실시간 agent 텍스트
  const [dbLogs,     setDbLogs]     = useState([]); // DB에서 불러온 과거 로그
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);

  const wsRef   = useRef(null);
  const retryRef = useRef(null);

  // ── 인증 확인 ───────────────────────────────────────────
  const checkAuth = useCallback(async () => {
    // BASE가 비어있으면 상대경로(/auth/status)로 요청 → 같은 origin 하네스에 접근
    try {
      const data = await fetch(`${BASE}/auth/status`, { credentials: 'include' }).then(r => r.json());
      setPasswordRequired(data.passwordRequired);

      if (data.authenticated) {
        setAuthenticated(true);
        return true;
      }

      // 서버 세션이 없더라도 localStorage에 잠금 해제 상태가 저장되어 있으면 재인증 시도
      if (data.passwordRequired) {
        const storedHash = localStorage.getItem(LOCK_HASH_KEY);
        const isLocked = localStorage.getItem(LOCK_KEY);
        if (storedHash && isLocked === 'false') {
          // localStorage에 해제된 상태가 있으면 서버에 세션 복원 요청
          try {
            const reauth = await fetch(`${BASE}/auth/reauth`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ hash: storedHash }),
            });
            if (reauth.ok) {
              setAuthenticated(true);
              return true;
            }
          } catch { /* 재인증 실패 시 잠금 화면 표시 */ }
          // 재인증 실패 시 localStorage 초기화
          localStorage.removeItem(LOCK_HASH_KEY);
          localStorage.setItem(LOCK_KEY, 'true');
        }
        setAuthenticated(false);
        return false;
      }

      setAuthenticated(false);
      return false;
    } catch {
      setAuthenticated(false);
      return false;
    }
  }, []);

  // ── eval_result JSON 파싱 헬퍼 ──────────────────────────
  function parseEvalResult(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── 최근 task DB 로그 로드 ───────────────────────────────
  const loadDbLogs = useCallback(async (taskList) => {
    const recentTask = taskList[0];
    if (!recentTask) return;
    try {
      const taskDetail = await apiFetch(`/api/tasks/${recentTask.id}`);
      const logs = (taskDetail.logs || []).map(l => ({
        id:     `db_${l.id}`,
        phase:  l.phase,
        round:  l.round,
        text:   l.content,
        isTool: l.level === 'tool',
        fromDb: true,
        ts:     new Date(l.created_at).getTime(),
      }));
      // DB 로그는 최신순으로 저장되어 있으므로 그대로 사용 (최대 200개)
      setDbLogs(logs.slice(0, 200));
    } catch { /* 무시 */ }
  }, []);

  // ── 초기 데이터 로드 ─────────────────────────────────────
  // ※ login()이 refresh/connectWs를 deps로 참조하므로 반드시 먼저 선언
  const refresh = useCallback(async () => {
    try {
      const [proj, taskList, stat] = await Promise.all([
        apiFetch('/api/projects'),
        apiFetch('/api/tasks?limit=30'),
        apiFetch('/api/status'),
      ]);
      setProjects(proj);
      const parsedTasks = taskList.map(t => ({ ...t, eval_result: parseEvalResult(t.eval_result) }));
      setTasks(parsedTasks);
      setStatus(stat.harness);
      setError(null);
      // 스트림 로그가 없을 때만 DB 로그 로드 (초기 로드 시)
      setStreamLog(prev => {
        if (prev.length === 0) {
          loadDbLogs(parsedTasks);
        }
        return prev;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [loadDbLogs]);

  // ── WebSocket 연결 ───────────────────────────────────────
  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // BASE가 있으면 해당 호스트로, 없으면 현재 origin으로 WS 연결
    let wsUrl;
    if (BASE) {
      try {
        const parsed = new URL(BASE);
        const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${wsProto}//${parsed.host}/ws`;
      } catch {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        wsUrl = `${proto}://${location.host}/ws`;
      }
    } else {
      // VITE_API_BASE 미설정 → 현재 페이지 origin 사용 (하네스가 직접 서빙하는 경우)
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      wsUrl = `${proto}://${location.host}/ws`;
    }

    const ws    = new WebSocket(wsUrl);
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

  // ── 로그인 ──────────────────────────────────────────────
  // refresh, connectWs 선언 후에 정의되므로 deps 정상 참조
  const login = useCallback(async (password) => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '로그인 실패');
    const hash = await sha256(password);
    localStorage.setItem(LOCK_KEY, 'false');
    localStorage.setItem(LOCK_HASH_KEY, hash);
    setAuthenticated(true);
    setLoading(true);
    await refresh();
    connectWs();
    return data;
  }, [refresh, connectWs]);

  // ── 로그아웃 ────────────────────────────────────────────
  const logout = useCallback(async () => {
    await fetch(`${BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
    localStorage.setItem(LOCK_KEY, 'true');
    localStorage.removeItem(LOCK_HASH_KEY);
    setAuthenticated(false);
  }, []);

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

  const addProject = useCallback(async (data) => {
    const result = await apiFetch('/api/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    await refresh();
    return result;
  }, [refresh]);

  return {
    projects, tasks, status, connected, streamLog, dbLogs,
    loading, error,
    authenticated, passwordRequired,
    refresh, runTask, resumeTask, stopTask, deleteTask, createProject, addProject,
    login, logout, checkAuth,
  };
}
