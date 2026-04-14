#!/usr/bin/env bash
# harness/deploy.sh
# eval 합격 시 자동으로 실행되는 배포 스크립트
#
# ⚠️ self-kill 주의:
#   이 스크립트는 harness 프로세스 내부(_runCommitAndDeploy)에서 execSync로 호출됨.
#   DEPLOY_METHOD=pm2 또는 node 모드에서 harness 자신을 재시작하면 self-kill 발생.
#   → harness 재시작은 /telegram /deploy 명령 또는 /api/deploy 웹훅을 사용하세요.
#     (deploy_detached.sh가 분리 프로세스로 안전하게 처리함)
#
# 이 스크립트는 git push 전용으로만 사용하는 것을 권장합니다.
# DEPLOY_METHOD=push  → git push만 수행 (재시작 없음)
# DEPLOY_METHOD=pm2   → pm2 reload (PM2 감시 환경에서만 안전)
# DEPLOY_METHOD=none  → 건너뜀 (기본값)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEPLOY_METHOD="${DEPLOY_METHOD:-none}"

case "$DEPLOY_METHOD" in
  push)
    # git push만 수행 — harness 재시작 없음 (self-kill 방지)
    echo "[deploy] git push origin main..."
    cd "$REPO_ROOT"
    if git push origin main 2>&1; then
      echo "[deploy] push 완료"
    else
      echo "[deploy] push 실패 (원격 저장소 없음이거나 인증 오류)" >&2
      exit 1
    fi
    ;;

  pm2)
    # pm2로 실행 중인 프로세스를 재시작
    # ⚠️ harness 자신이 pm2로 관리되는 경우 self-kill 위험 없음
    #    (pm2가 별도 데몬으로 프로세스를 관리하기 때문)
    APP_NAME="${PM2_APP_NAME:-harness}"
    echo "[deploy] pm2 reload: $APP_NAME"
    if pm2 list 2>/dev/null | grep -q "$APP_NAME"; then
      pm2 reload "$APP_NAME" --update-env
    else
      echo "[deploy] pm2 앱 '$APP_NAME' 없음 — pm2 start로 기동"
      pm2 start "$SCRIPT_DIR/package.json" --name "$APP_NAME"
    fi
    ;;

  script)
    # 사용자 정의 훅 실행 (DEPLOY_HOOK_PATH 환경변수 지정 필요)
    HOOK="${DEPLOY_HOOK_PATH:-}"
    if [[ -z "$HOOK" ]]; then
      echo "[deploy] DEPLOY_HOOK_PATH가 설정되지 않음 — 건너뜀" >&2
      exit 0
    fi
    if [[ ! -x "$HOOK" ]]; then
      echo "[deploy] 훅 파일 실행 불가: $HOOK" >&2
      exit 1
    fi
    echo "[deploy] 훅 실행: $HOOK"
    "$HOOK"
    ;;

  none)
    echo "[deploy] DEPLOY_METHOD=none — 배포 건너뜀"
    echo "[deploy] 팁: DEPLOY_METHOD=push 로 설정하면 git push만 수행합니다"
    echo "[deploy] 팁: 하네스 재시작은 텔레그램 /deploy 명령을 사용하세요"
    ;;

  *)
    echo "[deploy] 알 수 없는 DEPLOY_METHOD: $DEPLOY_METHOD" >&2
    exit 1
    ;;
esac

echo "[deploy] 완료"
