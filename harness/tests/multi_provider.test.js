// tests/multi_provider.test.js
// 멀티 프로바이더 정책 + phaseDispatch 루프 검증 (DB 불필요 — 인메모리 store 주입).
// 실행: node tests/multi_provider.test.js

import assert from 'assert';
import { selectProvider, markLimit, waitMsUntil } from '../src/agent/dispatcher.js';
import { runPhase } from '../src/agent/phaseDispatch.js';
import { toUtcString, minutesFromNow } from '../src/agent/providers/base.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

// ── 인메모리 provider store (providerQueries 인터페이스 모사) ──
function makeStore(initial) {
  // initial: { name: { weight, state, next_available_at, window_type } }
  const rows = Object.entries(initial).map(([provider, v]) => ({
    provider, enabled: 1, weight: v.weight ?? 100,
    state: v.state ?? 'available',
    next_available_at: v.next_available_at ?? null,
    window_type: v.window_type ?? null,
  }));
  const nowStr = () => toUtcString(new Date());
  return {
    _rows: rows,
    async listEnabled() { return [...rows].sort((a, b) => b.weight - a.weight); },
    async reclaimExpired() {
      const now = nowStr(); const out = [];
      for (const r of rows) {
        if (r.state === 'cooling' && r.next_available_at && r.next_available_at <= now) {
          r.state = 'available'; r.next_available_at = null; r.window_type = null; out.push({ provider: r.provider });
        }
      }
      return out;
    },
    async markCooling(provider, { nextAvailableAt, windowType }) {
      const r = rows.find(x => x.provider === provider);
      if (r) { r.state = 'cooling'; r.next_available_at = nextAvailableAt; r.window_type = windowType; }
    },
    async earliestResetAt() {
      const cooling = rows.filter(r => r.state === 'cooling' && r.next_available_at)
        .sort((a, b) => a.next_available_at.localeCompare(b.next_available_at));
      return cooling[0] ? { provider: cooling[0].provider, next_available_at: cooling[0].next_available_at } : null;
    },
  };
}

// 목 어댑터: 지정한 프로바이더는 limit 반환, 나머지는 ok.
function mockAdapters({ limitProviders = {}, sessionId = 'sess-x' } = {}) {
  const make = (nm) => ({
    name: nm,
    async run() {
      if (limitProviders[nm]) {
        const { resetMin = 60, windowType = '5h' } = limitProviders[nm];
        return { status: 'limit', limitHit: true, resetAt: minutesFromNow(resetMin), windowType, provider: nm };
      }
      return { status: 'ok', output: `done-by-${nm}`, sessionId, provider: nm };
    },
  });
  return { claude: make('claude'), codex: make('codex'), antigravity: make('antigravity') };
}

// dispatcher.selectProvider를 store/adapter 주입 버전으로 감싼 deps 생성
function makeDeps(store, adapters) {
  return {
    selectProvider: async ({ phase, busy }) => {
      const sel = await selectProvider({ phase, busy, store });
      if (sel.action === 'run') sel.adapter = adapters[sel.provider];
      return sel;
    },
    markLimit: (provider, opts) => markLimit(provider, opts, store),
  };
}

