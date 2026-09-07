// src/agent/verifyFailure.js
// 검증 게이트 실패를 "코드가 틀렸다"와 "환경이 못 돈다"로 나눈다.
//
// 왜 나눠야 하나:
//   게이트가 실패하면 _runGatedEvaluator가 score 0에 오류 본문을 붙여 에이전트에게
//   돌려준다. 코드 오류면 옳은 동작이다. 하지만 네이티브 바인딩이 없어서 실패한
//   경우, 에이전트는 자기가 고칠 수 없는 것을 고치려고 MAX_EVAL_ROUNDS(기본 10)를
//   전부 태운다. 구독 할당량이 그대로 날아가고, 마지막에 남는 기록은 "작업 실패"다.
//   그 다음 목표 차단기가 그걸 작업 실패로 집계한다.
//
// 기본값은 반드시 'code'다. 증거가 있을 때만 'environment'로 내린다.
// 반대 방향의 오판이 훨씬 비싸다 — 진짜 코드 실패를 환경 탓으로 돌리면
// 차단기가 안 걸리고 망가진 작업이 계속 돈다.

// 환경 신호. 프로젝트 코드를 고쳐서 해결할 수 없는 것들만 넣는다.
const ENV_SIGNALS = [
  { re: /Cannot find native binding/i,                 why: '네이티브 바인딩 없음' },
  { re: /ERR_DLOPEN_FAILED/i,                          why: '네이티브 모듈 로드 실패' },
  { re: /invalid ELF header|wrong ELF class|Exec format error/i, why: '다른 플랫폼용 바이너리' },
  { re: /JavaScript heap out of memory/i,              why: '메모리 부족' },
  { re: /ENOSPC|no space left on device/i,             why: '디스크 부족' },
  { re: /EACCES(?::| )|permission denied/i,            why: '권한 없음' },
  { re: /EAI_AGAIN|ENOTFOUND registry\.|ECONNRESET.*registry\.|ETIMEDOUT.*registry\./i, why: '레지스트리 네트워크' },
  { re: /npm error code E(NEEDAUTH|401|403)/i,         why: '레지스트리 인증' },
  { re: /(^|\n)[^\n]*: command not found/i,            why: '명령 없음' },
  { re: /spawn \S+ ENOENT/i,                           why: '실행 파일 없음' },
];

// "모듈을 못 찾는다"는 양쪽 다일 수 있다. 무엇을 못 찾았는지가 가른다.
const MODULE_NOT_FOUND = /Cannot find (?:module|package) ['"]([^'"]+)['"]/g;

// 프로젝트 안의 파일을 가리키는 지정자 — 에이전트가 파일을 지웠거나 경로를 틀린 것이다.
// 이건 코드 실패다. 환경으로 분류하면 진짜 고장이 조용히 넘어간다.
function isLocalSpecifier(spec) {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')
      || spec.startsWith('~/') || spec.startsWith('src/');
}

/**
 * @param {{label?: string, output?: string}} failure  _runVerifyGate가 돌려준 실패
 * @returns {{kind: 'code'|'environment', why: string|null}}
 */
export function classifyVerifyFailure({ label = '', output = '' } = {}) {
  const text = String(output || '');

  // 의존성 설치 자체가 실패한 것은 정의상 환경 문제다.
  // 프로젝트 코드를 어떻게 고쳐도 npm install은 성공하지 않는다.
  if (/^npm (install|ci)$/.test(String(label).trim())) {
    return { kind: 'environment', why: '의존성 설치 실패' };
  }

  for (const { re, why } of ENV_SIGNALS) {
    if (re.test(text)) return { kind: 'environment', why };
  }

  // 못 찾은 모듈이 전부 외부 패키지면 환경, 하나라도 프로젝트 내부 경로면 코드.
  // 섞여 있으면 코드로 본다 — 고칠 수 있는 것이 하나라도 있으면 돌려보내는 게 맞다.
  MODULE_NOT_FOUND.lastIndex = 0;
  const specs = [...text.matchAll(MODULE_NOT_FOUND)].map(m => m[1]);
  if (specs.length > 0 && !specs.some(isLocalSpecifier)) {
    return { kind: 'environment', why: `설치되지 않은 패키지: ${specs[0]}` };
  }

  return { kind: 'code', why: null };
}
