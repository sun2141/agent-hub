# 매니저 루프 (백로그 제안 → 승인 → 실행)

"감독형 자율(supervised autonomy)"의 2단계: 하네스가 프로젝트별 신호(미해결
이슈/실패한 작업/백로그 메모)를 스캔해 다음 작업 후보를 스스로 제안하고,
사용자가 텔레그램에서 승인한 항목만 실제 파이프라인으로 넘어간다.
승인된 작업은 direct push가 아니라 브랜치+PR로 완료되며, **병합은 항상
사용자가 수동으로** 한다.

## 확정 설계

| 항목 | 값 |
|---|---|
| 스캔 주기 | 수동 `/scan` + 자동 타이머(`MANAGER_SCAN_INTERVAL_MIN`, 기본 0=off) |
| 신호 소스 | **의도**: `directives/projects/{id}.md`의 `## Backlog` 섹션, GitHub 이슈 / **이력**: `needs_review`·`failed` 작업 |
| 제안 조건 | 의도 신호가 있어야 제안 (`MANAGER_REQUIRE_INTENT_SIGNAL`, 기본 true) |
| 제안 LLM | 독립 1회성 `claude --print` 호출 (파이프라인 세션/로그 DB와 결합 없음) |
| 승인 플로우 | 텔레그램 텍스트 명령만 (`/approve <id>`) — inline 버튼 없음 |
| 브랜치+PR 범위 | **매니저 승인 작업에만** 적용. 기존 `/run` 수동 작업은 기존 direct push 그대로 |
| 병합 | **자동 병합 없음** — `gh pr merge` 호출이 코드 어디에도 없음 |
| 상한 | 동시 실행 수(`MANAGER_MAX_CONCURRENT`) + 일일 승인 수(`MANAGER_MAX_APPROVALS_PER_DAY`) |
| 롤백 | `/rollback <projectId>` — 최근 완료 커밋을 `git revert --no-edit` + push (break-glass, 직접 실행) |

## 추가된 파일 (기존 동작 비파괴)

```
src/db/db.js                    # harness.backlog_items 테이블 + backlogQueries (additive)
                                 # harness.backlog_seen_signals 테이블 (신호 소진 기록)
                                 # harness.tasks: pr_url/branch_mode/branch_name 컬럼 추가
src/agent/manager.js            # 신호 수집 → LLM 제안 → backlog_items 저장 (신규)
src/agent/scanScheduler.js      # 자동 스캔 타이머 (신규, 기본 off)
src/agent/runner.js             # AgentRunner.run()에 branchMode/backlogItemId 파라미터 추가
                                 # (기본값 false — 기존 모든 호출부 무변경)
                                 # _ensureTaskBranch / _restoreBaseBranch / _maybeCreatePr 추가
                                 # _runCommitAndDeploy: branch_mode면 배포 스크립트 대신 PR 생성
src/telegram/bot.js             # /scan /backlog /approve /reject /rollback 명령 추가
src/index.js                    # 부팅 시 자동 스캔 스케줄러 기동
tests/manager_loop.test.js      # 순수 로직 회귀 테스트 (신규)
.env.example                    # MANAGER_LOOP 등 플래그
```

`MANAGER_LOOP=false`(기본)면 새 텔레그램 명령이 "비활성화" 응답만 하고
아무 실행 경로도 열리지 않는다. `AgentRunner.run()`의 `branchMode` 기본값도
`false`라, 매니저가 호출하지 않는 한 브랜치/PR 로직 자체에 진입하지 않는다.

## 신호 수집 → 제안 → 승인 흐름

1. `/scan` — 등록된 각 프로젝트에 대해:
   - 이미 활성 작업(`taskQueries.getActiveForProject`)이 있으면 스킵.
   - `needs_review`/`failed` 최근 작업, `backlog.md`, `gh issue list`(있으면)에서
     신호 수집 → `harness.backlog_seen_signals`에 이미 기록된 `(source, source_ref)`는 제외.
   - 신호가 있으면 `claude --print`로 "구체적이고 단일 스코프인 후보 최대 3개"를
     JSON으로 요청 → `harness.backlog_items`에 `status='proposed'`로 저장.
   - **제안이 실제로 저장된 뒤에만** 근거 신호를 `backlog_seen_signals`에 소진 기록한다.
     LLM 실패로 제안이 안 나온 신호는 기록되지 않아 다음 스캔에서 재시도된다.
   - 결과를 다이제스트 메시지 하나로 텔레그램 발송.
