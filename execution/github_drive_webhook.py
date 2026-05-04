"""
GitHub-Drive 양방향 동기화 서버 (FastAPI)

엔드포인트:
  POST /webhook/github  — GitHub push 이벤트 수신 → Drive 동기화
  GET  /health          — 헬스 체크
  GET  /status          — 동기화 현황
  GET  /logs            — 최근 로그 조회
  GET  /dashboard       — 동기화 대시보드 (HTML)
  POST /poll            — Drive 수동 폴링 트리거
  GET  /mappings        — 저장소-폴더 매핑 현황

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
from fastapi.responses import JSONResponse, HTMLResponse
from dotenv import load_dotenv

# .env 로드
load_dotenv(EXEC_DIR.parent / ".env")

from github_drive_sync import sync_push_event
from drive_github_sync import poll_all_drive_folders, get_drive_syncer, get_watch_manager
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
    description="GitHub push/PR/release 이벤트를 Google Drive에 자동 동기화 (양방향)",
    version="2.0.0",
)

WEBHOOK_SECRET = os.getenv("GITHUB_WEBHOOK_SECRET", "")
DRIVE_POLL_INTERVAL = int(os.getenv("DRIVE_POLL_INTERVAL_SECONDS", "300"))  # 기본 5분
START_TIME = datetime.now(timezone.utc)

# Watch API 채널 갱신 간격 (1시간)
WATCH_RENEW_INTERVAL = 3600

# Drive 폴링/Watch 태스크 참조 (취소용)
_poll_task: asyncio.Task | None = None
_watch_renew_task: asyncio.Task | None = None


# ─── 서명 검증 ──────────────────────────────────────────────────

def verify_github_signature(payload_bytes: bytes, signature: str) -> bool:
    """
    GitHub HMAC-SHA256 서명 검증.
    GITHUB_WEBHOOK_SECRET이 없으면 검증 스킵 (개발용).

    hmac.new()는 Python 2 호환 별칭이므로 hmac.HMAC() 생성자를 사용.
    타이밍 공격 방지를 위해 hmac.compare_digest() 사용.
    """
    if not WEBHOOK_SECRET:
        logger.warning("GITHUB_WEBHOOK_SECRET 미설정 — 서명 검증 스킵 (운영 환경에서는 필수)")
        return True

    if not signature or not signature.startswith("sha256="):
        return False

    # hmac.HMAC 생성자 직접 사용 (hmac.new() 별칭 대신 명시적 호출)
    mac = hmac.HMAC(
        key=WEBHOOK_SECRET.encode("utf-8"),
        msg=payload_bytes,
        digestmod=hashlib.sha256,
    )
    expected = mac.hexdigest()

    # 타이밍 공격 방지: 항상 상수 시간 비교
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

        # 무한루프 방지: Drive-sync 커밋은 Drive로 다시 동기화하지 않음
        push_commits = payload.get("commits", [])
        all_drive_sync = bool(push_commits) and all(
            "[drive-sync]" in c.get("message", "") for c in push_commits
        )
        if all_drive_sync:
            logger.info("[drive-sync] 커밋 — Drive 재동기화 스킵 (무한루프 방지)")
            return JSONResponse({"status": "skipped", "reason": "drive-sync loop prevention"})

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
        "drive_poll_interval_seconds": DRIVE_POLL_INTERVAL,
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


@app.get("/mappings")
async def get_mappings():
    """저장소-폴더 매핑 현황 반환."""
    try:
        syncer = get_drive_syncer()
        mapped = syncer.get_all_mapped_folders()
        sync_logger = get_sync_logger()
        result = []
        for repo, folder_id, config in mapped:
            drive_summary = sync_logger.get_drive_repo_summary(repo)
            github_summary = sync_logger.get_repo_summary(repo)
            result.append({
                "repo": repo,
                "drive_folder_id": folder_id,
                "sync_paths": config.get("sync_paths", []),
                "drive_tracked_files": drive_summary["total_drive_files"],
                "github_tracked_files": github_summary["total_files"],
            })
        return {"mappings": result, "count": len(result)}
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@app.post("/webhook/drive")
async def drive_watch_webhook(request: Request, background_tasks: BackgroundTasks):
    """
    Google Drive Watch API Push Notification 수신 엔드포인트.

    Google이 Drive 파일 변경 시 이 URL로 POST 전송.
    헤더에서 채널 ID와 리소스 상태를 추출해 변경 처리.

    참고: https://developers.google.com/drive/api/guides/push
    """
    # Google Drive 알림 헤더 추출
    channel_id = request.headers.get("X-Goog-Channel-ID", "")
    resource_state = request.headers.get("X-Goog-Resource-State", "")
    resource_id = request.headers.get("X-Goog-Resource-ID", "")
    channel_token = request.headers.get("X-Goog-Channel-Token", "")
    message_number = request.headers.get("X-Goog-Message-Number", "0")

    logger.info(
        f"Drive Watch 알림: channel={channel_id[:12]}... "
        f"state={resource_state} msg={message_number}"
    )

    # 채널 ID 없으면 무시
    if not channel_id:
        logger.warning("Drive Watch 알림에 채널 ID 없음 — 무시")
        return JSONResponse({"status": "ignored", "reason": "no channel_id"})

    # 백그라운드에서 동기화 실행 (알림에는 즉시 200 응답)
    background_tasks.add_task(_handle_drive_watch, channel_id, resource_state)

    return JSONResponse({
        "status": "accepted",
        "channel_id": channel_id,
        "resource_state": resource_state,
    })


async def _handle_drive_watch(channel_id: str, resource_state: str):
    """Drive Watch 알림 백그라운드 처리."""
    try:
        loop = asyncio.get_event_loop()
        watch_manager = get_watch_manager()
        results = await loop.run_in_executor(
            None,
            watch_manager.process_watch_notification,
            channel_id,
            resource_state,
        )
        total_synced = sum(len(r.synced) for r in results)
        logger.info(f"Drive Watch 동기화 완료: {total_synced}개 파일")
    except Exception as e:
        logger.exception(f"Drive Watch 처리 오류: {e}")


@app.get("/watch/status")
async def watch_status():
    """Drive Watch 채널 현황 조회."""
    try:
        watch_manager = get_watch_manager()
        return watch_manager.get_watch_status()
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/watch/register")
async def watch_register(background_tasks: BackgroundTasks):
    """모든 매핑 폴더에 Drive Watch 채널 수동 등록."""
    background_tasks.add_task(_register_watch_channels)
    return JSONResponse({
        "status": "accepted",
        "message": "Watch 채널 등록을 시작했습니다.",
    })


async def _register_watch_channels():
    """Watch 채널 등록 (비동기 래퍼)."""
    try:
        loop = asyncio.get_event_loop()
        watch_manager = get_watch_manager()
        await loop.run_in_executor(
            None,
            watch_manager.register_all_mapped_folders,
        )
    except Exception as e:
        logger.error(f"Watch 채널 등록 오류: {e}")


@app.post("/poll")
async def manual_poll(background_tasks: BackgroundTasks):
    """Drive 수동 폴링 트리거."""
    background_tasks.add_task(_run_drive_poll)
    return JSONResponse({
        "status": "accepted",
        "message": "Drive 폴링을 시작했습니다.",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard():
    """동기화 상태 대시보드 (HTML)."""
    sync_logger = get_sync_logger()
    stats = sync_logger.get_stats()
    logs = sync_logger.get_recent_logs(n=20)
    uptime = (datetime.now(timezone.utc) - START_TIME).total_seconds()

    # 로그 테이블 생성
    log_rows = ""
    for log in reversed(logs):
        status_icon = {"success": "✅", "failure": "❌", "skipped": "⏭️"}.get(
            log.get("status", ""), "❓"
        )
        details = log.get("details", {})
        detail_str = ", ".join(f"{k}={v}" for k, v in details.items() if k not in ("files",))
        log_rows += (
            f"<tr>"
            f"<td>{log.get('timestamp', '')[:19]}</td>"
            f"<td>{status_icon} {log.get('status', '')}</td>"
            f"<td>{log.get('event_type', '')}</td>"
            f"<td><code>{log.get('repo', '')}</code></td>"
            f"<td>{detail_str[:80]}</td>"
            f"</tr>\n"
        )

    html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitHub-Drive 동기화 대시보드</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #0f172a; color: #e2e8f0; padding: 24px; }}
    h1 {{ font-size: 1.5rem; margin-bottom: 24px; color: #f8fafc; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
             gap: 16px; margin-bottom: 32px; }}
    .card {{ background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }}
    .card .label {{ font-size: 0.75rem; color: #94a3b8; text-transform: uppercase;
                    letter-spacing: 0.05em; margin-bottom: 8px; }}
    .card .value {{ font-size: 2rem; font-weight: 700; }}
    .success {{ color: #4ade80; }}
    .failure {{ color: #f87171; }}
    .skipped {{ color: #facc15; }}
    .neutral {{ color: #60a5fa; }}
    section {{ background: #1e293b; border-radius: 12px; padding: 20px;
               border: 1px solid #334155; margin-bottom: 24px; }}
    section h2 {{ font-size: 1rem; color: #94a3b8; margin-bottom: 16px; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; }}
    th {{ text-align: left; padding: 8px 12px; border-bottom: 1px solid #334155;
          color: #64748b; font-weight: 500; }}
    td {{ padding: 8px 12px; border-bottom: 1px solid #1e293b; }}
    tr:hover td {{ background: #334155; }}
    code {{ background: #334155; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }}
    .badge {{ display: inline-block; padding: 2px 8px; border-radius: 999px;
              font-size: 0.75rem; font-weight: 600; }}
    .info-row {{ display: flex; gap: 24px; flex-wrap: wrap; font-size: 0.85rem; color: #94a3b8; }}
    .info-row span {{ display: flex; align-items: center; gap: 6px; }}
  </style>
  <meta http-equiv="refresh" content="30">
</head>
<body>
  <h1>⚡ GitHub-Drive 동기화 대시보드</h1>

  <div class="info-row" style="margin-bottom: 20px;">
    <span>🕐 업타임: {int(uptime // 3600)}시간 {int((uptime % 3600) // 60)}분</span>
    <span>🔔 Webhook Secret: {"설정됨" if WEBHOOK_SECRET else "미설정"}</span>
    <span>⏱ Drive 폴링: {DRIVE_POLL_INTERVAL}초 간격</span>
    <span>📡 Watch API: {"활성화" if os.getenv("DRIVE_WATCH_WEBHOOK_URL") else "비활성화(폴링 모드)"}</span>
    <span>🔄 자동 새로고침: 30초</span>
  </div>

  <div class="grid">
    <div class="card">
      <div class="label">전체 이벤트</div>
      <div class="value neutral">{stats.get("total_events", 0)}</div>
    </div>
    <div class="card">
      <div class="label">성공</div>
      <div class="value success">{stats.get("success", 0)}</div>
    </div>
    <div class="card">
      <div class="label">실패</div>
      <div class="value failure">{stats.get("failure", 0)}</div>
    </div>
    <div class="card">
      <div class="label">스킵</div>
      <div class="value skipped">{stats.get("skipped", 0)}</div>
    </div>
    <div class="card">
      <div class="label">추적 저장소</div>
      <div class="value neutral">{len(stats.get("tracked_repos", []))}</div>
    </div>
    <div class="card">
      <div class="label">추적 파일</div>
      <div class="value neutral">{stats.get("total_tracked_files", 0)}</div>
    </div>
  </div>

  <section>
    <h2>최근 동기화 이벤트</h2>
    <table>
      <thead>
        <tr>
          <th>시각 (UTC)</th><th>상태</th><th>이벤트</th><th>저장소</th><th>상세</th>
        </tr>
      </thead>
      <tbody>
        {log_rows if log_rows else '<tr><td colspan="5" style="text-align:center;color:#64748b;">이벤트 없음</td></tr>'}
      </tbody>
    </table>
  </section>

  <section>
    <h2>API 엔드포인트</h2>
    <table>
      <tr><td><code>POST /webhook/github</code></td><td>GitHub push 이벤트 수신</td></tr>
      <tr><td><code>POST /webhook/drive</code></td><td>Drive Watch Push Notification 수신</td></tr>
      <tr><td><code>POST /poll</code></td><td>Drive 수동 폴링</td></tr>
      <tr><td><code>GET /watch/status</code></td><td>Drive Watch 채널 현황</td></tr>
      <tr><td><code>POST /watch/register</code></td><td>Watch 채널 수동 등록</td></tr>
      <tr><td><code>GET /status</code></td><td>JSON 동기화 통계</td></tr>
      <tr><td><code>GET /logs?n=50</code></td><td>최근 로그 조회</td></tr>
      <tr><td><code>GET /mappings</code></td><td>저장소-폴더 매핑 현황</td></tr>
      <tr><td><code>GET /health</code></td><td>헬스 체크</td></tr>
    </table>
  </section>
</body>
</html>"""
    return HTMLResponse(content=html)


