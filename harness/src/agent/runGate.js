// src/agent/runGate.js
// 브랜치+PR 실행의 공용 상한.
//
// 이 파일이 따로 있는 이유: 실행 경로가 늘어날 때마다 상한 검사를 복사하면,
// 새 경로 하나가 일일 상한을 통째로 우회한다. 8/18에 백로그 버튼 경로에서
// 실제로 겪은 실패라 같은 실수를 구조로 막는다.
//
// 지금 이 게이트를 공유하는 경로:
//   - /approve (매니저 제안 승인)
//   - /backlog 인라인 버튼
//   - 목표 계층 자동 실행 (goalExecutor)

import { backlogQueries, taskQueries } from '../db/db.js';

export const MANAGER_MAX_CONCURRENT = parseInt(process.env.MANAGER_MAX_CONCURRENT || '1', 10);
export const MANAGER_MAX_APPROVALS_PER_DAY = parseInt(process.env.MANAGER_MAX_APPROVALS_PER_DAY || '3', 10);

// 목표 자동 실행은 사람 승인을 매번 거치지 않으므로 별도 상한을 둔다.
// 진짜 상한은 구독 한도와 동시 실행 2개이므로 크게 잡을 이유가 없다.
export const GOAL_MAX_RUNS_PER_DAY = parseInt(process.env.GOAL_MAX_RUNS_PER_DAY || '6', 10);

/**
 * @param {{ dailyLimit?: number }} opts 목표 경로는 GOAL_MAX_RUNS_PER_DAY를 넘겨 쓴다.
 * @returns {Promise<string|null>} 막혔으면 사람이 읽을 사유, 통과면 null
 */
export async function checkBranchRunGate({ dailyLimit } = {}) {
  const limit = dailyLimit ?? MANAGER_MAX_APPROVALS_PER_DAY;

  const active = await backlogQueries.countActiveManagerTasks();
  if (active >= MANAGER_MAX_CONCURRENT) {
    return `브랜치 작업 동시 실행 상한(${MANAGER_MAX_CONCURRENT}건) 도달 — 진행 중인 작업 완료 후 재시도하세요.`;
  }

  const today = await taskQueries.countBranchModeToday();
  if (today >= limit) {
    return `오늘 브랜치 실행 상한(${limit}건) 도달 — 내일 다시 시도하세요.`;
  }

  return null;
}
