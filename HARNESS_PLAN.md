# Agent Harness System - Architecture & Implementation Plan

> 작성일: 2026-04-05
> 목표: 휴대폰에서 여러 프로젝트의 에이전트를 제어하고 시각화하는 통합 시스템

---

## 1. 현재 인프라 현황

### VPS (Hetzner CX23)
| 항목 | 값 |
|------|-----|
| OS | Ubuntu 24.04 |
| CPU | 2 vCPU |
| RAM | 4GB (700MB 사용 / 3GB 가용) |
| Disk | 40GB NVMe (8.9GB 사용 / 27GB 가용) |
| Swap | 없음 |
| 위치 | Germany (Falkenstein) |
| 비용 | €3.99/month |
| IP | 91.99.58.70 |

### VPS 설치된 소프트웨어
| 소프트웨어 | 버전 | 비고 |
|-----------|------|------|
| Node.js | v22.22.0 | |
| Python | 3.12.3 | |
| Claude Code | 2.1.42 | API 키 설정됨 |
| PM2 | 설치됨 | 프로세스 관리 |
| jq | 설치됨 | JSON 처리 |
| Docker | 미설치 | |
| Nginx | 미설치 | |

### VPS에서 실행 중인 서비스
| 서비스 | 포트 | 설명 |
|--------|------|------|
| telegram-bot | - | Claude Code 텔레그램 인터페이스 (PM2) |
| Antigravity Proxy | 8080 | Claude API 프록시/폴백 |
| SSH | 22 | |

### 프로젝트 현황
| 프로젝트 | 크기 | 상태 | 기술 |
|----------|------|------|------|
| palmoni | 276MB | 활성 | React + Vite |
| facepick | 572MB | 활성 | Next.js |
| reddit-insight | 115MB | 비활성 | Node.js |
| grace-ai.bak | 288MB | 백업 | - |
| prayer-app.bak | 968MB | 백업 | - |

### 기존 오케스트레이터 (bash 기반)
- **git-sync.sh**: 5분마다 git pull + 텔레그램 알림
- **monitor.sh**: 10분마다 빌드/서비스 상태 체크 + 자동 수정
- **orchestrate.sh**: 하루 2회 태스크 큐 실행
- **notify.sh**: 텔레그램 양방향 통신 (알림 + 승인 요청)
- **provider.sh**: Claude ↔ Antigravity 자동 프로바이더 전환

### Claude Code Hooks (VPS settings.json)
```json
{
  "hooks": {
    "Stop": [{ "command": "telegram_notify.sh" }],
    "SubagentStop": [{ "command": "telegram_notify.sh" }],
    "Notification": [{ "command": "telegram_notify.sh" }]
  }
}
```

---

## 2. 목표 시스템 아키텍처

```
+------------------+
|   휴대폰 (PWA)    |  ← 제어 & 시각화 인터페이스
|  모바일 대시보드    |
+--------+---------+
         |
         | WebSocket + REST API (HTTPS)
         |
+--------+---------+
|  VPS (Hetzner)   |  ← 중앙 허브
|                  |
|  ┌─────────────┐ |
|  │ Harness API │ |  ← Node.js 서버 (Express + WS)
|  │  :3000      │ |
|  └──────┬──────┘ |
|         │        |
|  ┌──────┴──────┐ |
|  │ Agent Pool  │ |  ← Claude Code 인스턴스 관리
|  │ (PM2 기반)  │ |
|  └──────┬──────┘ |
|         │        |
|  ┌──────┴──────┐ |
|  │ Projects    │ |  ← palmoni, facepick, ...
|  │ (git repos) │ |
|  └─────────────┘ |
+------------------+
         |
         | SSH tunnel (선택)
         |
+--------+---------+
|  로컬 Mac (선택)  |  ← 무거운 빌드/테스트 위임
|  로컬 에이전트     |
+------------------+
```

---

## 3. 기능 분리

### Layer 1: Harness API (VPS)
중앙 제어 서버. 모든 명령의 진입점.

| 기능 | 설명 |
|------|------|
| 프로젝트 관리 | 프로젝트 목록, 상태, git 정보 |
| 에이전트 제어 | 시작, 중지, 프롬프트 전송, 결과 수신 |
| 작업 큐 | 작업 등록, 우선순위, 스케줄링 |
| 실시간 스트리밍 | WebSocket으로 에이전트 출력 스트리밍 |
| 인증 | API 키 또는 텔레그램 인증 |
| 상태 저장 | SQLite로 작업 이력, 에이전트 상태 보관 |

### Layer 2: Agent Pool (VPS)
Claude Code 인스턴스 생명주기 관리.

