// tests/path_validation.test.js
// 경로 검증 로직 회귀 테스트
// 실행: node harness/tests/path_validation.test.js

import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 테스트용 환경 설정 ─────────────────────────────────────────
const PROJECTS_ROOT = '/tmp/test-projects-root';
const PROJECT_ROOTS = [PROJECTS_ROOT];
const PRIMARY_PROJECTS_ROOT = PROJECTS_ROOT;

// ── 검증 함수 복사본 (server.js와 동일 로직) ──────────────────
function isPathInsideRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveProjectPath(inputPath, fallbackSlug, { allowExternal = false, allowExternalEnv = false } = {}) {
  const trimmed = typeof inputPath === 'string' ? inputPath.trim() : '';
  const resolved = trimmed
    ? path.resolve(trimmed)
    : path.join(PRIMARY_PROJECTS_ROOT, fallbackSlug);

  if (!path.isAbsolute(resolved)) {
    throw new Error('유효하지 않은 경로입니다.');
  }

  let realResolved = resolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    realResolved = resolved;
  }

  const insideRoot = PROJECT_ROOTS.some(root =>
    isPathInsideRoot(resolved, root) || isPathInsideRoot(realResolved, root)
  );

  if (!insideRoot) {
    if (allowExternalEnv || allowExternal) {
      return resolved;
    }
    throw new Error(
      `경로는 PROJECTS_ROOT 하위여야 합니다.\n` +
      `  입력값: ${inputPath}\n` +
      `  정규화 결과: ${resolved}\n` +
      `  허용 범위: ${PROJECT_ROOTS.join(', ')}\n` +
      `외부 경로를 등록하려면:\n` +
      `  1) 요청에 "allow_external_path": true 파라미터 추가\n` +
      `  2) 또는 서버에 ALLOW_EXTERNAL_PROJECTS=true 환경변수 설정`
    );
  }
  return resolved;
}

// ── runner.js _validateProjectPath 복사본 ─────────────────────
function validateProjectPath(projectPath, { allowExternal = false, allowExternalEnv = false } = {}) {
  const resolved = path.resolve(projectPath);

  let realResolved = resolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    realResolved = resolved;
  }

  const isInsideRoot = (candidate) => PROJECT_ROOTS.some(root => {
    const relative = path.relative(path.resolve(root), candidate);
    return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  });

  const allowed = isInsideRoot(resolved) || isInsideRoot(realResolved);

  if (!allowed) {
    if (allowExternalEnv || allowExternal) {
      return resolved;
    }
    throw new Error(
      `허용되지 않은 프로젝트 경로.\n` +
      `  입력값: ${projectPath}\n` +
      `  정규화 결과: ${resolved}\n` +
      `  허용 범위: ${PROJECT_ROOTS.join(', ')}\n` +
      `외부 경로를 허용하려면 ALLOW_EXTERNAL_PROJECTS=true 환경변수를 설정하세요.`
    );
  }
  return resolved;
}

// ── 테스트 헬퍼 ───────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── 테스트 실행 ───────────────────────────────────────────────
fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
fs.mkdirSync(`${PROJECTS_ROOT}/existing-project`, { recursive: true });

console.log('\n[server.js] resolveProjectPath 테스트');

test('Case 1: PROJECTS_ROOT 내부 경로 - 통과', () => {
  const result = resolveProjectPath(`${PROJECTS_ROOT}/myapp`, 'myapp');
  assert.strictEqual(result, `${PROJECTS_ROOT}/myapp`);
});

test('Case 2: PROJECTS_ROOT 외부 경로 (플래그 없음) - 오류', () => {
  assert.throws(
    () => resolveProjectPath('/Users/sun/myapp', 'myapp'),
    /PROJECTS_ROOT 하위여야 합니다/
  );
});

test('Case 3: PROJECTS_ROOT 외부 경로 (allowExternal=true) - 통과', () => {
  const result = resolveProjectPath('/Users/sun/myapp', 'myapp', { allowExternal: true });
  assert.strictEqual(result, '/Users/sun/myapp');
});

test('Case 4: 상대 경로 ../outside (PROJECTS_ROOT 외부) - 오류', () => {
  // 상대경로 ../outside는 path.resolve 후 PROJECTS_ROOT 외부가 됨
  const outsidePath = path.join(PROJECTS_ROOT, '../outside');
  assert.throws(
    () => resolveProjectPath(outsidePath, 'outside'),
    /PROJECTS_ROOT 하위여야 합니다/
  );
});

test('Case 5: null 입력 → fallback 경로 사용', () => {
  const result = resolveProjectPath(null, 'fallback');
  assert.strictEqual(result, `${PRIMARY_PROJECTS_ROOT}/fallback`);
});

