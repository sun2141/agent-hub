#!/usr/bin/env bash
# vercel-auto-deploy.sh: GitHub push 감지 시 자동 Vercel 배포
# 로컬 cron으로 실행 (1분마다)

PROJ_DIR="/Users/sun/20260128_test/projects/prayer-agent"
LOG_FILE="/Users/sun/20260128_test/.tmp/vercel-deploy.log"
LAST_COMMIT_FILE="/Users/sun/20260128_test/.tmp/.last-deployed-commit"

mkdir -p "$(dirname "$LOG_FILE")"

# cron 환경에서 PATH 설정
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.npm-global/bin:$PATH"
export HOME="/Users/sun"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# 원격 최신 커밋
REMOTE_COMMIT=$(git -C "$PROJ_DIR" ls-remote origin master 2>/dev/null | cut -f1)
if [[ -z "$REMOTE_COMMIT" ]]; then
  log "ERROR: Remote fetch failed"
  exit 1
fi

# 마지막 배포 커밋
LAST_COMMIT=$(cat "$LAST_COMMIT_FILE" 2>/dev/null || echo "")

if [[ "$REMOTE_COMMIT" == "$LAST_COMMIT" ]]; then
  exit 0  # 변경 없음
fi

log "New commit detected: ${LAST_COMMIT:0:7} → ${REMOTE_COMMIT:0:7}"

# pull
git -C "$PROJ_DIR" fetch origin >> "$LOG_FILE" 2>&1
git -C "$PROJ_DIR" reset --hard origin/master >> "$LOG_FILE" 2>&1

# Vercel 배포
log "Deploying to Vercel..."
DEPLOY_OUT=$(cd "$PROJ_DIR" && vercel --prod --yes 2>&1)
DEPLOY_EXIT=$?

if [[ $DEPLOY_EXIT -eq 0 ]]; then
  echo "$REMOTE_COMMIT" > "$LAST_COMMIT_FILE"
  DEPLOY_URL=$(echo "$DEPLOY_OUT" | grep -E '^https://' | tail -1)
  log "Deploy success: $DEPLOY_URL"
else
  log "Deploy FAILED: $DEPLOY_OUT"
fi
