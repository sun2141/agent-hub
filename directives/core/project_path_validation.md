# 프로젝트 경로 검증 - 원인 분석 및 해결책

## 배경

`51ebeb1` 커밋에서 PROJECTS_ROOT 외부 경로 허용 패치를 적용했음에도 동일한 오류가 재현되는 문제를 진단·수정한 기록.

---

## 오류 메시지

```
Error: 허용되지 않은 프로젝트 경로: /Users/sun/agent-hub
    at AgentRunner._validateProjectPath (harness/src/agent/runner.js:86:25)
```

---

## 근본 원인 2가지

### 원인 1: PM2 미재시작 (코드 미반영)

- **상황**: `51ebeb1` 커밋 시각 `2026-06-01T13:12:38Z`, PM2 harness 시작 시각 `2026-05-31T03:46:26Z`
- **결과**: PM2가 33시간째 구 버전 코드를 실행 중이었음
- **증상**: `server.js`는 새 코드로 업데이트됐지만 런타임 메모리에는 반영 안 됨
- **확인법**: `pm2 describe harness | grep "created at"`와 `git log --format="%ai" -1` 비교

### 원인 2: runner.js `_validateProjectPath` 미수정 (d1d80ae에서 일부만 수정)

- **상황**: `d1d80ae`는 `run()` 메서드에서 `allowExternal: true`를 추가했지만, 같은 파일의 `_startPipeline()`과 `_runCodexFallback()` 두 곳이 여전히 `allowExternal` 없이 재검증
- **결과**: `run()`은 통과하지만 실제 실행 단계인 `_startPipeline()`에서 외부 경로로 오류 재발
- **흐름**:
  1. `POST /api/projects`로 외부 경로 등록 → `server.js`의 `resolveProjectPath`가 `allowExternal=true`로 통과 → DB에 저장
  2. `POST /api/run` → `runner.js`의 `run()`이 DB에서 경로를 꺼내 `_validateProjectPath(path, { allowExternal: true })` 호출 → **통과**
  3. `run()`이 내부적으로 `_startPipeline()` 호출
  4. `_startPipeline()`이 `_validateProjectPath(project.path)` **allowExternal 없이** 재호출 → **오류 재발**
  5. `_runCodexFallback()`도 동일하게 `_validateProjectPath(project.path)` allowExternal 없이 호출 → **동일 오류**

### 수정된 호출 지점 (d1d80ae 이후 누락된 두 곳)

| 메서드 | 수정 전 | 수정 후 |
|--------|---------|---------|
| `run()` | `_validateProjectPath(path)` → 오류 | `_validateProjectPath(path, { allowExternal: true })` → d1d80ae에서 수정됨 |
| `_startPipeline()` | `_validateProjectPath(path)` → **재발 원인** | `_validateProjectPath(path, { allowExternal: true })` → 이번 수정 |
| `_runCodexFallback()` | `_validateProjectPath(path)` → **재발 원인** | `_validateProjectPath(path, { allowExternal: true })` → 이번 수정 |

---

## 추가 발견: 심볼릭링크 처리 누락

- `path.resolve()`는 심볼릭링크를 따라가지 않음
- `fs.realpathSync()`는 링크를 따라 실제 경로 반환
- **보안 이슈**: PROJECTS_ROOT 내 심볼릭링크가 외부를 가리키는 경우 `path.resolve` 기반 검사는 통과, `realpathSync` 기반 검사는 차단
- **대응**: 두 경로 모두 확인 후 경고 로그 출력 (링크 자체 경로 기준으로 허용, 경고만 남김)

---

## 수정 내용

### `harness/src/agent/runner.js`

```js
// 변경 후 (모든 DB 경로 사용 지점에 allowExternal: true 적용)
_validateProjectPath(projectPath, { allowExternal = false } = {}) {
  // 1. path.resolve + fs.realpathSync 양쪽 확인
  // 2. allowExternal=true이면 외부 경로도 허용
  // 3. 심볼릭링크가 외부를 가리키면 경고 로그
}

async run(...) {
  // DB에 저장된 경로는 이미 server.js 검증을 통과한 신뢰 경로
  this._validateProjectPath(project.path, { allowExternal: true });
}

async _startPipeline(taskId) {
  // DB에 저장된 경로 → allowExternal: true 필수
  const safeCwd = this._validateProjectPath(project.path, { allowExternal: true });
}

async _runCodexFallback(taskId) {
  // DB에 저장된 경로 → allowExternal: true 필수
  const safeCwd = this._validateProjectPath(project.path, { allowExternal: true });
}
```

### `harness/src/api/server.js`

```js
// resolveProjectPath에 심볼릭링크 처리 추가
let realResolved = resolved;
try {
  realResolved = fs.realpathSync(resolved);
} catch {
  realResolved = resolved;  // 존재하지 않는 경로 → resolved 그대로
}

const insideRoot = PROJECT_ROOTS.some(root =>
  isPathInsideRoot(resolved, root) || isPathInsideRoot(realResolved, root)
);
```

