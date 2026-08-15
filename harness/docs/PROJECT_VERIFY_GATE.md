# 프로젝트 검증 게이트 — "돌아간다고 주장하는 코드" 걸러내기

하네스가 작업을 완료 처리하기 전에 두 개의 관문을 통과해야 한다.

```
Build 완료
   ↓
① 객관 검증 게이트   ← 실제로 실행되는 명령. 실패하면 LLM 평가를 건너뛰고 바로 재시도
   ↓
② LLM 평가(eval)     ← score >= 80 && passed=true
   ↓
commit → (매니저 작업이면) PR
```

**②는 LLM의 자기 주장이고, ①만이 사실이다.** 그래서 ①이 얼마나 촘촘한지가
결과물 품질을 결정한다. 그런데 ①은 **대상 프로젝트의 `package.json`에 스크립트가
있을 때만** 무언가를 실행한다. 아무것도 없으면 `npm run build` 하나만 돌거나,
그것마저 없으면 **검증 없이 통과**한다.

## 하네스가 찾는 순서 (`_detectVerifyCmds`)

| 순위 | 조건 | 실행 |
|---|---|---|
| 1 | `verify.sh` 존재 | `bash verify.sh` **하나만** |
| 2 | `scripts.verify` 존재 | `npm run verify` **하나만** |
| 3 | 그 외 | `typecheck` + `lint` + `test` 중 **있는 것 전부 누적** |
| 4 | 3번이 하나도 없을 때만 | `npm run build` |
| + | `scripts.smoketest` 존재 | **항상 마지막에 추가** |

주의할 점:

- 1·2순위는 **단독 실행**이다. `verify.sh`나 `scripts.verify`를 정의했다면 그 안에
  테스트까지 포함시켜야 한다. 아니면 테스트가 영영 안 돌아간다.
- `test`는 표준 `scripts.test` 필드만 본다. `test:unit` 같은 커스텀 이름은 무시한다.
- `npm init` 기본 스텁(`echo "Error: no test specified"`)은 테스트로 치지 않는다.
- 타임아웃: `test`/`smoketest`는 `VERIFY_TEST_TIMEOUT_MS`(기본 10분),
  나머지는 5분 고정.

## 프로젝트에 넣을 최소 세트

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "smoketest": "node scripts/smoke.mjs"
  }
}
```

TypeScript를 안 쓰면 `typecheck`는 생략해도 된다. **`smoketest`가 가장 가성비가 높다.**

## smoketest 템플릿

빌드는 통과하는데 런타임에 죽는 코드를 잡는 게 목적이다. 화려할 필요 없다.

### 웹 서버 / API 프로젝트

`scripts/smoke.mjs`:

```js
// 서버를 실제로 띄우고 핵심 엔드포인트가 살아있는지만 확인한다.
// 목적: "빌드는 되는데 부팅하면 죽는" 변경을 잡는 것.
import { spawn } from 'node:child_process';

const PORT = process.env.SMOKE_PORT || 4173;
const BOOT_TIMEOUT_MS = 60_000;
const ENDPOINTS = ['/', '/api/health'];   // ← 프로젝트에 맞게 수정

const server = spawn('npm', ['start'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

const cleanup = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', cleanup);

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`서버가 부팅 중 종료됨 (code ${server.exitCode})\n${log.slice(-2000)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    } catch { /* 아직 안 떴음 */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${BOOT_TIMEOUT_MS}ms 안에 서버가 뜨지 않음\n${log.slice(-2000)}`);
}

try {
  await waitForBoot();
  for (const path of ENDPOINTS) {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (res.status >= 500) {
      throw new Error(`${path} → ${res.status}\n${(await res.text()).slice(0, 500)}`);
    }
    console.log(`  ✓ ${path} → ${res.status}`);
  }
  console.log('smoketest 통과');
  cleanup();
  process.exit(0);
} catch (err) {
  console.error(`smoketest 실패: ${err.message}`);
  cleanup();
  process.exit(1);
}
```

### 정적 프론트엔드 (Vite/Next 빌드 결과물)

빌드 산출물이 실제로 생겼고 비어 있지 않은지만 확인해도 상당수를 잡는다.

```js
// scripts/smoke.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIST = process.env.SMOKE_DIST || 'dist';     // Next면 '.next'
const MUST_EXIST = ['index.html'];                  // ← 프로젝트에 맞게

if (!fs.existsSync(DIST)) {
  console.error(`smoketest 실패: 빌드 산출물 없음 (${DIST}). 먼저 npm run build 가 성공해야 합니다.`);
  process.exit(1);
}
for (const rel of MUST_EXIST) {
  const p = path.join(DIST, rel);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
    console.error(`smoketest 실패: ${p} 없음 또는 비어 있음`);
    process.exit(1);
  }
  console.log(`  ✓ ${p} (${fs.statSync(p).size} bytes)`);
}
console.log('smoketest 통과');
```

### 크롤러 / 배치 스크립트

`--dry-run` 모드를 만들고 그걸 부른다. 외부에 쓰기를 하지 않으면서 코드 경로 전체를 태운다.

```json
{ "scripts": { "smoketest": "node src/index.js --dry-run --limit 1" } }
```

## 흔한 함정

| 증상 | 원인 |
|---|---|
| 검증이 항상 통과하는데 배포하면 깨짐 | 프로젝트에 `typecheck`/`lint`/`test`가 없어서 `build`만 돌고 있음 |
| `scripts.verify`를 만들었는데 테스트가 안 돎 | `verify`는 **단독 실행**. 그 안에 테스트를 포함시켜야 함 |
| `test:unit`만 있는데 안 돌아감 | 표준 `scripts.test`만 인식함 |
| smoketest가 매번 타임아웃 | `VERIFY_TEST_TIMEOUT_MS` 상향, 또는 부팅 대기 로직 확인 |
| smoketest가 포트 충돌로 실패 | 하네스가 도는 머신의 3000 포트는 하네스가 쓴다. 다른 포트를 쓸 것 |

## 확인 방법

프로젝트에 스크립트를 넣은 뒤, 하네스가 무엇을 실행할지 미리 보려면 그 프로젝트에서:

```bash
node -e "const p=require('./package.json').scripts||{};
console.log('verify.sh:', require('fs').existsSync('verify.sh'));
console.log('감지 대상:', Object.keys(p).filter(k=>['verify','typecheck','lint','test','build','smoketest'].includes(k)));"
```

`typecheck`/`lint`/`test`/`smoketest`가 나오면 정상이다. `build`만 나오면
검증이 사실상 없는 상태다.
