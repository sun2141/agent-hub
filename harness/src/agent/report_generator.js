// src/agent/report_generator.js
// 작업 완료 후 상세 리포트 생성 — 점수 근거, 체크리스트, 후속 작업 포함

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_HUB_ROOT = path.resolve(__dirname, '../../..');
const TASKS_DONE_DIR = path.join(AGENT_HUB_ROOT, 'tasks', 'done');

// 점수 등급 계산
function getScoreGrade(score) {
  if (score >= 95) return { grade: 'A+', label: '완벽', emoji: '🏆' };
  if (score >= 90) return { grade: 'A',  label: '우수', emoji: '✨' };
  if (score >= 80) return { grade: 'B',  label: '합격', emoji: '✅' };
  if (score >= 70) return { grade: 'C',  label: '미흡', emoji: '⚠️' };
  if (score >= 60) return { grade: 'D',  label: '불합격', emoji: '❌' };
  return               { grade: 'F',  label: '실패', emoji: '💔' };
}

// 점수 산정 근거 항목별 분석 생성
function buildScoreBreakdown(plan, evalResult) {
  const criteria = Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria : [];
  const issues = Array.isArray(evalResult?.issues) ? evalResult.issues.filter(x => x?.trim()) : [];
  const score = evalResult?.score ?? 0;
  const passed = evalResult?.passed === true;

  // 미충족 항목 매핑 (이슈 텍스트에서 criteria 번호 또는 키워드 매칭)
  const unmetSet = new Set();
  for (const issue of issues) {
    const numMatch = issue.match(/^(\d+)\./);
    if (numMatch) {
      unmetSet.add(parseInt(numMatch[1], 10) - 1); // 0-indexed
    }
  }

  const criteriaResults = criteria.map((criterion, idx) => {
    // 이슈 텍스트에서 해당 기준이 언급되는지 확인
    const isUnmetByIndex = unmetSet.has(idx);
    const isUnmetByText = issues.some(issue =>
      issue.toLowerCase().includes(criterion.toLowerCase().slice(0, 30))
    );
    const isUnmet = isUnmetByIndex || isUnmetByText;

    return {
      index: idx + 1,
      criterion,
      status: isUnmet ? 'fail' : 'pass',
      statusLabel: isUnmet ? '✗ 미충족' : '✓ 충족',
      relatedIssue: isUnmet
        ? issues.find(i => {
            const nm = i.match(/^(\d+)\./);
            return (nm && parseInt(nm[1], 10) === idx + 1) ||
                   i.toLowerCase().includes(criterion.toLowerCase().slice(0, 20));
          }) || null
        : null,
    };
  });

  // 가중치 계산: 기준 개수가 있으면 균등 분배, 없으면 100점 기준
  const totalCriteria = criteria.length || 1;
  const weightPerCriterion = Math.round(100 / totalCriteria);
  const passedCount = criteriaResults.filter(r => r.status === 'pass').length;
  const failedCount = criteriaResults.filter(r => r.status === 'fail').length;

  return {
    score,
    passed,
    grade: getScoreGrade(score),
    totalCriteria,
    passedCount,
    failedCount,
    weightPerCriterion,
    criteriaResults,
    issues,
    suggestions: evalResult?.suggestions || '',
    summary: evalResult?.summary || '',
  };
}

// 후속 작업 제안 자동 생성
function generateFollowUpTasks(breakdown, plan, maxRoundsReached) {
  const suggestions = [];

  // 미충족 기준 기반 후속 작업
  for (const r of breakdown.criteriaResults) {
    if (r.status === 'fail') {
      suggestions.push({
        priority: 'HIGH',
        title: `미충족 기준 재구현: ${r.criterion.slice(0, 60)}`,
        reason: r.relatedIssue || '평가에서 미충족으로 판정됨',
      });
    }
  }

  // 평가자 제안 기반 후속 작업
  if (breakdown.suggestions && breakdown.suggestions.trim()) {
    suggestions.push({
      priority: 'MEDIUM',
      title: '평가자 개선 제안 반영',
      reason: breakdown.suggestions.slice(0, 200),
    });
  }

  // 최대 라운드 도달 시
  if (maxRoundsReached && breakdown.failedCount > 0) {
    suggestions.push({
      priority: 'HIGH',
      title: '최대 라운드 초과로 미완성 — rounds 증가 후 재시도',
      reason: `${breakdown.failedCount}개 항목 미충족 상태로 최대 라운드 도달`,
    });
  }

  // 점수가 낮지만 통과된 경우
  if (breakdown.passed && breakdown.score < 90) {
    suggestions.push({
      priority: 'LOW',
      title: '코드 품질 개선 (점수 향상)',
      reason: `현재 점수 ${breakdown.score}/100 — 추가 개선 여지 있음`,
    });
  }

  return suggestions;
}

