#!/usr/bin/env bash
# harness/deploy.sh
# eval 합격 시 자동으로 실행되는 배포 스크립트
# 사용 환경에 맞게 아래 중 하나를 활성화하세요.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 배포 방법 선택 (환경변수 DEPLOY_METHOD로 제어) ─────────────
DEPLOY_METHOD="${DEPLOY_METHOD:-pm2}"

case "$DEPLOY_METHOD" in
  pm2)
    # pm2로 실행 중인 프로세스를 재시작
    APP_NAME="${PM2_APP_NAME:-harness}"
    echo "[deploy] pm2 reload: $APP_NAME"
    if pm2 list | grep -q "$APP_NAME"; then
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
    ;;

  *)
    echo "[deploy] 알 수 없는 DEPLOY_METHOD: $DEPLOY_METHOD" >&2
    exit 1
    ;;
esac

echo "[deploy] 완료"