2. `/backlog` — 현재 `proposed` 상태 목록 재조회.
3. `/approve <id>` — 동시성/일일 상한 체크 → `agentRunner.run({..., branchMode: true})`
   → `harness.backlog_items.status='approved'`, `task_id` 연결.
4. `/reject <id>` — `status='rejected'`.

### 의도 신호 vs 이력 신호 — 잡일 루프를 막는 장치

이 루프의 목적은 **실제 개발 자동화**이지 하네스가 스스로 할 일을 지어내는 게 아니다.
그래서 신호를 두 종류로 나눈다.

| 종류 | 소스 | 역할 |
|---|---|---|
| **의도** | `directives/projects/{id}.md`의 `## Backlog` 섹션, GitHub 이슈 | 사람이 "이걸 하고 싶다"고 적은 것. **제안의 근거는 여기서만 나온다** |
| **이력** | 하네스 자신의 `needs_review`/`failed` 작업 | 참고용 맥락. 자기참조라 이것만으로는 제안 금지 |

이력 신호만으로 제안하면 "하네스가 자기 실패에 대한 후속 작업을 계속 만들어내는" 루프가 된다.
막는 방법 세 가지:

1. **게이트** — 의도 신호가 없는 프로젝트는 LLM 호출 없이 `no_intent_signal`로 스킵
   (`MANAGER_REQUIRE_INTENT_SIGNAL=false`로 해제). 스캔 다이제스트에 해당 프로젝트 이름과
   "Backlog에 적으세요" 안내가 함께 나간다.
2. **개수 비대칭** — 이력 신호는 최대 3개(`MANAGER_MAX_HISTORY_SIGNALS`), 의도 신호는 최대 8개.
3. **프롬프트 분리** — 두 블록을 명시적으로 구분하고, "요구사항 없는 리팩터링/테스트 추가/문서 정리
   제안 금지, 근거가 없으면 빈 배열 반환"을 지시한다.

### 백로그 작성 위치

```markdown
## Backlog

- [ ] 기도 목록 무한 스크롤 적용     ← 신호로 잡힘
- [x] 로그인 오류 수정               ← 완료 항목, 제외
```

`directives/projects/{id}.md`에 이 섹션을 두는 게 기본이고, 항목이 많아지면
`directives/projects/{id}/backlog.md` 전용 파일도 함께 읽는다.
`<!-- -->` 주석 안의 예시 불릿은 항목으로 잡지 않는다.

GitHub 이슈는 `**GitHub**: owner/repo`를 디렉티브 파일에서 읽는다(DB의 `project.github`가
비어 있을 때). `gh` 인증이 없으면 이슈 신호는 조용히 건너뛴다.

### 중복 제안 방지가 두 테이블로 나뉜 이유

`backlog_items.source`는 항상 `'manager_suggestion'`이고 `source_ref`는 자기 id다
(제안 자체는 언제나 신규). 그래서 제안 테이블만으로는 "이 GitHub 이슈 #12를 근거로
이미 제안한 적 있나?"를 판정할 수 없다. 원본 신호의 `(source, source_ref)`는
`backlog_seen_signals`가 따로 들고 있다.

`backlog.md` 줄의 `source_ref`는 줄 번호가 아니라 **내용 해시**다 — 줄 번호를 쓰면
파일 위쪽에 한 줄만 추가돼도 아래 항목 전부가 새 신호로 다시 잡힌다.

## 자동 스캔 (`MANAGER_SCAN_INTERVAL_MIN`)

`MANAGER_LOOP=true` **그리고** `MANAGER_SCAN_INTERVAL_MIN>0`일 때만 타이머가 생성된다.
자동화 범위는 **제안까지**다 — 승인은 여전히 `/approve`, 병합은 여전히 GitHub에서 수동.

스팸/비용 억제 3가지:

| 규칙 | 환경변수 | 기본값 |
|---|---|---|
| 조용한 시간대에는 스캔 안 함 | `MANAGER_SCAN_QUIET_HOURS` (`"23-8"`, 서버 로컬 시간, 끝 배타적) | `23-8` |
| 미결 제안이 쌓이면 스캔 건너뜀 | `MANAGER_MAX_PENDING` | `10` |
| 새 제안 0건이면 알림 안 보냄 | `MANAGER_SCAN_NOTIFY_EMPTY` | `false` |

