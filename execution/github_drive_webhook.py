"""
GitHub Webhook 수신 서버 (FastAPI)

엔드포인트:
  POST /webhook/github  — GitHub 이벤트 수신
  GET  /health          — 헬스 체크
  GET  /status          — 동기화 현황
  GET  /logs            — 최근 로그 조회

실행:
  python execution/github_drive_webhook.py
  또는
  uvicorn execution.github_drive_webhook:app --host 0.0.0.0 --port 8080
"""

import os
import sys
import hmac
import hashlib
import logging
import asyncio
from datetime import datetime, timezone
from pathlib import Path

# 경로 설정: execution/ 폴더를 Python path에 추가
EXEC_DIR = Path(__file__).parent
sys.path.insert(0, str(EXEC_DIR))

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

# .env 로드
load_dotenv(EXEC_DIR.parent / ".env")

from github_drive_sync import sync_push_event
from sync_logger import get_sync_logger
from telegram_notifier import notify_webhook_received

# 로깅 설정
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(EXEC_DIR.parent / ".tmp" / "webhook.log"),
    ],
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="GitHub-Drive Sync Webhook",
    description="GitHub push/PR/release 이벤트를 Google Drive에 자동 동기화",
    version="1.0.0",
)

WEBHOOK_SECRET = os.getenv("GITHUB_WEBHOOK_SECRET", "")
START_TIME = datetime.now(timezone.utc)


# ─── 서명 검증 ──────────────────────────────────────────────────

def verify_github_signature(payload_bytes: bytes, signature: str) -> bool:
    """
    GitHub HMAC-SHA256 서명 검증.
    GITHUB_WEBHOOK_SECRET이 없으면 검증 스킵 (개발용).
    """
    if not WEBHOOK_SECRET:
        logger.warning("GITHUB_WEBHOOK_SECRET 미설정 — 서명 검증 스킵 (운영 환경에서는 필수)")
        return True

    if not signature or not signature.startswith("sha256="):
        return False

    expected = hmac.new(
        key=WEBHOOK_SECRET.encode("utf-8"),
        msg=payload_bytes,
        digestmod=hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(f"sha256={expected}", signature)


# ─── 엔드포인트 ─────────────────────────────────────────────────

@app.post("/webhook/github")
async def github_webhook(request: Request, background_tasks: BackgroundTasks):
    """
    GitHub Webhook 수신.
    서명 검증 후 이벤트 타입에 따라 처리.
    """
    payload_bytes = await request.body()
    signature = request.headers.get("X-Hub-Signature-256", "")
    event_type = request.headers.get("X-GitHub-Event", "")
    delivery_id = request.headers.get("X-GitHub-Delivery", "")

    logger.info(f"Webhook 수신: {event_type} (delivery: {delivery_id})")

    # 서명 검증
    if not verify_github_signature(payload_bytes, signature):
        logger.warning(f"서명 검증 실패 — delivery: {delivery_id}")
        raise HTTPException(status_code=401, detail="Invalid signature")

    # JSON 파싱
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    repo = payload.get("repository", {}).get("full_name", "unknown")

    # 이벤트 처리
    if event_type == "push":
        # 기본 브랜치 push만 처리 (또는 설정에 따라 변경 가능)
        ref = payload.get("ref", "")
        default_branch = payload.get("repository", {}).get("default_branch", "main")

        if ref != f"refs/heads/{default_branch}":
            logger.info(f"비기본 브랜치 push 스킵: {ref}")
            return JSONResponse({"status": "skipped", "reason": f"not default branch: {ref}"})

        # 백그라운드에서 동기화 실행 (webhook은 즉시 200 응답)
        background_tasks.add_task(_handle_push, payload, repo)
        return JSONResponse({"status": "accepted", "event": "push", "repo": repo})

    elif event_type == "release":
        background_tasks.add_task(_handle_release, payload, repo)
        return JSONResponse({"status": "accepted", "event": "release", "repo": repo})

    elif event_type == "pull_request":
        # PR 이벤트 로깅 (현재는 동기화 미지원)
        action = payload.get("action", "")
        logger.info(f"PR 이벤트: {action} — {repo}")
        return JSONResponse({"status": "logged", "event": "pull_request", "action": action})

    elif event_type == "ping":
        # GitHub Webhook 설정 시 ping 이벤트 전송
        zen = payload.get("zen", "")
        logger.info(f"Ping 수신: {zen}")
        return JSONResponse({"status": "pong", "zen": zen})

    else:
        logger.info(f"미지원 이벤트: {event_type}")
        return JSONResponse({"status": "ignored", "event": event_type})


async def _handle_push(payload: dict, repo: str):
    """push 이벤트 백그라운드 처리."""
    try:
        logger.info(f"Push 동기화 시작: {repo}")
        # 동기 함수를 비동기로 실행
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, sync_push_event, payload)

        logger.info(
            f"Push 동기화 완료: {repo} — "
            f"성공: {len(result.synced)}, 스킵: {len(result.skipped)}, 실패: {len(result.failed)}"
        )
    except Exception as e:
        logger.exception(f"Push 처리 오류: {repo} — {e}")


async def _handle_release(payload: dict, repo: str):
    """release 이벤트 처리 (현재: 로그만 기록)."""
    action = payload.get("action", "")
    release_name = payload.get("release", {}).get("name", "")
    tag = payload.get("release", {}).get("tag_name", "")

    logger.info(f"Release 이벤트: {repo} — {action} ({tag}: {release_name})")
    sync_logger = get_sync_logger()
    sync_logger.log_event(
        "release", repo,
        {"action": action, "tag": tag, "name": release_name},
    )


@app.get("/health")
async def health_check():
    """헬스 체크 엔드포인트."""
    uptime = (datetime.now(timezone.utc) - START_TIME).total_seconds()
    return {
        "status": "ok",
        "uptime_seconds": int(uptime),
        "webhook_secret_set": bool(WEBHOOK_SECRET),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/status")
async def sync_status():
    """동기화 현황 조회."""
    sync_logger = get_sync_logger()
    return {
        "stats": sync_logger.get_stats(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/logs")
async def recent_logs(n: int = 20):
    """최근 동기화 로그 조회."""
    sync_logger = get_sync_logger()
    logs = sync_logger.get_recent_logs(n=min(n, 100))
    return {"logs": logs, "count": len(logs)}


@app.on_event("startup")
async def startup():
    """서버 시작 시 초기화."""
    # .tmp 디렉토리 생성
    (EXEC_DIR.parent / ".tmp").mkdir(exist_ok=True)
    logger.info(
        f"GitHub-Drive Sync Webhook 서버 시작\n"
        f"  포트: {os.getenv('WEBHOOK_PORT', '8080')}\n"
        f"  Webhook Secret: {'설정됨' if WEBHOOK_SECRET else '미설정 (개발 모드)'}"
    )


# ─── 서버 실행 ───────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("WEBHOOK_PORT", "8080"))
    uvicorn.run(
        "github_drive_webhook:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="info",
    )
