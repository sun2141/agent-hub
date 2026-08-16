# 노출 위험 정리 — 상시 가동 하네스

씽크패드를 24시간 켜두고 에이전트가 무인으로 코드를 쓰는 구조에서, 실제로
위험한 지점만 모았습니다. 각 항목은 **무엇이 노출되나 / 왜 그런가 / 어떻게 줄이나** 순서입니다.

우선순위: 🔴 즉시 조치 · 🟡 인지하고 운영 · 🟢 상황에 따라

---

## 🔴 1. `.env` 하나가 모든 것의 열쇠

`harness/.env` 한 파일에 아래가 평문으로 들어 있습니다.

| 값 | 유출 시 |
|---|---|
| `NEON_DATABASE_URL` | 하네스 DB 전체 읽기·쓰기 |
| `TELEGRAM_BOT_TOKEN` | 봇 완전 장악 — 남이 `/run`, `/approve`, `/rollback` 실행 가능 |
| `GITHUB_TOKEN` (`ghp_…`) | 토큰 스코프 범위의 저장소 쓰기 |
| `ANTHROPIC_API_KEY` | API 과금 |
| `SUPABASE_*` | 해당 프로젝트 백엔드 |
| `API_KEY`, `DASHBOARD_PASSWORD` | 대시보드/API 접근 |

**조치**

- `.env`는 `.gitignore`에 있습니다. 다만 **`git status`에 뜨는지 가끔 확인**하세요.
- 파일 권한을 600으로 (이관 스크립트가 자동으로 합니다):
  `chmod 600 harness/.env`
- `GITHUB_TOKEN`이 classic PAT(`ghp_`)이면 **fine-grained 토큰으로 교체**하고
  대상 저장소·권한을 최소로 좁히세요. 지금은 계정 전체 범위일 가능성이 큽니다.
- 맥과 씽크패드 양쪽에 같은 비밀값이 존재하게 됩니다. 컷오버가 끝나면
  맥 쪽 `.env`는 지우거나 최소한 다시 쓰지 않는다는 걸 확실히 하세요.

## 🔴 2. 이관용 `~/env-from-mac` — 가장 흔한 사고 지점

USB, 클라우드 드라이브, 메신저로 옮기면 **그 경로에 평문 비밀값이 남습니다.**
USB는 삭제해도 복구 가능하고, 클라우드는 휴지통·버전 기록에 남습니다.

**조치**

- 가능하면 `scp`로 직접 전송 (중간 저장 없음):
  `scp ~/env-from-mac sun@thinkpad:~/`
- 클라우드 드라이브·카카오톡·이메일로는 **보내지 마세요.**
- 이관 직후 양쪽에서 삭제: `rm ~/env-from-mac` (설치 스크립트가 물어봅니다)
- USB를 썼다면 그 USB를 포맷하세요.

## 🔴 3. 에이전트가 확인 없이 파일을 쓴다 — `PROJECTS_ROOT` 범위가 곧 사정권

하네스는 CLI를 `--dangerously-skip-permissions`로 호출합니다
(`runner.js`, `providers/claude.js`, `manager.js` 세 곳). 무인 운영이라 필연적이지만,
**확인 프롬프트 없이 파일을 쓰고 명령을 실행한다**는 뜻입니다.

에이전트가 닿을 수 있는 범위는 `.env`의 `PROJECTS_ROOT` 하나로 정해집니다
(`_validateProjectPath`가 그 밖을 거부).

**조치**

- `PROJECTS_ROOT`를 **절대 `$HOME`으로 두지 마세요.** 그러면 `~/.ssh/id_rsa`,
  `~/.codex/auth.json`, 다른 프로젝트의 `.env`가 전부 사정권입니다.
- 전용 디렉토리를 쓰세요 (이관 스크립트 기본값):
  ```ini
  PROJECTS_ROOT=/home/sun/projects
  ```
  그리고 프로젝트는 전부 그 아래에 clone.
- 확인: `grep PROJECTS_ROOT harness/.env`

## 🟡 4. 키링 비밀번호 비우기 — 의도적 트레이드오프

`setup-antigravity-keyring.sh empty`는 GNOME 로그인 키링의 비밀번호를 빈 값으로
만듭니다. 이게 없으면 자동 로그인 부팅 시 키링이 잠겨 `agy`가 매번 재인증을 요구하고,
무인 운영이 깨집니다.

**대가**: 이 노트북에 로그인할 수 있는 사람은 키링에 저장된 자격증명을 읽을 수 있습니다.

**조치**

- 24시간 켜둔 노트북이므로 **물리 접근 통제가 전제**입니다. 잠금 화면 필수,
  가족·사무실 공용 공간이면 재고하세요.
