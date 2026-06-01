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
      `경로는 PROJECTS_ROOT 하위여야 합니다: ${PROJECT_ROOTS.join(', ')}`
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
    throw new Error(`허용되지 않은 프로젝트 경로: ${projectPath}`);
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

// 정리
try { fs.rmdirSync(`${PROJECTS_ROOT}/existing-project`); } catch { /* ignore */ }
try { fs.rmdirSync(PROJECTS_ROOT); } catch { /* ignore */ }

// ── 결과 출력 ─────────────────────────────────────────────────
console.log(`\n결과: ${passed} 통과, ${failed} 실패\n`);
if (failed > 0) {
  process.exit(1);
}