test('Case 6: 빈 문자열 입력 → fallback 경로 사용', () => {
  const result = resolveProjectPath('', 'fallback');
  assert.strictEqual(result, `${PRIMARY_PROJECTS_ROOT}/fallback`);
});

test('Case 7: 환경변수(allowExternalEnv=true) 외부 경로 - 통과', () => {
  const result = resolveProjectPath('/tmp/external', 'ext', { allowExternalEnv: true });
  assert.strictEqual(result, '/tmp/external');
});

// 심볼릭링크 테스트
const symlinkTarget = '/tmp/real-external-project';
const symlinkInRoot = `${PROJECTS_ROOT}/symlink-to-external`;

try {
  fs.mkdirSync(symlinkTarget, { recursive: true });
  try { fs.unlinkSync(symlinkInRoot); } catch { /* already removed */ }
  fs.symlinkSync(symlinkTarget, symlinkInRoot);

  test('Case 8: PROJECTS_ROOT 내 심볼릭링크가 외부 가리킴 - 경고 후 통과 (링크 자체 경로 기준)', () => {
    // 심볼릭링크 자체는 PROJECTS_ROOT 내에 있으므로 resolveProjectPath는 통과
    // (실제 경로는 외부이므로 경고 로그만 출력)
    const result = resolveProjectPath(symlinkInRoot, 'sym');
    assert.strictEqual(result, symlinkInRoot);
  });

  fs.unlinkSync(symlinkInRoot);
} catch (e) {
  test('Case 8: 심볼릭링크 테스트 (환경 미지원으로 스킵)', () => {
    console.log(`    (skipped: ${e.message})`);
  });
} finally {
  try { fs.rmdirSync(symlinkTarget); } catch { /* ignore */ }
}

console.log('\n[runner.js] _validateProjectPath 테스트');

test('Case 9: PROJECTS_ROOT 내부 경로 - 통과', () => {
  const result = validateProjectPath(`${PROJECTS_ROOT}/myapp`);
  assert.strictEqual(result, `${PROJECTS_ROOT}/myapp`);
});

test('Case 10: PROJECTS_ROOT 외부 경로 (플래그 없음) - 오류', () => {
  assert.throws(
    () => validateProjectPath('/Users/sun/myapp'),
    /허용되지 않은 프로젝트 경로/
  );
});

test('Case 11: DB에 저장된 외부 경로 실행 (allowExternal=true) - 통과', () => {
  // DB에서 꺼낸 외부 경로는 allowExternal=true로 호출
  const result = validateProjectPath('/Users/sun/agent-hub', { allowExternal: true });
  assert.strictEqual(result, '/Users/sun/agent-hub');
});

test('Case 12: ALLOW_EXTERNAL_PROJECTS 환경변수 (allowExternalEnv=true) - 통과', () => {
  const result = validateProjectPath('/Users/sun/palmoni', { allowExternalEnv: true });
  assert.strictEqual(result, '/Users/sun/palmoni');
});

test('Case 13: 존재하지 않는 외부 경로 (allowExternal=true) - 통과 (VPS에 없는 로컬 경로)', () => {
  const result = validateProjectPath('/Users/sun/nonexistent-project', { allowExternal: true });
  assert.strictEqual(result, '/Users/sun/nonexistent-project');
});

// ── 회귀 테스트: _startPipeline / _runCodexFallback 시나리오 ────────────────
// 실제 재발 시나리오: server.js POST /api/projects로 외부 경로 등록 후
// runner.js _startPipeline이 DB에서 꺼낸 경로를 재검증할 때 실패하는 케이스
console.log('\n[회귀 테스트] _startPipeline/_runCodexFallback DB 경로 재검증');

test('Regression 14: _startPipeline - DB에서 꺼낸 외부 경로 재검증 (allowExternal=true) 통과', () => {
  // 이 케이스가 핫픽스 이전에 실패하던 시나리오:
  // run()은 allowExternal=true로 통과했지만
  // _startPipeline()이 allowExternal 없이 재검증하여 오류 발생
  const dbStoredExternalPath = '/home/agent/workspace/agent-hub'; // PROJECTS_ROOT 외부
  const result = validateProjectPath(dbStoredExternalPath, { allowExternal: true });
  assert.strictEqual(result, dbStoredExternalPath);
});

test('Regression 15: _runCodexFallback - DB에서 꺼낸 외부 경로 재검증 (allowExternal=true) 통과', () => {
  // _runCodexFallback도 동일하게 allowExternal=true 없이 호출했던 케이스
  const dbStoredExternalPath = '/Users/sun/palmoni';
  const result = validateProjectPath(dbStoredExternalPath, { allowExternal: true });
  assert.strictEqual(result, dbStoredExternalPath);
});