- 디스크 암호화(LUKS)가 안 돼 있으면, 노트북을 들고 갔을 때 디스크째 읽힙니다.
  확인: `lsblk -f | grep -i crypt` — 결과가 없으면 미암호화입니다.
  이미 설치된 시스템은 사후 암호화가 번거로우니, 최소한 **BIOS 비밀번호 + 잠금 화면**은
  걸어두세요.
- 보안이 더 중요하면 `empty` 대신 `pam` 방식(자동 로그인 끄고 PAM 자동 해제)을 쓰세요.

## 🟡 5. 대시보드가 인터넷에 열린다

Cloudflare 터널 + Vercel로 폰에서 접속하는 구조입니다. 즉 **로컬 3000 포트가
공개 URL로 노출**됩니다.

보호 장치는 있습니다 — `API_KEY` 또는 `DASHBOARD_PASSWORD` 세션 인증이 모든
`/api/*`에 걸려 있고, 미설정이면 503을 반환합니다.

**조치**

- 터널로 HTTPS 노출한다면 `.env`에서:
  ```ini
  COOKIE_SECURE=true
  ```
  현재 `false`입니다. HTTP 로컬 접속 전용일 때만 `false`가 맞습니다.
- `DASHBOARD_PASSWORD`를 추측 가능한 값에서 긴 랜덤으로 바꾸세요.
  현재 값이 짧은 숫자 조합이면 특히 그렇습니다.
- 터널을 항상 켜둘 필요가 없다면 필요할 때만 띄우는 것도 방법입니다
  (텔레그램만으로도 승인 플로우는 전부 됩니다).

## 🟡 6. 텔레그램 봇 — 인가는 되어 있음

`chat_id` 검증이 들어가 있습니다(`isAuthorized`). 등록된 `TELEGRAM_CHAT_ID`가
아니면 명령이 무시되고 로그에 기록됩니다. **이 부분은 안전합니다.**

다만 `TELEGRAM_BOT_TOKEN`이 유출되면 공격자가 자기 봇으로 붙는 게 아니라
**당신의 봇을 조종**할 수 있습니다. 1번 항목과 같은 위험입니다.

## 🟡 7. eval 통과 시 자동으로 main에 push된다

`.env`의 `DEPLOY_METHOD=push`입니다. 매니저 승인 작업(branch mode)은 PR로 가지만,
**기존 `/run` 수동 작업은 eval 통과 시 `git push origin main`을 직접 실행**합니다.
Vercel 자동 배포가 걸려 있으면 리뷰 없이 프로덕션에 나갑니다.

**조치**

- 프로덕션 프로젝트라면 GitHub에서 `main` **브랜치 보호 규칙**을 켜세요
  (PR 필수 + CI 통과 필수). 그러면 direct push가 막히고 PR 경로만 남습니다.
- 또는 `DEPLOY_METHOD=none`으로 두고 커밋만 하게 한 뒤 직접 push.

## 🟢 8. 로그에 남는 것

`harness.logs` 테이블(Neon)과 `journalctl`에 에이전트 출력이 그대로 쌓입니다.
코드에 비밀값이 들어 있으면 로그에도 들어갑니다.

**조치**

- Neon DB 접근 권한을 최소로.
- 작업 프롬프트에 비밀값을 직접 쓰지 마세요 (`.env` 참조로).

## 🟢 9. 프로바이더 인증 파일

| 파일 | 성격 |
|---|---|
| `~/.codex/auth.json` | ChatGPT 세션. **제자리 갱신** — 두 인스턴스 동시 실행 시 손상 |
| `~/.claude-harness/` | Claude 인증. 하네스 전용으로 분리해두는 게 좋습니다 |
| GNOME 키링 | agy 토큰 |

**조치**: 백업하지 마세요(백업본이 곧 유출 경로). 손상되면 재로그인이 빠릅니다.

---

## 설치 후 5분 점검

```bash
cd ~/agent-hub/harness

# 1. .env 권한
ls -l .env                                  # -rw------- 이어야 함

# 2. 에이전트 사정권 — $HOME 이면 즉시 수정
grep PROJECTS_ROOT .env

# 3. 이관 파일 잔재
ls ~/env-from-mac 2>/dev/null && echo "!! 삭제하세요: rm ~/env-from-mac"

# 4. .env가 git에 안 잡히는지
cd .. && git status --short | grep -i env    # 아무것도 안 나와야 정상

# 5. 디스크 암호화 여부
lsblk -f | grep -i crypt || echo "미암호화 — BIOS 비밀번호/잠금화면 필수"
```

## 지금 당장 할 가치가 있는 것 3개

1. `PROJECTS_ROOT`를 `$HOME`이 아닌 전용 디렉토리로 (3번)
2. `GITHUB_TOKEN`을 fine-grained로 교체 (1번)
3. 프로덕션 저장소에 `main` 브랜치 보호 규칙 (7번)

나머지는 인지하고 운영하면 되는 수준입니다.