// 리뷰/테스트 단계별 세부 결과 섹션 생성
function buildPhaseResults(evalHistory) {
  if (!Array.isArray(evalHistory) || evalHistory.length === 0) return null;

  return evalHistory.map((entry, idx) => ({
    round: entry.round || idx + 1,
    score: entry.score ?? 0,
    passed: entry.passed === true,
    issueCount: Array.isArray(entry.issues) ? entry.issues.filter(x => x?.trim()).length : 0,
    issues: Array.isArray(entry.issues) ? entry.issues.filter(x => x?.trim()) : [],
    summary: entry.summary || '',
  }));
}

// 마크다운 리포트 문자열 생성
function buildMarkdownReport({ task, project, plan, breakdown, followUpTasks, phaseResults, rounds, maxRoundsReached, deployResult, commitSha }) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const { grade } = breakdown;
  const taskTitle = plan?.title || task?.prompt?.slice(0, 80) || task?.id || 'Unknown';
  const projectName = project?.name || task?.project_id || 'Unknown';

  const lines = [];

  // 헤더
  lines.push(`# ${grade.emoji} 작업 리포트: ${taskTitle}`);
  lines.push('');
  lines.push(`| 항목 | 값 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 작업 ID | \`${task?.id || '-'}\` |`);
  lines.push(`| 프로젝트 | ${projectName} |`);
  lines.push(`| 생성일시 | ${now} UTC |`);
  lines.push(`| 총 라운드 | ${rounds} |`);
  lines.push(`| 상태 | ${maxRoundsReached ? '⚠️ 최대 라운드 도달' : breakdown.passed ? '✅ 합격' : '❌ 불합격'} |`);
  if (commitSha) lines.push(`| 커밋 SHA | \`${commitSha.slice(0, 8)}\` |`);
  if (deployResult) lines.push(`| 배포 결과 | ${deployResult} |`);
  lines.push('');

  // 점수 섹션
  lines.push(`## ${grade.emoji} 최종 점수: ${breakdown.score}/100 (${grade.grade} — ${grade.label})`);
  lines.push('');
  lines.push(`> ${breakdown.summary || '평가 요약 없음'}`);
  lines.push('');

  // 점수 산정 근거
  lines.push('### 점수 산정 근거');
  lines.push('');
  lines.push(`- **총 완료 기준**: ${breakdown.totalCriteria}개`);
  lines.push(`- **항목당 가중치**: 약 ${breakdown.weightPerCriterion}점`);
  lines.push(`- **충족**: ${breakdown.passedCount}개 / **미충족**: ${breakdown.failedCount}개`);
  lines.push(`- **기본 점수**: 구현 충족도 기반 0~100 (평가자 AI 판정)`);
  lines.push('');

  // Acceptance criteria 체크리스트
  lines.push('## 📋 완료 기준 체크리스트');
  lines.push('');

  if (breakdown.criteriaResults.length === 0) {
    lines.push('_완료 기준이 정의되지 않았습니다._');
  } else {
    lines.push(`| # | 완료 기준 | 결과 | 가중치 |`);
    lines.push(`|---|-----------|------|--------|`);
    for (const r of breakdown.criteriaResults) {
      const criterionShort = r.criterion.length > 60
        ? r.criterion.slice(0, 57) + '...'
        : r.criterion;
      lines.push(`| ${r.index} | ${criterionShort} | ${r.statusLabel} | ~${breakdown.weightPerCriterion}점 |`);
    }
  }
  lines.push('');

  // 미충족/부분 완료 항목 상세
  const failedItems = breakdown.criteriaResults.filter(r => r.status === 'fail');
  if (failedItems.length > 0) {
    lines.push('## ❌ 미충족 항목 상세');
    lines.push('');
    for (const r of failedItems) {
      lines.push(`### ${r.index}. ${r.criterion}`);
      if (r.relatedIssue) {
        lines.push(`- **평가 사유**: ${r.relatedIssue}`);
      } else {
        lines.push(`- **평가 사유**: 평가자 판정에 따라 미충족`);
      }
      lines.push('');
    }
  }

  // 라운드별 평가 이력 (phaseResults가 있을 때)
  if (phaseResults && phaseResults.length > 0) {
    lines.push('## 🔄 라운드별 평가 이력');
    lines.push('');
    lines.push('| 라운드 | 점수 | 통과 | 미충족 수 | 요약 |');
    lines.push('|--------|------|------|----------|------|');
    for (const ph of phaseResults) {
      const passIcon = ph.passed ? '✅' : '❌';
      const summaryShort = (ph.summary || '-').slice(0, 40);
      lines.push(`| Round ${ph.round} | ${ph.score}/100 | ${passIcon} | ${ph.issueCount}개 | ${summaryShort} |`);
    }
    lines.push('');

    // 최종 라운드 이외에 실패한 라운드가 있으면 실패 원인 추적
    const failedRounds = phaseResults.filter(ph => !ph.passed);
    if (failedRounds.length > 0) {
      lines.push('### 실패 원인 추적');
      lines.push('');
      for (const ph of failedRounds) {
        if (ph.issues.length > 0) {
          lines.push(`**Round ${ph.round} 미충족 항목:**`);
          for (const issue of ph.issues) {
            lines.push(`- ${issue}`);
          }
          lines.push('');
        }
      }
    }
  }

  // 평가자 개선 제안
  if (breakdown.suggestions) {
    lines.push('## 💡 평가자 개선 제안');
    lines.push('');
    lines.push(breakdown.suggestions);
    lines.push('');
  }

  // 후속 작업 제안
  if (followUpTasks.length > 0) {
    lines.push('## 🚀 후속 작업 제안 (Follow-up Tasks)');
    lines.push('');
    const highPriority = followUpTasks.filter(t => t.priority === 'HIGH');
    const medPriority  = followUpTasks.filter(t => t.priority === 'MEDIUM');
    const lowPriority  = followUpTasks.filter(t => t.priority === 'LOW');

    if (highPriority.length > 0) {
      lines.push('### 🔴 높은 우선순위');
      for (const t of highPriority) {
        lines.push(`- **${t.title}**`);
        lines.push(`  - 사유: ${t.reason}`);
      }
      lines.push('');
    }
    if (medPriority.length > 0) {
      lines.push('### 🟡 보통 우선순위');
      for (const t of medPriority) {
        lines.push(`- **${t.title}**`);
        lines.push(`  - 사유: ${t.reason}`);
      }
      lines.push('');
    }
    if (lowPriority.length > 0) {
      lines.push('### 🟢 낮은 우선순위');
      for (const t of lowPriority) {
        lines.push(`- **${t.title}**`);
        lines.push(`  - 사유: ${t.reason}`);
      }
      lines.push('');
    }
  } else {
    lines.push('## 🚀 후속 작업 제안');
    lines.push('');
    lines.push('_후속 작업 없음 — 모든 기준 충족_');
    lines.push('');
  }

  // 원본 작업 정보
  lines.push('## 📄 원본 작업 정보');
  lines.push('');
  lines.push(`**요약**: ${plan?.summary || task?.prompt?.slice(0, 200) || '-'}`);
  lines.push('');
  if (Array.isArray(plan?.features) && plan.features.length > 0) {
    lines.push('**구현 기능:**');
    for (const f of plan.features) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }
  if (plan?.tech_notes) {
    lines.push(`**기술 주의사항**: ${plan.tech_notes}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`_리포트 생성: ${now} UTC | Agent Hub 자동 생성_`);

  return lines.join('\n');
}

// 리포트 파일명 생성 (tasks/done/{task_id}_report.md)
function buildReportFilename(taskId) {
  const safe = (taskId || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(TASKS_DONE_DIR, `${safe}_report.md`);
}

// 텔레그램 요약 메시지 생성 (HTML 포맷)
export function buildTelegramSummary({ taskId, projectName, score, passed, failedCount, maxRoundsReached, followUpCount, reportPath }) {
  const { grade } = getScoreGrade(score ?? 0);
  const statusLine = maxRoundsReached
    ? `⚠️ <b>최대 라운드 도달</b>`
    : passed
      ? `✅ <b>합격</b>`
      : `❌ <b>불합격</b>`;

  const lines = [
    `${statusLine} | 점수: <b>${score ?? '-'}/100</b> (${grade})`,
    ``,
    `🆔 <code>${taskId}</code>`,
    `📁 ${projectName || '-'}`,
  ];

  if (failedCount > 0) {
    lines.push(`❌ 미충족 항목: ${failedCount}개`);
  }
  if (followUpCount > 0) {
    lines.push(`🚀 후속 작업 제안: ${followUpCount}개`);
  }
  if (reportPath) {
    const relPath = path.relative(AGENT_HUB_ROOT, reportPath);
    lines.push(`📄 리포트: <code>${relPath}</code>`);
  }

  return lines.join('\n');
}

/**
 * 메인 리포트 생성 함수
 * @param {object} params
 * @param {object} params.task         - DB task 레코드
 * @param {object} params.project      - DB project 레코드
 * @param {object} params.plan         - 파싱된 plan JSON
 * @param {object} params.evalResult   - 최종 eval 결과 {score,passed,issues,suggestions,summary}
 * @param {object[]} [params.evalHistory] - 라운드별 eval 이력 (선택)
 * @param {number} params.rounds       - 총 실행 라운드
 * @param {boolean} params.maxRoundsReached
 * @param {string} [params.deployResult]
 * @param {string} [params.commitSha]
 * @returns {{ reportPath: string, markdown: string, breakdown: object, followUpTasks: object[], telegramSummary: string }}
 */
export function generateReport(params) {
  const {
    task,
    project,
    plan,
    evalResult,
    evalHistory,
    rounds,
    maxRoundsReached,
    deployResult,
    commitSha,
  } = params;

  const breakdown = buildScoreBreakdown(plan, evalResult);
  const followUpTasks = generateFollowUpTasks(breakdown, plan, maxRoundsReached);
  const phaseResults = buildPhaseResults(evalHistory);

  const markdown = buildMarkdownReport({
    task,
    project,
    plan,
    breakdown,
    followUpTasks,
    phaseResults,
    rounds,
    maxRoundsReached,
    deployResult,
    commitSha,
  });

  // tasks/done/ 디렉토리 확인 및 생성
  try {
    if (!fs.existsSync(TASKS_DONE_DIR)) {
      fs.mkdirSync(TASKS_DONE_DIR, { recursive: true });
    }
  } catch (err) {
    console.error(`[report] tasks/done 디렉토리 생성 실패: ${err.message}`);
  }

  const reportPath = buildReportFilename(task?.id || 'unknown');

  try {
    fs.writeFileSync(reportPath, markdown, 'utf8');
    console.log(`[report] 리포트 저장: ${reportPath}`);
  } catch (err) {
    console.error(`[report] 리포트 저장 실패: ${err.message}`);
  }

  const telegramSummary = buildTelegramSummary({
    taskId: task?.id,
    projectName: project?.name || task?.project_id,
    score: breakdown.score,
    passed: breakdown.passed,
    failedCount: breakdown.failedCount,
    maxRoundsReached,
    followUpCount: followUpTasks.length,
    reportPath,
  });

  return {
    reportPath,
    markdown,
    breakdown,
    followUpTasks,
    telegramSummary,
  };
}
