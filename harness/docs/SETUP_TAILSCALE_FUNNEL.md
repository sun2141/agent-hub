# 대시보드 ↔ 하네스 연결 — Tailscale Funnel (2026-09-06)

씽크패드 컷오버 후 대시보드가 하네스에 닿지 못하던 문제의 해법.

원래는 씽크패드 → Hetzner VPS 리버스 SSH 터널로 가려 했으나 **VPS의 22번 포트가
connection refused**라 진행 불가였다. Tailscale Funnel은 VPS도, 도메인도, 포트 개방도,
SSH도 필요 없다.

```
브라우저 → Vercel(harness-dashboard) → [vercel.json rewrite]
        → https://<머신>.<tailnet>.ts.net → 씽크패드 하네스 :3000
```

rewrite로 넘기므로 브라우저 입장에서는 same-origin이다. **CORS나 SameSite 쿠키 설정을
건드릴 필요가 없다** — 기존 인증이 그대로 동작한다.

## 알아둘 제약

| 항목 | 값 |
|---|---|
| 요금 | 무료 플랜 포함 |
| 공개 가능 포트 | **443 / 8443 / 10000 뿐** |
| 사전 조건 | MagicDNS 활성화 + 정책 파일에 funnel 노드 속성 |
| 주소 형식 | `https://<머신이름>.<tailnet>.ts.net` (고정) |

Funnel은 공개 인터넷에 열린다. 앞단에 하네스의 쿠키 세션 인증(`DASHBOARD_PASSWORD`)과
API 키가 이미 있지만, **`DASHBOARD_PASSWORD`가 비어 있지 않은지 반드시 확인할 것.**

## 방법 A — 윈도우 호스트에서 실행 (권장)

WSL2 안에서 `tailscaled`를 돌리려면 `/dev/net/tun`이 필요하고, 없으면
`--tun=userspace-networking`으로 우회해야 하는데 이 모드에서 Funnel 동작은 사례가 갈린다.
**윈도우 쪽에서 돌리면 그 문제가 통째로 사라진다.**

WSL2는 기본적으로 localhost 포워딩이 켜져 있어, WSL2에서 `0.0.0.0:3000`에 리슨 중인
하네스를 윈도우가 `127.0.0.1:3000`으로 그대로 본다.

```powershell
# 1. 윈도우에 Tailscale 설치 후 로그인 (GUI)

# 2. 관리자 PowerShell
tailscale funnel --bg 3000

# 3. 주소 확인
tailscale funnel status
```

출력에 나오는 `https://<머신>.<tailnet>.ts.net`이 공개 주소다.

**막히면 확인할 것**
- 관리 콘솔 → Access controls → **Add Funnel to policy** (노드 속성이 없으면 거부된다)
- 관리 콘솔 → DNS → **MagicDNS 활성화**
- 윈도우에서 `curl http://127.0.0.1:3000/health` — 여기가 안 되면 WSL2 포워딩 문제다

## 방법 B — WSL2 안에서 실행 (A가 안 될 때)

```bash
curl -fsSL https://tailscale.com/install.sh | sh

# /dev/net/tun 이 없으면 userspace 모드로
sudo mkdir -p /etc/default
echo 'FLAGS="--tun=userspace-networking"' | sudo tee /etc/default/tailscaled
sudo systemctl enable --now tailscaled
sudo tailscale up

tailscale funnel --bg 3000
tailscale funnel status
```

## 검증 — 반드시 이걸로 확인할 것

```bash
npm --prefix harness run endpoint:check https://<머신>.<tailnet>.ts.net
```

`/health`의 **pid를 로컬과 대조**한다. 200이 온다고 끝이 아니다 —
VPS 사례에서 터널이 끊긴 상태에서도 다른 무언가가 200을 돌려줬고, 그걸 통과로 봤다가
"붙은 것처럼 보이는데 엉뚱한 인스턴스"를 만들 뻔했다.

목표 API(`/api/goals`)와 인증 경로, WebSocket까지 함께 본다.

## Vercel 쪽 반영

`harness/dashboard/vercel.json`의 rewrite 대상을 새 주소로 바꾼다.

```json
{
  "rewrites": [
    { "source": "/health",      "destination": "https://<머신>.<tailnet>.ts.net/health" },
    { "source": "/auth/:path*", "destination": "https://<머신>.<tailnet>.ts.net/auth/:path*" },
    { "source": "/api/:path*",  "destination": "https://<머신>.<tailnet>.ts.net/api/:path*" },
    { "source": "/ws",          "destination": "https://<머신>.<tailnet>.ts.net/ws" },
    { "source": "/(.*)",        "destination": "/index.html" }
  ]
}
```

배포는 CLI로 한다 — GitHub 레포 `sun2141/harness-dashboard`는 5월 consolidate 때
아카이브되어 읽기 전용이고, 대시보드 소스는 `agent-hub/harness/dashboard/`로 옮겨졌다.

```bash
cd ~/agent-hub/harness/dashboard && npx vercel --prod
```

## 예전 VPS 정리

`http://91.99.58.70`이 아직 200을 돌려준다. 무엇이 응답하는지 확인되지 않았고 SSH도
막혀 있다. **같은 Neon DB와 같은 텔레그램 토큰을 쓰는 예전 하네스라면 작업 중복 실행과
텔레그램 409의 원인이 된다.** Hetzner 콘솔로 들어가 확인하고, 쓰지 않는다면 정리할 것.