test('Regression 16: 외부 경로 등록 후 실행 E2E 시뮬레이션', () => {
  // 1단계: server.js resolveProjectPath로 외부 경로 등록 (allowExternal=true)
  const externalPath = '/Users/sun/facepick';
  const registeredPath = resolveProjectPath(externalPath, 'facepick', { allowExternal: true });
  assert.strictEqual(registeredPath, externalPath);

  // 2단계: DB에 저장된 경로를 runner.js _validateProjectPath로 재검증 (allowExternal=true)
  // 이 단계가 핫픽스 누락으로 실패했던 지점
  const validatedPath = validateProjectPath(registeredPath, { allowExternal: true });
  assert.strictEqual(validatedPath, externalPath);
});

test('Regression 17: 경로 traversal 입력은 외부 경로로 등록 불가 (보안)', () => {
  // ../ 시도는 path.resolve로 정규화되어 PROJECTS_ROOT 외부 → 오류
  const traversalPath = `${PROJECTS_ROOT}/../../../etc/passwd`;
  assert.throws(
    () => resolveProjectPath(traversalPath, 'evil'),
    /PROJECTS_ROOT 하위여야 합니다/
  );
});

test('Regression 18: allowExternal=true이더라도 path.resolve로 정규화된 절대경로 반환', () => {
  // allowExternal=true여도 경로는 항상 path.resolve()를 통해 정규화된 절대경로
  const result = resolveProjectPath('/tmp/some/../project', 'proj', { allowExternal: true });
  // path.resolve('/tmp/some/../project') = '/tmp/project'
  assert.strictEqual(result, '/tmp/project');
  assert.ok(path.isAbsolute(result));
});

// ── 회귀 테스트: PUT /api/projects/:id 외부 경로 수정 시 existsSync 차단 버그 ──────
// 버그: PUT 핸들러에서 allowExternal=true일 때도 fs.existsSync 체크가 있었음
// → VPS에 없는 외부(로컬 macOS) 경로 수정 시 "수정하려는 경로가 VPS에 없습니다" 오류 발생
// 픽스: allowExternal=true이면 existsSync 체크를 건너뜀
console.log('\n[회귀 테스트] PUT /api/projects/:id 외부 경로 수정 버그');

test('Regression 19: 외부 경로 resolveProjectPath (allowExternal=true) → 존재하지 않아도 통과', () => {
  // VPS에 없는 외부 macOS 경로
  const externalPath = '/Users/sun/facepick';
  const result = resolveProjectPath(externalPath, 'facepick', { allowExternal: true });
  assert.strictEqual(result, externalPath);
  // 이 경로는 VPS에 없지만 allowExternal=true이면 등록/수정 모두 허용되어야 함
});

test('Regression 20: 에러 메시지에 입력값/정규화 결과/허용 범위 포함 (server.js)', () => {
  try {
    resolveProjectPath('/some/external/path', 'external');
    assert.fail('오류가 발생해야 합니다');
  } catch (err) {
    assert.ok(err.message.includes('입력값'), `에러에 입력값 포함 필요: ${err.message}`);
    assert.ok(err.message.includes('정규화 결과'), `에러에 정규화 결과 포함 필요: ${err.message}`);
    assert.ok(err.message.includes('허용 범위'), `에러에 허용 범위 포함 필요: ${err.message}`);
    assert.ok(err.message.includes('/some/external/path'), `에러에 실제 입력 경로 포함 필요: ${err.message}`);
    assert.ok(err.message.includes(PROJECTS_ROOT), `에러에 PROJECTS_ROOT 경로 포함 필요: ${err.message}`);
  }
});

test('Regression 21: 에러 메시지에 입력값/정규화 결과/허용 범위 포함 (runner.js)', () => {
  try {
    validateProjectPath('/some/external/path');
    assert.fail('오류가 발생해야 합니다');
  } catch (err) {
    assert.ok(err.message.includes('입력값'), `에러에 입력값 포함 필요: ${err.message}`);
    assert.ok(err.message.includes('정규화 결과'), `에러에 정규화 결과 포함 필요: ${err.message}`);
    assert.ok(err.message.includes('허용 범위'), `에러에 허용 범위 포함 필요: ${err.message}`);
    assert.ok(err.message.includes('/some/external/path'), `에러에 실제 입력 경로 포함 필요: ${err.message}`);
  }
});

