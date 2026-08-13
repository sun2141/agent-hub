// src/agent/providers/index.js
// 프로바이더 어댑터 레지스트리. 디스패처는 이름으로 어댑터를 조회한다.

import * as claude from './claude.js';
import * as codex from './codex.js';
import * as antigravity from './antigravity.js';

export const adapters = { claude, codex, antigravity };

export function getAdapter(name) {
  const a = adapters[name];
  if (!a) throw new Error(`알 수 없는 프로바이더: ${name}`);
  return a;
}

export const PROVIDER_NAMES = Object.keys(adapters);