async function main() {
  // 1) Build 정상: 선호(claude)로 실행
  {
    const store = makeStore({ claude: { weight: 100 }, antigravity: { weight: 90 }, codex: { weight: 70 } });
    const adapters = mockAdapters();
    const res = await runPhase({ phase: 'build', prompt: 'x', deps: makeDeps(store, adapters) });
    assert.equal(res.status, 'ok'); assert.equal(res.provider, 'claude');
    ok('Build → 선호 claude 실행');
  }

  // 2) Build 페일오버: claude 리미트 → antigravity로 로테이션
  {
    const store = makeStore({ claude: { weight: 100 }, antigravity: { weight: 90 }, codex: { weight: 70 } });
    const adapters = mockAdapters({ limitProviders: { claude: { resetMin: 90, windowType: '5h' } } });
    const events = [];
    const res = await runPhase({ phase: 'build', prompt: 'x', deps: makeDeps(store, adapters), onEvent: (t, p) => events.push([t, p.provider]) });
    assert.equal(res.status, 'ok'); assert.equal(res.provider, 'antigravity');
    assert.deepEqual(res.tried, ['claude', 'antigravity']);
    assert.ok(store._rows.find(r => r.provider === 'claude').state === 'cooling');
    ok('Build 페일오버 → claude cooling 후 antigravity');
  }

  // 3) 핀 고정(eval): 선호(codex) 리미트 → 페일오버 안 하고 대기
  {
    const store = makeStore({ claude: { weight: 100 }, antigravity: { weight: 90 }, codex: { weight: 70 } });
    const adapters = mockAdapters({ limitProviders: { codex: { resetMin: 120, windowType: '5h' } } });
    const res = await runPhase({ phase: 'eval', prompt: 'x', deps: makeDeps(store, adapters) });
    assert.equal(res.status, 'wait'); assert.equal(res.provider, 'codex');
    assert.ok(waitMsUntil(res.resumeAt) > 100 * 60_000);
    ok('Eval 핀 고정 → codex 리미트 시 페일오버 없이 대기');
  }

  // 4) 핀 고정 + weekly 강등: 선호(codex)가 weekly면 페일오버 허용
  {
    const store = makeStore({
      claude: { weight: 100 }, antigravity: { weight: 90 },
      codex: { weight: 70, state: 'cooling', next_available_at: minutesFromNow(3 * 24 * 60), window_type: 'weekly' },
    });
    const adapters = mockAdapters();
    const res = await runPhase({ phase: 'eval', prompt: 'x', deps: makeDeps(store, adapters) });
    assert.equal(res.status, 'ok'); assert.equal(res.provider, 'claude'); // weight 최고 가용
    ok('Eval weekly 강등 → 가용 프로바이더로 페일오버');
  }

  // 5) 전부 cooling → 가장 빠른 리셋까지 wait
  {
    const store = makeStore({
      claude: { weight: 100, state: 'cooling', next_available_at: minutesFromNow(50), window_type: '5h' },
      antigravity: { weight: 90, state: 'cooling', next_available_at: minutesFromNow(20), window_type: '5h' },
      codex: { weight: 70, state: 'cooling', next_available_at: minutesFromNow(200), window_type: 'weekly' },
    });
    const adapters = mockAdapters();
    const res = await runPhase({ phase: 'build', prompt: 'x', deps: makeDeps(store, adapters) });
    assert.equal(res.status, 'wait'); assert.equal(res.provider, 'antigravity'); // 20분이 가장 빠름
    ok('전부 cooling → 최빠른 리셋(antigravity)까지 대기');
  }

  // 6) 단일 실행: busy 프로바이더는 선택 제외
  {
    const store = makeStore({ claude: { weight: 100 }, antigravity: { weight: 90 }, codex: { weight: 70 } });
    const adapters = mockAdapters();
    // build 선호 claude가 busy → 페일오버로 antigravity
    const res = await runPhase({ phase: 'build', prompt: 'x', busy: new Set(['claude']), deps: makeDeps(store, adapters) });
    assert.equal(res.status, 'ok'); assert.equal(res.provider, 'antigravity');
    ok('단일 실행 → busy claude 제외하고 antigravity');
  }

  // 7) 만료 회수: 지난 cooling은 available 복귀
  {
    const store = makeStore({
      claude: { weight: 100, state: 'cooling', next_available_at: toUtcString(new Date(Date.now() - 60_000)), window_type: '5h' },
      antigravity: { weight: 90 }, codex: { weight: 70 },
    });
    const adapters = mockAdapters();
    const res = await runPhase({ phase: 'build', prompt: 'x', deps: makeDeps(store, adapters) });
    assert.equal(res.status, 'ok'); assert.equal(res.provider, 'claude'); // 회수되어 선호로 복귀
    ok('만료 회수 → 지난 cooling claude 복귀 후 선호 실행');
  }

  console.log(`\n[multi_provider] ${passed}개 통과`);
}

main().catch(err => { console.error('테스트 실패:', err); process.exit(1); });
