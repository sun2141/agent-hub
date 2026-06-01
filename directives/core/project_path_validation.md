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

### 원인 2: runner.js `_validateProjectPath` 미수정

- **상황**: `51ebeb1`은 `server.js`의 등록/수정 엔드포인트에 `allowExternal` 옵션을 추가했지만, `runner.js`의 `_validateProjectPath`는 `ALLOW_EXTERNAL_PROJECTS` 환경변수만 확인
- **결과**: 태스크 실행 시 DB에서 꺼낸 외부 경로(`/Users/sun/agent-hub`)를 다시 검증할 때 환경변수 없으면 오류
- **흐름**:
  1. `POST /api/projects`로 외부 경로 등록 → `server.js`의 `resolveProjectPath`가 `allowExternal=true`로 통과 → DB에 저장
  2. 태스크 실행 → `runner.js`의 `run()`이 DB에서 경로를 꺼내 `_validateProjectPath` 호출
  3. `_validateProjectPath`는 `ALLOW_EXTERNAL_PROJECTS` 환경변수 없으면 오류 → **재현**

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
// 변경 전
_validateProjectPath(projectPath) {
  ...
  if (!allowed) {
    if (ALLOW_EXTERNAL_PROJECTS) { ... }
    throw new Error(...);
  }
}

async run(...) {
  ...
  this._validateProjectPath(project.path);  // 항상 strict 검사
}

// 변경 후
_validateProjectPath(projectPath, { allowExternal = false } = {}) {
  // 1. path.resolve + fs.realpathSync 양쪽 확인
  // 2. allowExternal=true이면 외부 경로도 허용
  // 3. 심볼릭링크가 외부를 가리키면 경고 로그
}

async run(...) {
  // DB에 저장된 경로는 이미 server.js 검증을 통과한 신뢰 경로
  this._validateProjectPath(project.path, { allowExternal: true });
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

## 테스트

`harness/tests/path_validation.test.js` - 13개 케이스:
1. PROJECTS_ROOT 내부 경로 (server/runner 각각)
2. 외부 경로 플래그 없음 → 오류
3. 외부 경로 allowExternal=true → 통과
4. 상대경로 `../outside` → 오류
5. null/빈 문자열 → fallback 경로
6. 환경변수 허용 → 통과
7. 심볼릭링크 → 통과 + 경고
8. DB 등록 외부 경로 실행 → 통과

```bash
npm test  # harness/ 디렉토리에서 실행
```

---

## 재발 방지 체크리스트

코드 변경 후 반드시 확인:
1. `pm2 restart harness` 또는 `npm run start:bg` 재시작
2. `git log --format="%ai" -1` vs `pm2 describe harness | grep "created at"` 비교
3. 경로 검증 관련 수정 시 `server.js`와 `runner.js` 양쪽 확인
4. `npm test` 실행 후 통과 확인

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
