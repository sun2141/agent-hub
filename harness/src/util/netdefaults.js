// src/util/netdefaults.js
// 프로세스 전역 네트워크 기본값. index.js에서 "가장 먼저" import 한다.
//
// WSL2(윈도우 씽크패드)에서 텔레그램 전송이 EFATAL: AggregateError로 전부 실패한
// 사고에 대한 대응이다. 원인은 두 겹이었다:
//
//   ① api.telegram.org 는 AAAA(IPv6) 레코드를 응답하는데 WSL2에는 IPv6 경로가
//      없다 → IPv6 시도는 즉시 ENETUNREACH.
//   ② Node 20+ 의 Happy Eyeballs(autoSelectFamily)는 첫 주소가 250ms 안에
//      연결되지 않으면 다음 주소로 넘어간다. 텔레그램(유럽) 왕복은 한국에서
//      약 300~800ms라 IPv4가 매번 이 문턱을 못 넘고 IPv6로 넘어가 죽었다.
//
// ①만 고치면(--dns-result-order=ipv4first) 순서만 바뀌고 250ms 경합은 그대로라
// 증상이 남는다. ②까지 같이 올려야 한다.
//
// Neon(DB)이나 GitHub는 멀쩡했던 이유: AAAA 레코드가 없어서 경합 자체가 없었다.

import dns from 'dns';
import net from 'net';

// IPv6 경로가 있는 정상 환경에서 되돌리려면 DNS_RESULT_ORDER=verbatim
if (process.env.DNS_RESULT_ORDER !== 'verbatim') {
  try { dns.setDefaultResultOrder('ipv4first'); } catch { /* 구버전 Node */ }
}

// 기본 250ms → 3초. 고지연 링크에서 첫 주소(IPv4)가 연결될 시간을 준다.
export const NET_AUTOSELECT_TIMEOUT_MS = Math.max(
  10,
  Number(process.env.NET_AUTOSELECT_TIMEOUT_MS) || 3000
);

try {
  net.setDefaultAutoSelectFamilyAttemptTimeout(NET_AUTOSELECT_TIMEOUT_MS);
} catch { /* 구버전 Node */ }

export function netDefaultsSummary() {
  const order = typeof dns.getDefaultResultOrder === 'function' ? dns.getDefaultResultOrder() : '?';
  const timeout = typeof net.getDefaultAutoSelectFamilyAttemptTimeout === 'function'
    ? net.getDefaultAutoSelectFamilyAttemptTimeout() : '?';
  return `dns=${order}, autoSelectFamilyTimeout=${timeout}ms`;
}