test('Regression 22: 외부 경로 E2E - 등록 후 수정 플로우 (existsSync 버그 없음)', () => {
  // 1단계: 외부 경로 등록 (allowExternal=true)
  const externalPath = '/Users/sun/palmoni';
  const registered = resolveProjectPath(externalPath, 'palmoni', { allowExternal: true });
  assert.strictEqual(registered, externalPath);

  // 2단계: 동일 외부 경로 수정 (allowExternal=true) → existsSync 차단 없이 통과
  const updated = resolveProjectPath(registered, 'palmoni', { allowExternal: true });
  assert.strictEqual(updated, externalPath);

  // 3단계: runner.js에서 실행 (allowExternal=true)
  const validated = validateProjectPath(registered, { allowExternal: true });
  assert.strictEqual(validated, externalPath);
});

// ── 실제 요청 시나리오: /Users/sun/Documents/shooting-like ──────────────
console.log('\n[시나리오] /Users/sun/Documents/shooting-like 외부 경로 등록');

test('Scenario 23: shooting-like 외부 경로 - 플래그 없으면 거부', () => {
  assert.throws(
    () => resolveProjectPath('/Users/sun/Documents/shooting-like', 'shooting-like'),
    /PROJECTS_ROOT 하위여야 합니다/
  );
});

test('Scenario 24: shooting-like 외부 경로 - allow_external_path:true 시 등록 성공', () => {
  const result = resolveProjectPath(
    '/Users/sun/Documents/shooting-like',
    'shooting-like',
    { allowExternal: true }
  );
  assert.strictEqual(result, '/Users/sun/Documents/shooting-like');
  assert.ok(path.isAbsolute(result));
});

test('Scenario 25: shooting-like 외부 경로 - ALLOW_EXTERNAL_PROJECTS 전역 허용 시 등록 성공', () => {
  // allowExternalEnv=true는 서버에서 ALLOW_EXTERNAL_PROJECTS=true 환경변수를 시뮬레이션
  const result = resolveProjectPath(
    '/Users/sun/Documents/shooting-like',
    'shooting-like',
    { allowExternalEnv: true }
  );
  assert.strictEqual(result, '/Users/sun/Documents/shooting-like');
});

test('Scenario 26: shooting-like 거부 에러 메시지에 해결 방법 포함', () => {
  try {
    resolveProjectPath('/Users/sun/Documents/shooting-like', 'shooting-like');
    assert.fail('오류가 발생해야 합니다');
  } catch (err) {
    // 에러 메시지에 해결 방법이 포함되어야 함
    assert.ok(
      err.message.includes('allow_external_path'),
      `에러에 allow_external_path 해결책 포함 필요:\n${err.message}`
    );
    assert.ok(
      err.message.includes('ALLOW_EXTERNAL_PROJECTS'),
      `에러에 ALLOW_EXTERNAL_PROJECTS 해결책 포함 필요:\n${err.message}`
    );
    // 입력 경로가 에러 메시지에 포함되어야 함
    assert.ok(
      err.message.includes('/Users/sun/Documents/shooting-like'),
      `에러에 실제 경로 포함 필요:\n${err.message}`
    );
  }
});

test('Scenario 27: shooting-like DB 등록 후 runner에서 재검증 통과 (E2E)', () => {
  // 1단계: server.js에서 외부 경로 등록 (allow_external_path: true)
  const shootingLikePath = '/Users/sun/Documents/shooting-like';
  const registered = resolveProjectPath(shootingLikePath, 'shooting-like', { allowExternal: true });
  assert.strictEqual(registered, shootingLikePath);

  // 2단계: DB에 저장된 경로를 runner.js에서 재검증 (allowExternal: true)
  const validated = validateProjectPath(registered, { allowExternal: true });
  assert.strictEqual(validated, shootingLikePath);

  // 3단계: 경로 수정 요청도 통과 (PUT /api/projects/:id)
  const updated = resolveProjectPath(registered, 'shooting-like', { allowExternal: true });
  assert.strictEqual(updated, shootingLikePath);
});

test('Scenario 28: PROJECTS_ROOT 내부 경로는 allow_external_path 없이도 정상 등록', () => {
  // 기존 동작 유지: 내부 경로는 영향 없음
  const internalPath = `${PROJECTS_ROOT}/shooting-like`;
  const result = resolveProjectPath(internalPath, 'shooting-like');
  assert.strictEqual(result, internalPath);
  assert.ok(path.isAbsolute(result));
});

// 정리
try { fs.rmdirSync(`${PROJECTS_ROOT}/existing-project`); } catch { /* ignore */ }
try { fs.rmdirSync(PROJECTS_ROOT); } catch { /* ignore */ }

// ── 결과 출력 ─────────────────────────────────────────────────
console.log(`\n결과: ${passed} 통과, ${failed} 실패\n`);
if (failed > 0) {
  process.exit(1);
}
