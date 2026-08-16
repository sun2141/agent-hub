# WSL2(윈도우 씽크패드) 하네스 상시 가동 셋업

윈도우를 유지한 채, 그 안의 우분투(WSL2)에서 하네스를 24시간 돌리는 구성.
데스크톱 우분투 설치본은 [`SETUP_THINKPAD.md`](./SETUP_THINKPAD.md)를 보세요.

---

## 0. 윈도우에서 WSL2 설치 (1회)

**PowerShell을 관리자 권한으로** 열고:

```powershell
wsl --install -d Ubuntu-24.04
```

재부팅 후 우분투 터미널이 열리면서 사용자명·비밀번호를 물어봅니다.
여기서 만든 계정이 하네스를 돌릴 리눅스 사용자입니다.

이미 WSL이 깔려 있다면 버전을 확인하세요 (반드시 **2**):

```powershell
wsl -l -v
# VERSION 이 1이면:  wsl --set-version Ubuntu-24.04 2
```

## 1. systemd 켜기 ⭐

WSL은 기본적으로 systemd 없이 뜹니다. **부팅 시 자동 시작에 반드시 필요합니다.**

우분투 터미널에서:

```bash
sudo tee -a /etc/wsl.conf <<'EOF'

[boot]
systemd=true
EOF
```

윈도우 PowerShell에서 WSL을 완전히 껐다 켭니다:

```powershell
wsl --shutdown
wsl
```

확인 (에러 없이 상태가 나오면 성공):

```bash
systemctl is-system-running
```

## 2. Node.js 22 + git

```bash
sudo apt update
sudo apt install -y git curl build-essential

# nvm으로 Node 22
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
node -v      # v22.x 확인
```

## 3. 저장소 clone ⭐ 위치 주의

**반드시 리눅스 홈(`~`)에.** `/mnt/c/...` (윈도우 파일시스템)에 두면 파일 I/O가
몇 배 느려지고 권한 문제가 생깁니다.

```bash
git clone git@github.com:sun2141/agent-hub.git ~/agent-hub
cd ~/agent-hub/harness
npm install
```

SSH 키가 없으면 HTTPS로:
`git clone https://github.com/sun2141/agent-hub.git ~/agent-hub`

## 4. 맥의 `.env` 가져오기

WSL에서는 윈도우 드라이브가 `/mnt/c`로 마운트돼 있어 **USB가 제일 간단합니다.**

```bash
# 맥에서 USB에 복사 → USB를 씽크패드에 꽂고, WSL에서:
cp /mnt/d/env-from-mac ~/env-from-mac     # USB가 D: 드라이브인 경우
```

또는 맥에서 윈도우 다운로드 폴더로 옮긴 뒤:

```bash
cp /mnt/c/Users/<윈도우사용자>/Downloads/env-from-mac ~/env-from-mac
```

> 평문 비밀값입니다. 이관 후 원본을 지우고, USB를 썼다면 포맷하세요.

## 5. 설치기 실행

```bash
cd ~/agent-hub/harness
npm run setup:thinkpad
```

WSL을 자동으로 감지해서 아래처럼 분기합니다:

| 단계 | WSL2에서 하는 일 |
|---|---|
| 1 | systemd 확인, 저장소가 `/mnt/c`에 있으면 경고 |
| 4 | 데스크톱 키링 대신 **WSL용 키링 설정 + 실동작 검증** |
| 7 | 리눅스 대신 **윈도우 `powercfg` 명령을 안내** (직접 실행) |
| 8 | 사용자 서비스 대신 **시스템 서비스 + 작업 스케줄러 등록 안내** |

중간에 끊겨도 다시 실행하면 이어집니다.

---

## WSL2에서 특히 신경 쓸 것 셋

### ① 절전 — 윈도우 설정이다