| 기능 | 설명 |
|------|------|
| 인스턴스 관리 | PM2로 Claude Code 프로세스 제어 |
| 병렬 실행 | 최대 2개 동시 (2 vCPU 제약) |
| 워크트리 격리 | 프로젝트별 git worktree로 충돌 방지 |
| 출력 캡처 | `claude --print --output-format stream-json` |
| 비용 추적 | 토큰 사용량, API 호출 횟수 기록 |
| 프로바이더 전환 | 기존 Claude ↔ Antigravity 로직 재사용 |

### Layer 3: Mobile Dashboard (PWA)
휴대폰 최적화 웹 인터페이스.

| 기능 | 설명 |
|------|------|
| 프로젝트 목록 | 각 프로젝트 상태, 최근 커밋, 빌드 상태 |
| 에이전트 뷰 | 실행 중인 에이전트의 실시간 출력 |
| 명령 전송 | 텍스트 입력으로 에이전트에 작업 지시 |
| 알림 | 작업 완료, 오류, 승인 요청 (Push + 텔레그램) |
| 이력 | 과거 작업 목록, diff 요약, 비용 |

---

## 4. VPS 리소스 제약 및 대응

### 제약 사항
| 리소스 | 한계 | 영향 |
|--------|------|------|
| CPU 2코어 | Claude Code 병렬 실행 시 경합 | 동시 에이전트 2개 제한 |
| RAM 4GB | Claude Code 1개당 ~200-500MB | 에이전트 2-3개 + API 서버 가능 |
| Swap 없음 | OOM 위험 | Swap 2GB 추가 필요 |
| 디스크 27GB 여유 | 백업 파일이 1.2GB 차지 | 백업 정리하면 충분 |

### 대응 방안
1. **Swap 2GB 추가** — OOM 방지
2. **백업 정리** — `grace-ai.bak`, `prayer-app.bak` 삭제 (1.2GB 확보)
3. **에이전트 큐잉** — 동시 2개, 나머지는 대기열
4. **Nginx 리버스 프록시** — HTTPS, WebSocket 프록싱
5. **로컬 Mac 위임 (선택)** — 빌드/테스트만 SSH tunnel로 위임

---

## 5. 필요 작업 목록

### Phase 0: VPS 인프라 정비 (1일)
- [ ] Swap 2GB 추가 (`fallocate -l 2G /swapfile`)
- [ ] 백업 폴더 정리 (grace-ai.bak, prayer-app.bak)
- [ ] Nginx 설치 + Let's Encrypt SSL (도메인 필요하면 서브도메인)
- [ ] 방화벽 설정 (80, 443 개방 / 3000 내부만)
- [ ] Claude Code API 키 환경변수 정리 (~/.bashrc → ~/.env)
- [ ] git-sync.sh SIGPIPE 버그 수정 완료 확인

### Phase 1: Harness API 서버 (2-3일)
- [ ] 프로젝트 초기화 (`~/workspace/harness/`)
- [ ] Express + WebSocket 서버 뼈대
- [ ] SQLite 스키마 (projects, agents, tasks, logs)
- [ ] REST API 엔드포인트:
  - `GET /api/projects` — 프로젝트 목록 + 상태
  - `GET /api/projects/:id/status` — git, 빌드, 에이전트 상태
  - `POST /api/agents/run` — 에이전트 시작 (프로젝트 + 프롬프트)
  - `DELETE /api/agents/:id` — 에이전트 중지
  - `GET /api/agents` — 실행 중인 에이전트 목록
  - `GET /api/tasks` — 작업 이력
- [ ] WebSocket 엔드포인트:
  - `ws://host/ws/agent/:id` — 에이전트 출력 실시간 스트리밍
  - `ws://host/ws/dashboard` — 전체 상태 변경 알림
- [ ] 인증 미들웨어 (API 키 or JWT)
- [ ] 기존 오케스트레이터 cron 작업 통합

### Phase 2: Agent Pool 관리 (2일)
- [ ] Claude Code CLI wrapper 모듈
  - `claude --print --output-format stream-json` 실행
  - stdout 파싱 → WebSocket 브로드캐스트
  - 종료 감지 → 결과 저장
- [ ] 프로젝트별 CLAUDE.md 자동 주입
- [ ] git worktree 생성/정리 자동화
- [ ] 동시 실행 제한 (세마포어, 최대 2)
- [ ] 프로바이더 전환 로직 포팅 (기존 provider.sh → JS)
- [ ] PM2 연동 (프로세스 등록/모니터링)