async def _drive_poll_loop():
    """
    Drive 폴링 루프 (백그라운드 태스크).
    Watch API가 활성화된 경우에도 폴백 폴링으로 유지.
    (Watch 알림 누락 시 안전망 역할)
    """
    logger.info(f"Drive 폴링 루프 시작 (간격: {DRIVE_POLL_INTERVAL}초)")
    while True:
        try:
            await asyncio.sleep(DRIVE_POLL_INTERVAL)
            await _run_drive_poll()
        except asyncio.CancelledError:
            logger.info("Drive 폴링 루프 종료")
            break
        except Exception as e:
            logger.error(f"Drive 폴링 루프 오류: {e}")


async def _run_drive_poll():
    """Drive 폴링 실행 (비동기 래퍼)."""
    try:
        logger.info("Drive 변경사항 폴링 시작...")
        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, poll_all_drive_folders)
        total_synced = sum(len(r.synced) for r in results)
        total_failed = sum(len(r.failed) for r in results)
        logger.info(f"Drive 폴링 완료: {total_synced}개 동기화, {total_failed}개 실패")
    except Exception as e:
        logger.error(f"Drive 폴링 실행 오류: {e}")


async def _watch_renew_loop():
    """
    Drive Watch 채널 갱신 루프 (1시간 간격).
    만료 1시간 이내 채널을 자동으로 재등록.
    """
    logger.info("Drive Watch 채널 갱신 루프 시작")
    while True:
        try:
            await asyncio.sleep(WATCH_RENEW_INTERVAL)
            loop = asyncio.get_event_loop()
            watch_manager = get_watch_manager()
            await loop.run_in_executor(
                None,
                watch_manager.renew_expiring_channels,
            )
        except asyncio.CancelledError:
            logger.info("Watch 채널 갱신 루프 종료")
            break
        except Exception as e:
            logger.error(f"Watch 채널 갱신 루프 오류: {e}")


