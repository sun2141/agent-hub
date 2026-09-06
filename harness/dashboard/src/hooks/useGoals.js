// src/hooks/useGoals.js
// 목표 계층 API 훅.
//
// 인증은 App.jsx의 apiFetchRaw와 같은 규약을 쓴다 — 쿠키 세션(credentials: 'include').
// 경로도 같은 규약이다: VITE_API_BASE_URL이 비어 있으면 same-origin '/api'로 가고,
// vercel.json의 rewrite가 그것을 VPS로 넘긴다.

import { useState, useEffect, useCallback, useRef } from 'react'

const _BASE_RAW = import.meta.env.VITE_API_BASE_URL || ''
const API_BASE = _BASE_RAW ? `${_BASE_RAW}/api` : '/api'

export async function goalFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { error: text } }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`)
    err.status = res.status
    err.payload = data
    throw err
  }
  return data
}

export function useGoals({ pollMs = 30000 } = {}) {
  const [goals, setGoals]     = useState([])
  const [inbox, setInbox]     = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  // 폴링과 수동 새로고침이 겹칠 때, 늦게 도착한 오래된 응답이 최신 상태를 덮지 않게 한다.
  // 이게 없으면 승인 직후 목록이 잠깐 예전 상태로 되돌아간다.
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const my = ++seq.current
    setLoading(true)
    try {
      const [g, i] = await Promise.all([goalFetch('/goals'), goalFetch('/goals/inbox')])
      if (my !== seq.current) return
      setGoals(Array.isArray(g) ? g : [])
      setInbox(i)
      setError('')
    } catch (e) {
      if (my === seq.current) setError(e.message)
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    // 계획 생성은 수십 초 걸린다 — 사용자가 새로고침을 누르지 않아도 상태가 따라오게 한다.
    const t = setInterval(refresh, pollMs)
    return () => clearInterval(t)
  }, [pollMs, refresh])

  const inboxCount = inbox
    ? (inbox.items?.length || 0) + (inbox.awaitingApproval?.length || 0)
      + (inbox.awaitingAnswers?.length || 0) + (inbox.paused?.length || 0)
    : 0

  return {
    goals, inbox, inboxCount, loading, error, refresh,
    createGoal:    (body) => goalFetch('/goals', { method: 'POST', body: JSON.stringify(body) }),
    getGoal:       (id)   => goalFetch(`/goals/${id}`),
    setGoalStatus: (id, status, reason) =>
      goalFetch(`/goals/${id}/status`, { method: 'POST', body: JSON.stringify({ status, reason }) }),
    answerClarify: (id, answers) =>
      goalFetch(`/goals/${id}/clarify`, { method: 'POST', body: JSON.stringify({ answers }) }),
    replan:        (id, comment) =>
      goalFetch(`/goals/${id}/replan`, { method: 'POST', body: JSON.stringify({ comment }) }),
    approvePlan:   (planId) => goalFetch(`/plans/${planId}/approve`, { method: 'POST' }),
    rejectPlan:    (planId, comment) =>
      goalFetch(`/plans/${planId}/reject`, { method: 'POST', body: JSON.stringify({ comment }) }),
    deleteGoal:    (id) => goalFetch(`/goals/${id}`, { method: 'DELETE' }),
    setItemStatus: (itemId, status, reason) =>
      goalFetch(`/goal-items/${itemId}/status`, { method: 'POST', body: JSON.stringify({ status, reason }) }),
  }
}