### Phase 3: Mobile Dashboard (3-4일)
- [ ] React PWA 프로젝트 (Vite, 모바일 최적화)
- [ ] 화면 구성:
  - **홈**: 프로젝트 카드 그리드 (상태 badge, 최근 커밋)
  - **에이전트 뷰**: 실행 중 에이전트 터미널 스트리밍
  - **명령 입력**: 프로젝트 선택 + 프롬프트 입력
  - **이력**: 작업 목록 + diff 요약 + 비용
  - **설정**: API 키, 알림 설정
- [ ] WebSocket 연결 (실시간 에이전트 출력)
- [ ] PWA manifest + 서비스 워커
- [ ] 텔레그램 알림 연동 유지 (Push 알림 보조)

### Phase 4: 통합 및 프로젝트 적용 (1-2일)
- [ ] 기존 오케스트레이터 마이그레이션 (bash → harness API)
- [ ] palmoni CLAUDE.md + hooks 연동
- [ ] facepick CLAUDE.md + hooks 연동
- [ ] 텔레그램 봇 → harness API 브릿지 (기존 봇 유지)
- [ ] E2E 테스트: 휴대폰에서 palmoni 작업 지시 → 결과 확인

### Phase 5: 고급 기능 (선택, 추후)
- [ ] 로컬 Mac 연동 (SSH tunnel, 빌드 위임)
- [ ] 에이전트 간 협업 (하나가 코드, 하나가 리뷰)
- [ ] 비용 대시보드 (일별/프로젝트별 API 비용)
- [ ] 작업 템플릿 (자주 쓰는 프롬프트 저장)
- [ ] GitHub webhook 연동 (PR, Issue → 자동 작업 생성)

---

## 6. 기술 스택 결정

| 구성요소 | 기술 | 이유 |
|----------|------|------|
| Harness API | Node.js + Express | VPS에 이미 Node 22, 가볍고 빠름 |
| WebSocket | ws 라이브러리 | Express와 통합 쉬움 |
| DB | SQLite (better-sqlite3) | 파일 기반, VPS에 적합, 별도 서비스 불필요 |
| 프로세스 관리 | PM2 | 이미 사용 중 |
| 리버스 프록시 | Nginx | SSL, WebSocket 프록싱 |
| Dashboard | React + Vite (PWA) | palmoni/facepick과 동일 스택, 빌드 후 Nginx에서 서빙 |
| 인증 | API 키 + HTTPS | 단순하고 안전 |

---

## 7. VPS만으로 가능한 범위 vs 로컬 필요한 범위

### VPS만으로 가능
- 에이전트 제어 (시작, 중지, 프롬프트)
- 실시간 출력 스트리밍
- git 관리 (sync, commit, push)
- 코드 수정 (Claude Code가 직접)
- 린트, 타입 체크
- 경량 빌드 (Vite 빌드 ~7초)
- 텔레그램 알림
- 모바일 대시보드 호스팅

### 로컬 Mac 필요 (선택적)
- 무거운 빌드 (Next.js 풀 빌드 시 메모리 이슈 가능)
- E2E 테스트 (브라우저 필요)
- iOS 시뮬레이터 테스트
- 3개 이상 에이전트 동시 실행

> **결론**: VPS 단독으로 MVP 충분. 로컬 연동은 Phase 5에서 필요 시 추가.

---

## 8. 보안 고려사항

- [ ] Nginx HTTPS 필수 (Let's Encrypt)
- [ ] API 인증 (모든 엔드포인트)
- [ ] Claude Code 권한 제한 (프로젝트 디렉토리만)
- [ ] 환경변수/API 키 노출 방지
- [ ] rate limit (외부 접근 차단)
- [ ] 텔레그램 chat_id 검증 (기존 로직 유지)

---

## 9. 작업 순서 요약

```
Phase 0 (인프라)  ──→  Phase 1 (API)  ──→  Phase 2 (Agent Pool)
                                                    │
                                              Phase 3 (Dashboard)
                                                    │
                                              Phase 4 (적용)
                                                    │
                                              Phase 5 (고급, 선택)
```

예상 총 기간: **Phase 0~4 약 9~12일** (에이전트 활용 시 단축 가능)

---

## 10. 시작 전 결정 필요 사항

1. **도메인**: 대시보드용 서브도메인이 있는가? (예: `agent.yourdomain.com`)
   - 없으면 IP + 포트로 시작, 나중에 도메인 연결
2. **로컬 Mac 연동**: Phase 5로 미룰 것인가?
3. **기존 텔레그램 봇**: harness와 병행 운영? 완전 대체?
4. **Antigravity 프록시**: 유지? harness API에 통합?
5. **백업 폴더 삭제**: `grace-ai.bak`, `prayer-app.bak` 삭제 가능?