WSL 안에서는 못 바꿉니다. **PowerShell(관리자)**에서:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg /setactive SCHEME_CURRENT
powercfg /query SCHEME_CURRENT SUB_SLEEP     # 확인
```

마지막 명령의 대기 시간 값이 0이면 성공입니다.

### ② 윈도우 재부팅 후 살아나기

WSL은 누가 열기 전까지 뜨지 않습니다. 윈도우 업데이트 재부팅 후 하네스가 죽은 채로
남지 않으려면 작업 스케줄러 등록이 필요합니다. **PowerShell(관리자)**:

```powershell
$A = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument '-d Ubuntu-24.04 -u <리눅스사용자> --exec /bin/true'
$T = New-ScheduledTaskTrigger -AtStartup
$P = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType S4U -RunLevel Highest
$S = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Start WSL Harness' -Action $A -Trigger $T -Principal $P -Settings $S
```

`wsl.exe`가 배포판을 부팅시키고, systemd가 `harness.service`를 띄웁니다.

**검증 방법 (이게 제일 중요합니다):** 윈도우를 실제로 재부팅한 뒤 WSL을 열고

```bash
sudo systemctl status harness     # active (running) 이어야 함
uptime                            # 재부팅 직후 시각이면 자동 시작 성공
```

윈도우 업데이트 자동 재부팅은 설정 > Windows 업데이트 > 고급 옵션의 **활성 시간**으로
줄일 수 있지만 완전히 막을 수는 없습니다. 위 등록이 그 복구를 담당합니다.

### ③ agy(Gemini) 키링 — 안 되면 안 써도 된다

WSL2에는 데스크톱 세션이 없어 키링 데몬이 자동으로 뜨지 않습니다. 그래서
agy 토큰이 유지되지 않을 수 있습니다.

```bash
bash scripts/setup-keyring-wsl.sh install    # 설정 + 실동작 검증
bash scripts/setup-keyring-wsl.sh verify     # 나중에 재확인
```

검증이 실패하면 **agy를 빼고 운영해도 됩니다.** `.env`에서:

```ini
PROVIDER_PLAN=claude       # 원래 antigravity
PROVIDER_BUILD=claude
PROVIDER_REVIEW=codex      # 그대로
```

이렇게 해도 **구현(Claude) ≠ 리뷰(Codex)** 교차 검증은 그대로 유지됩니다.
품질의 핵심은 "자기 코드를 자기가 채점하지 않는 것"이고, 그건 Codex가 담당합니다.
Gemini는 Plan 단계의 긴 컨텍스트 이점을 주는 것이라 없어도 치명적이지 않습니다.

---

## 데스크톱 우분투 대비 제약 요약

| 항목 | 데스크톱 우분투 | WSL2 |
|---|---|---|
| 절전 차단 | `systemctl mask sleep.target` | 윈도우 `powercfg` |
| 부팅 자동 시작 | systemd만으로 완결 | systemd + 윈도우 작업 스케줄러 |
| agy 키링 | GNOME 키링 (안정적) | 별도 설정 필요, 실패 가능 |
| 재부팅 요인 | 사용자가 통제 | 윈도우 업데이트가 강제 |
| 파일 I/O | 네이티브 | 리눅스 홈이면 빠름, `/mnt/c`면 느림 |

나중에 윈도우가 필요 없어지면 우분투 전용 설치로 옮길 수 있습니다.
`.env`와 Neon DB가 그대로라 데이터는 따라옵니다.

---

## 문제 해결

| 증상 | 확인 |
|---|---|
| `systemctl` 이 "not been booted with systemd" | 1단계 `/etc/wsl.conf` 후 `wsl --shutdown` 했는지 |
| 재부팅하면 하네스가 죽어 있음 | 작업 스케줄러 등록 확인: `Get-ScheduledTask -TaskName 'Start WSL Harness'` |
| agy가 매번 재인증 요구 | `bash scripts/setup-keyring-wsl.sh verify` → 실패면 `PROVIDER_PLAN=claude` |
| 빌드/테스트가 비정상적으로 느림 | 저장소가 `/mnt/c`에 있는지 확인 (`pwd`). 리눅스 홈으로 옮길 것 |
| 노트북이 자면서 멈춤 | `powercfg /query SCHEME_CURRENT SUB_SLEEP` 로 대기 시간 0 확인 |
| 텔레그램 명령이 씹힘 | 맥 하네스가 아직 도는지 확인 — 같은 토큰 동시 폴링은 409 |
| WSL 메모리를 너무 먹음 | `C:\Users\<사용자>\.wslconfig` 에 `[wsl2]` / `memory=8GB` |