@app.on_event("startup")
async def startup():
    """서버 시작 시 초기화."""
    global _poll_task, _watch_renew_task
    # .tmp 디렉토리 생성
    (EXEC_DIR.parent / ".tmp").mkdir(exist_ok=True)

    watch_url = os.getenv("DRIVE_WATCH_WEBHOOK_URL", "")
    logger.info(
        f"GitHub-Drive Sync 서버 v2.0 시작\n"
        f"  포트: {os.getenv('WEBHOOK_PORT', '8080')}\n"
        f"  Webhook Secret: {'설정됨' if WEBHOOK_SECRET else '미설정 (개발 모드)'}\n"
        f"  Drive 폴링 간격: {DRIVE_POLL_INTERVAL}초\n"
        f"  Drive Watch API: {'활성화 (' + watch_url + ')' if watch_url else '비활성화 (폴링 모드)'}"
    )

    # Drive Watch 채널 등록 (DRIVE_WATCH_WEBHOOK_URL 설정 시)
    if watch_url:
        asyncio.create_task(_register_watch_channels())
        _watch_renew_task = asyncio.create_task(_watch_renew_loop())
        logger.info("Drive Watch API 활성화 — 폴링은 폴백 안전망으로 유지됨")

    # Drive 폴링 루프 항상 시작 (Watch API와 병행, 안전망 역할)
    _poll_task = asyncio.create_task(_drive_poll_loop())


@app.on_event("shutdown")
async def shutdown():
    """서버 종료 시 정리."""
    global _poll_task, _watch_renew_task
    for task in [_poll_task, _watch_renew_task]:
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    logger.info("서버 종료")


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