---

## 추가 발견: PUT /api/projects/:id 외부 경로 수정 버그

### 원인 3: PUT 핸들러의 `fs.existsSync` 무조건 체크

- **상황**: `PUT /api/projects/:id` 핸들러가 `allowExternal=true`인 경우에도 `fs.existsSync(resolvedPath)`로 VPS 경로 존재 여부를 확인
- **결과**: VPS에 없는 외부(macOS 로컬) 경로로 등록된 프로젝트를 수정할 때 "수정하려는 경로가 VPS에 없습니다" 오류 발생
- **수정**: `allowExternal=true`이면 `existsSync` 체크를 건너뜀

```js
// 수정 전
if (!fs.existsSync(resolvedPath)) { ... }

// 수정 후
if (!allowExternal && !fs.existsSync(resolvedPath)) { ... }
```

---

## 에러 메시지 개선

오류 발생 시 디버깅에 필요한 정보를 메시지에 포함:

```
// server.js resolveProjectPath 에러
경로는 PROJECTS_ROOT 하위여야 합니다.
  입력값: /Users/sun/myapp
  정규화 결과: /Users/sun/myapp
  허용 범위: /home/agent/workspace
외부 경로를 등록하려면:
  1) 요청에 "allow_external_path": true 파라미터 추가
  2) 또는 서버에 ALLOW_EXTERNAL_PROJECTS=true 환경변수 설정

// runner.js _validateProjectPath 에러
허용되지 않은 프로젝트 경로.
  입력값: /Users/sun/myapp
  정규화 결과: /Users/sun/myapp
  허용 범위: /home/agent/workspace
외부 경로를 허용하려면 ALLOW_EXTERNAL_PROJECTS=true 환경변수를 설정하세요.
```

---

## 테스트

`harness/tests/path_validation.test.js` - 22개 케이스:
1. PROJECTS_ROOT 내부 경로 (server/runner 각각)
2. 외부 경로 플래그 없음 → 오류
3. 외부 경로 allowExternal=true → 통과
4. 상대경로 `../outside` → 오류
5. null/빈 문자열 → fallback 경로
6. 환경변수 허용 → 통과
7. 심볼릭링크 → 통과 + 경고
8. DB 등록 외부 경로 실행 → 통과
9. (회귀) _startPipeline DB 경로 재검증 통과
10. (회귀) _runCodexFallback DB 경로 재검증 통과
11. (회귀) 외부 경로 등록 후 실행 E2E 시뮬레이션
12. (회귀) 경로 traversal 입력 차단
13. (회귀) allowExternal=true에서도 path.resolve 정규화
14. (회귀) PUT - 외부 경로 수정 시 existsSync 없이 통과
15. (회귀) 에러 메시지에 입력값/정규화 결과/허용 범위 포함
16. (회귀) 외부 경로 등록→수정→실행 전체 E2E 플로우

```bash
npm test  # harness/ 디렉토리에서 실행
# 또는
node harness/tests/path_validation.test.js
```

---

## 재발 방지 체크리스트

코드 변경 후 반드시 확인:
1. `pm2 restart harness` 또는 `npm run start:bg` 재시작
2. `git log --format="%ai" -1` vs `pm2 describe harness | grep "created at"` 비교
3. 경로 검증 관련 수정 시 `server.js`와 `runner.js` 양쪽 확인
4. runner.js에서 DB 경로 사용 지점 전체 확인: `grep -n "_validateProjectPath" runner.js`
   - 모든 호출에 `{ allowExternal: true }` 포함 여부 확인
   - DB에서 꺼낸 경로(`project.path`)는 반드시 `allowExternal: true` 사용
5. server.js PUT 핸들러: 외부 경로 수정 시 `allowExternal` 플래그 확인 후 `existsSync` 체크 건너뜀
6. `npm test` 실행 후 통과 확인 (22개 케이스)

### runner.js DB 경로 검증 호출 지점 전체 목록 (항상 allowExternal: true)
- `run()`: `_validateProjectPath(project.path, { allowExternal: true })`
- `_startPipeline()`: `_validateProjectPath(project.path, { allowExternal: true })`
- `_runCodexFallback()`: `_validateProjectPath(project.path, { allowExternal: true })`

### server.js 외부 경로 처리 지점
- `POST /api/projects/create`: `allowExternal` 플래그 사용
- `PUT /api/projects/:id`: `allowExternal` 플래그 사용 + `existsSync` 체크 조건 확인
- `POST /api/projects`: `allowExternal` 플래그 사용

---

## PM2 재시작 절차

```bash
cd /home/agent/workspace/agent-hub/harness
npm run stop    # PM2 중지
npm run start:bg  # PM2 재시작

# 또는
pm2 restart harness
pm2 describe harness | grep "created at"  # 재시작 시각 확인
```