스캔이 겹쳐 돌지 않도록 in-progress 락이 있고, 스캔 실패 알림은 1시간에 한 번만 나간다.

## 브랜치+PR 가드레일 (`branchMode: true`일 때만)

1. 파이프라인 시작 시 `task/<taskId>` 브랜치를 준비한다:
   - 이미 그 브랜치 위면 스킵(재개 시), 로컬에 있으면 checkout.
   - 없으면 `git fetch origin <base>` 후 **`origin/<base>`에서 분기**한다.
     현재 HEAD에서 분기하면 미병합 `task/*` 브랜치 위에 다음 작업이 쌓여
     PR diff에 남의 작업이 섞이고 순서대로만 병합할 수 있게 된다.
   - 워킹트리가 dirty하면 진행하지 않고 명확한 에러로 중단한다.
2. 각 빌드 라운드의 커밋은 `git push -u origin task/<taskId>`로 푸시(direct push 아님).
3. eval 합격 시 **배포 스크립트를 실행하지 않고** `gh pr create --head task/<taskId>`로
   PR을 열고(이미 있으면 재사용) `harness.tasks.pr_url`에 저장, 완료 알림에 링크 포함.
4. 파이프라인이 어떤 경로로 끝나든(완료/실패/일시중지) 워킹트리를 **base 브랜치로 복귀**시킨다.
   복귀하지 않으면 저장소가 `task/*`에 머물러서, 이후의 일반 `/run` 작업이 미병합 브랜치
   위에 커밋하고 그 브랜치로 direct push해버린다. (dirty면 복귀를 건너뛰고 경고만 남긴다.)
5. `gh pr merge`는 어디에도 호출하지 않음 — 병합은 사용자가 GitHub/gh에서 직접.

## 인증 전제조건 (1회, 실행 계정에서)

```bash
gh auth login   # repo 스코프 필요 — PR 생성에 사용
gh auth status  # 확인
```

로컬 개발 머신에서는 이미 인증되어 있을 수 있지만, **운영 환경(Hetzner VPS)에서도
별도로 `gh auth login`이 되어 있어야 `/approve` 후 PR 생성이 성공한다.** 인증이
안 되어 있으면 커밋/브랜치 push까지는 성공하고 PR 생성만 실패하며(로그에
`gh pr create 실패` 기록, `pr_url`은 null), 완료 알림에 PR 링크 없이 "PR 생성 실패"
로만 표시된다 — 브랜치는 이미 push되어 있으므로 GitHub에서 수동으로 PR을 열 수 있다.

## 롤백 (`/rollback <projectId>`)

가장 최근에 **direct push로** 완료된 작업의 커밋을 `git revert --no-edit` + push 한다.
break-glass 수단이라 사전 체크를 통과해야만 실행된다:

1. `branch_mode` 작업은 대상에서 제외 — 그 커밋은 미병합 `task/*` 브랜치에만 있어서
   기본 브랜치에서 revert할 수 없다. **매니저 승인 작업을 취소하려면 PR을 닫는다.**
2. 해당 프로젝트에 실행 중인 작업이 있으면 거부(에이전트가 쓰는 워킹트리를 건드리게 됨).
3. 워킹트리가 dirty하면 거부.
4. 현재 브랜치가 `task/*`면 거부.
5. 대상 커밋이 현재 HEAD의 조상이 아니면 거부(이미 되돌렸거나 다른 브랜치의 커밋).
6. revert가 충돌로 멈추면 `git revert --abort`로 저장소를 원상 복구한 뒤 실패 보고.

## 명시적 비범위 (V1)

- 자동 **승인** 없음 — 자동화되는 건 제안까지, `/approve`는 사람이.
- 대시보드 UI 변경 없음 — 텔레그램 전용 승인 플로우.
- inline keyboard/callback_query 없음 — 텍스트 명령만.
- 기존 `/run` 수동 작업에는 브랜치+PR 미적용.
- Vercel `vercel rollback` 같은 배포 프로바이더별 즉시 롤백 미구현 — git revert 기반만.

## 테스트

```bash
npm run test:manager   # 매니저 루프 순수 로직 회귀 테스트
npm test               # 경로 검증 (기존)
npm run test:mp        # 멀티 프로바이더 (기존)
```
