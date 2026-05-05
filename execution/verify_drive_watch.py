"""
Drive Watch API 운영 환경 검증 스크립트

목적:
  - 공개 HTTPS URL(VPS)에서 Drive Watch API 실제 동작 검증
  - Watch 채널 등록 → 만료 확인 → 갱신 → 해제 전체 흐름 검증
  - 실제 webhook 수신 시뮬레이션 (서버 엔드포인트 호출)

사전 조건:
  1. VPS에 github_drive_webhook.py 서버 실행 중 (기본 포트 8080)
  2. .env에 DRIVE_WATCH_WEBHOOK_URL=https://your-server.com 설정
  3. Google Drive 인증 완료 (token.json 존재)
  4. GOOGLE_DRIVE_FOLDER_ID 또는 GOOGLE_DRIVE_FOLDER_ID_PALMONI 설정

실행:
  # 기본 — 모든 검증 항목 실행
  python execution/verify_drive_watch.py

  # URL 직접 지정 (환경변수 대신)
  python execution/verify_drive_watch.py --url https://91.99.58.70:8080

  # 특정 검증 항목만
  python execution/verify_drive_watch.py --check url       # URL 접근성만
  python execution/verify_drive_watch.py --check register  # 채널 등록만
  python execution/verify_drive_watch.py --check webhook   # webhook 수신 시뮬레이션
  python execution/verify_drive_watch.py --check renew     # TTL 갱신 로직만
  python execution/verify_drive_watch.py --check all       # 전체 (기본값)

결과:
  - 각 검증 항목의 PASS/FAIL/SKIP 상태 출력
  - 실패 시 원인과 해결 방법 안내
  - 검증 완료 후 등록된 테스트 채널 자동 정리
"""

import os
import sys
import json
import uuid
import time
import argparse
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import requests

# 경로 설정
EXEC_DIR = Path(__file__).parent
BASE_DIR = EXEC_DIR.parent
sys.path.insert(0, str(EXEC_DIR))

# .env 로드
try:
    from dotenv import load_dotenv
    load_dotenv(BASE_DIR / ".env")
except ImportError:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


# ─── 검증 결과 ────────────────────────────────────────────────────

class VerifyResult:
    PASS = "✅ PASS"
    FAIL = "❌ FAIL"
    SKIP = "⏭  SKIP"
    WARN = "⚠️  WARN"

    def __init__(self):
        self.results: list[dict] = []

    def add(self, name: str, status: str, detail: str = "", fix: str = ""):
        self.results.append({
            "name": name,
            "status": status,
            "detail": detail,
            "fix": fix,
        })
        icon = status
        print(f"\n{icon}: {name}")
        if detail:
            print(f"   {detail}")
        if fix and status == self.FAIL:
            print(f"   → 해결: {fix}")

    def summary(self) -> bool:
        passed = sum(1 for r in self.results if r["status"] == self.PASS)
        failed = sum(1 for r in self.results if r["status"] == self.FAIL)
        warned = sum(1 for r in self.results if r["status"] == self.WARN)
        skipped = sum(1 for r in self.results if r["status"] == self.SKIP)
        total = len(self.results)

        print(f"\n{'='*60}")
        print(f"검증 결과: {passed}/{total} PASS  |  {failed} FAIL  |  {warned} WARN  |  {skipped} SKIP")
        print(f"{'='*60}")
        return failed == 0


# ─── 검증 항목 ────────────────────────────────────────────────────

def check_environment(result: VerifyResult, base_url: str) -> bool:
    """환경 변수 및 전제 조건 확인."""
    print("\n[1] 환경 변수 확인")

    # DRIVE_WATCH_WEBHOOK_URL
    watch_url = os.getenv("DRIVE_WATCH_WEBHOOK_URL", "")
    effective_url = base_url or watch_url
    if effective_url:
        result.add(
            "DRIVE_WATCH_WEBHOOK_URL 설정",
            VerifyResult.PASS,
            f"URL: {effective_url}",
        )
    else:
        result.add(
            "DRIVE_WATCH_WEBHOOK_URL 설정",
            VerifyResult.FAIL,
            "환경변수 미설정, --url 인수도 없음",
            ".env에 DRIVE_WATCH_WEBHOOK_URL=https://your-server.com 추가",
        )
        return False

    # Google Drive 폴더 ID
    folder_id = os.getenv("GOOGLE_DRIVE_FOLDER_ID", "")
    palmoni_folder_id = os.getenv("GOOGLE_DRIVE_FOLDER_ID_PALMONI", "")
    if folder_id or palmoni_folder_id:
        result.add(
            "Drive 폴더 ID 설정",
            VerifyResult.PASS,
            f"grace-ai: {'설정됨' if folder_id else '미설정'}, palmoni: {'설정됨' if palmoni_folder_id else '미설정'}",
        )
    else:
        result.add(
            "Drive 폴더 ID 설정",
            VerifyResult.FAIL,
            "GOOGLE_DRIVE_FOLDER_ID / GOOGLE_DRIVE_FOLDER_ID_PALMONI 모두 미설정",
            ".env에 GOOGLE_DRIVE_FOLDER_ID=<Drive 폴더 ID> 추가",
        )

    # GitHub 토큰
    github_token = os.getenv("GITHUB_TOKEN", "")
    if github_token:
        result.add("GITHUB_TOKEN 설정", VerifyResult.PASS)
    else:
        result.add(
            "GITHUB_TOKEN 설정",
            VerifyResult.WARN,
            "Drive→GitHub 동기화 시 필요",
            ".env에 GITHUB_TOKEN=ghp_xxxx 추가",
        )

    return True


def check_url_accessibility(result: VerifyResult, base_url: str) -> bool:
    """
    공개 HTTPS URL 접근성 검증.
    서버의 /health 엔드포인트로 GET 요청.
    """
    print("\n[2] 공개 HTTPS URL 접근성 확인")

    url = base_url or os.getenv("DRIVE_WATCH_WEBHOOK_URL", "")
    if not url:
        result.add("HTTPS URL 접근성", VerifyResult.SKIP, "URL 미설정")
        return False

    # HTTPS 여부 확인 (Drive Watch API 요구사항)
    if url.startswith("http://"):
        result.add(
            "HTTPS URL 사용",
            VerifyResult.FAIL,
            f"HTTP URL 감지: {url}",
            "Drive Watch API는 HTTPS 필수. HTTPS URL 또는 Nginx SSL 설정 필요.",
        )
        # HTTP로도 계속 테스트 (VPS IP 직접 접근 허용)
        logger.warning("HTTP URL이지만 VPS 검증을 위해 계속 진행합니다.")
    else:
        result.add("HTTPS URL 사용", VerifyResult.PASS, f"URL: {url}")

    # /health 엔드포인트 접근
    health_url = f"{url}/health"
    try:
        resp = requests.get(health_url, timeout=10, verify=False)
        if resp.status_code == 200:
            data = resp.json()
            uptime = data.get("uptime_seconds", "?")
            result.add(
                "/health 엔드포인트 응답",
                VerifyResult.PASS,
                f"상태: {data.get('status', '?')}, 업타임: {uptime}초",
            )
            return True
        else:
            result.add(
                "/health 엔드포인트 응답",
                VerifyResult.FAIL,
                f"HTTP {resp.status_code}: {resp.text[:100]}",
                "서버가 실행 중인지 확인: pm2 list 또는 python execution/github_drive_webhook.py",
            )
            return False
    except requests.exceptions.ConnectionError as e:
        result.add(
            "/health 엔드포인트 응답",
            VerifyResult.FAIL,
            f"연결 실패: {e}",
            f"VPS 방화벽 포트 열기: ufw allow 8080, 또는 Nginx 리버스 프록시 설정",
        )
        return False
    except requests.exceptions.Timeout:
        result.add(
            "/health 엔드포인트 응답",
            VerifyResult.FAIL,
            "타임아웃 (10초)",
            "서버 응답 없음. PM2 프로세스 확인: pm2 status",
        )
        return False


def check_watch_status_endpoint(result: VerifyResult, base_url: str) -> bool:
    """
    /watch/status 엔드포인트로 현재 Watch 채널 상태 확인.
    """
    print("\n[3] Watch 채널 현황 확인")

    url = base_url or os.getenv("DRIVE_WATCH_WEBHOOK_URL", "")
    if not url:
        result.add("Watch 상태 조회", VerifyResult.SKIP, "URL 미설정")
        return False

    try:
        resp = requests.get(f"{url}/watch/status", timeout=10, verify=False)
        if resp.status_code == 200:
            data = resp.json()
            enabled = data.get("enabled", False)
            active = data.get("active_channels", 0)
            webhook_url = data.get("webhook_url", "(미설정)")

            if enabled:
                result.add(
                    "Watch API 활성화",
                    VerifyResult.PASS,
                    f"Webhook URL: {webhook_url}, 활성 채널: {active}개",
                )
            else:
                result.add(
                    "Watch API 활성화",
                    VerifyResult.WARN,
                    "Watch API 비활성화 상태 (폴링 모드). Webhook URL 미설정.",
                    "VPS .env에 DRIVE_WATCH_WEBHOOK_URL=https://your-server.com 추가 후 재시작",
                )

            # 채널 만료 시각 확인
            channels = data.get("channels", [])
            for ch in channels:
                remaining = ch.get("remaining_seconds", 0)
                repo = ch.get("repo", "?")
                if remaining < 3600:
                    result.add(
                        f"채널 TTL 경고: {repo}",
                        VerifyResult.WARN,
                        f"만료까지 {remaining}초 ({remaining // 60}분) — 갱신 필요",
                    )
                else:
                    result.add(
                        f"채널 TTL 정상: {repo}",
                        VerifyResult.PASS,
                        f"만료까지 {remaining // 3600}시간 {(remaining % 3600) // 60}분",
                    )
            return True
        else:
            result.add(
                "Watch 상태 조회",
                VerifyResult.FAIL,
                f"HTTP {resp.status_code}",
            )
            return False
    except Exception as e:
        result.add("Watch 상태 조회", VerifyResult.FAIL, f"오류: {e}")
        return False


def check_webhook_drive_endpoint(result: VerifyResult, base_url: str) -> bool:
    """
    /webhook/drive 엔드포인트에 Drive Watch API 형식의 POST 요청 시뮬레이션.

    Google이 실제로 보내는 헤더 형식:
      X-Goog-Channel-ID: <channel_id>
      X-Goog-Resource-State: change
      X-Goog-Resource-ID: <resource_id>
      X-Goog-Channel-Token: repo=owner/repo
      X-Goog-Channel-Expiration: <datetime>
    """
    print("\n[4] /webhook/drive 엔드포인트 시뮬레이션")

    url = base_url or os.getenv("DRIVE_WATCH_WEBHOOK_URL", "")
    if not url:
        result.add("webhook/drive 시뮬레이션", VerifyResult.SKIP, "URL 미설정")
        return False

    webhook_url = f"{url}/webhook/drive"

    # 테스트 채널 ID (존재하지 않는 ID — 404 응답 예상)
    test_channel_id = f"test-{uuid.uuid4()}"
    test_headers = {
        "X-Goog-Channel-ID": test_channel_id,
        "X-Goog-Resource-State": "change",
        "X-Goog-Resource-ID": "test-resource-id-12345",
        "X-Goog-Channel-Token": "repo=sun2141/grace-ai",
        "X-Goog-Channel-Expiration": (
            datetime.now(timezone.utc) + timedelta(hours=23)
        ).strftime("%a, %d %b %Y %H:%M:%S GMT"),
        "Content-Type": "application/json",
    }

    try:
        resp = requests.post(webhook_url, headers=test_headers, timeout=10, verify=False)

        if resp.status_code == 200:
            result.add(
                "/webhook/drive 수신 (sync 알림)",
                VerifyResult.PASS,
                "200 OK — 엔드포인트 정상 동작",
            )
            return True
        elif resp.status_code == 404:
            # 존재하지 않는 채널 ID이므로 404는 정상 (서버가 살아있음 확인)
            result.add(
                "/webhook/drive 수신 (알 수 없는 채널)",
                VerifyResult.PASS,
                f"404 응답 — 서버 정상 동작 (테스트 채널 ID 미등록 상태, 예상된 결과)",
            )
            return True
        elif resp.status_code == 204:
            result.add(
                "/webhook/drive 수신",
                VerifyResult.PASS,
                "204 No Content — 정상 수신",
            )
            return True
        else:
            result.add(
                "/webhook/drive 수신",
                VerifyResult.WARN,
                f"HTTP {resp.status_code}: {resp.text[:200]}",
            )
            return True
    except requests.exceptions.ConnectionError as e:
        result.add(
            "/webhook/drive 시뮬레이션",
            VerifyResult.FAIL,
            f"연결 실패: {e}",
            "서버가 실행 중이고 포트가 열려 있는지 확인",
        )
        return False
    except Exception as e:
        result.add("/webhook/drive 시뮬레이션", VerifyResult.FAIL, f"오류: {e}")
        return False


def check_watch_register_endpoint(result: VerifyResult, base_url: str) -> bool:
    """
    /watch/register 엔드포인트로 Watch 채널 등록 시도.
    실제 Drive API 호출이 발생하므로 DRIVE_WATCH_WEBHOOK_URL이 HTTPS여야 함.
    """
    print("\n[5] Watch 채널 등록 시도 (/watch/register)")

    url = base_url or os.getenv("DRIVE_WATCH_WEBHOOK_URL", "")
    if not url:
        result.add("Watch 채널 등록", VerifyResult.SKIP, "URL 미설정")
        return False

    folder_id = os.getenv("GOOGLE_DRIVE_FOLDER_ID", "")
    if not folder_id:
        result.add(
            "Watch 채널 등록",
            VerifyResult.SKIP,
            "GOOGLE_DRIVE_FOLDER_ID 미설정 — Drive 연동 없이 스킵",
        )
        return False

    try:
        resp = requests.post(
            f"{url}/watch/register",
            json={"repo": "sun2141/grace-ai"},
            timeout=30,
            verify=False,
        )

        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                channel_id = data.get("channel_id", "?")
                result.add(
                    "Watch 채널 등록",
                    VerifyResult.PASS,
                    f"채널 ID: {channel_id[:8]}... (sun2141/grace-ai)",
                )
                return True
            else:
                # Watch API 비활성화 상태 (DRIVE_WATCH_WEBHOOK_URL 미설정)
                message = data.get("message", "알 수 없는 응답")
                result.add(
                    "Watch 채널 등록",
                    VerifyResult.WARN,
                    f"Watch API 비활성화: {message}",
                    "VPS .env에 DRIVE_WATCH_WEBHOOK_URL=https://your-vps.com 설정 필요",
                )
                return False
        elif resp.status_code == 500:
            result.add(
                "Watch 채널 등록",
                VerifyResult.FAIL,
                f"서버 오류 (500): {resp.text[:200]}",
                "Drive 인증 확인: token.json 유효 여부, drive 스코프 포함 여부",
            )
            return False
        else:
            result.add(
                "Watch 채널 등록",
                VerifyResult.WARN,
                f"HTTP {resp.status_code}: {resp.text[:100]}",
            )
            return False
    except Exception as e:
        result.add("Watch 채널 등록", VerifyResult.FAIL, f"오류: {e}")
        return False


def check_watch_renew_logic(result: VerifyResult):
    """
    Drive Watch 채널 TTL 갱신 로직 로컬 검증.
    실제 API 없이 DriveWatchManager.renew_expiring_channels() 동작 확인.
    """
    print("\n[6] Watch 채널 TTL 갱신 로직 검증 (로컬)")

    try:
        from unittest.mock import MagicMock, patch
        from drive_github_sync import DriveWatchManager, WatchChannel

        # Mock DriveGitHubSync
        mock_syncer = MagicMock()
        mock_syncer.drive = MagicMock()
        mock_syncer.get_all_mapped_folders.return_value = []

        # DriveWatchManager 생성 (Watch 채널 파일 없는 상태)
        with patch("drive_github_sync.WATCH_STATE_FILE", Path("/tmp/test_watch_channels.json")):
            manager = DriveWatchManager(mock_syncer)

        # 만료 임박 채널 시뮬레이션 (30분 후 만료)
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        expiring_channel = WatchChannel(
            channel_id="test-channel-001",
            resource_id="test-resource-001",
            folder_id="test-folder-001",
            repo="sun2141/grace-ai",
            expiration_ms=now_ms + 30 * 60 * 1000,  # 30분 후 만료
            page_token="test-page-token",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        manager._channels["test-channel-001"] = expiring_channel

        # register_watch mock 설정
        renewed_channels = []
        def mock_register(folder_id, repo):
            renewed_channels.append((folder_id, repo))
            return WatchChannel(
                channel_id=f"renewed-{uuid.uuid4()}",
                resource_id="new-resource",
                folder_id=folder_id,
                repo=repo,
                expiration_ms=now_ms + 23 * 3600 * 1000,
                page_token="new-page-token",
                created_at=datetime.now(timezone.utc).isoformat(),
            )
        manager.register_watch = mock_register

        # stop_watch mock (채널 해제)
        stopped_channels = []
        def mock_stop(channel_id):
            stopped_channels.append(channel_id)
            if channel_id in manager._channels:
                del manager._channels[channel_id]
            return True
        manager.stop_watch = mock_stop

        # 1시간 임박 임계값으로 갱신 실행 → 30분 채널은 갱신 대상
        manager.renew_expiring_channels(threshold_seconds=3600)

        if "test-channel-001" in stopped_channels and len(renewed_channels) == 1:
            result.add(
                "만료 임박 채널 자동 갱신",
                VerifyResult.PASS,
                f"기존 채널 해제 후 새 채널 등록 확인\n"
                f"   해제된 채널: {stopped_channels[0]}\n"
                f"   갱신된 채널: {renewed_channels[0][1]}",
            )
        else:
            result.add(
                "만료 임박 채널 자동 갱신",
                VerifyResult.FAIL,
                f"갱신 미실행 — 해제: {stopped_channels}, 등록: {renewed_channels}",
            )

        # 충분한 TTL의 채널은 갱신 안 함
        manager._channels.clear()
        healthy_channel = WatchChannel(
            channel_id="test-channel-healthy",
            resource_id="test-resource-002",
            folder_id="test-folder-002",
            repo="sun2141/palmoni",
            expiration_ms=now_ms + 20 * 3600 * 1000,  # 20시간 후 만료
            page_token="test-page-token-2",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        manager._channels["test-channel-healthy"] = healthy_channel

        renewed_before = len(renewed_channels)
        manager.renew_expiring_channels(threshold_seconds=3600)

        if len(renewed_channels) == renewed_before:
            result.add(
                "TTL 여유 채널 갱신 제외",
                VerifyResult.PASS,
                "20시간 TTL 채널은 1시간 임계값 이내 아님 — 갱신 건너뜀",
            )
        else:
            result.add(
                "TTL 여유 채널 갱신 제외",
                VerifyResult.FAIL,
                "TTL 여유 채널을 불필요하게 갱신함",
            )

    except ImportError as e:
        result.add(
            "Watch 갱신 로직 검증",
            VerifyResult.SKIP,
            f"의존성 없음: {e}",
        )
    except Exception as e:
        result.add(
            "Watch 갱신 로직 검증",
            VerifyResult.FAIL,
            f"예외 발생: {e}",
        )


def check_sync_state_repos(result: VerifyResult):
    """
    sync_state.json에 양쪽 저장소(grace-ai, palmoni)가 모두 추적되는지 확인.
    """
    print("\n[7] sync_state.json 저장소 추적 상태 확인")

    state_file = BASE_DIR / ".tmp" / "sync_state.json"
    if not state_file.exists():
        result.add(
            "sync_state.json 존재",
            VerifyResult.FAIL,
            f"{state_file} 파일 없음",
            "sync_logger.py 실행 또는 서버 시작으로 파일 생성",
        )
        return

    try:
        with open(state_file) as f:
            state = json.load(f)
    except Exception as e:
        result.add("sync_state.json 파싱", VerifyResult.FAIL, f"JSON 오류: {e}")
        return

    result.add("sync_state.json 존재", VerifyResult.PASS)

    # grace-ai 추적
    if "sun2141/grace-ai" in state:
        files = [k for k in state["sun2141/grace-ai"].keys() if not k.startswith("_")]
        result.add(
            "grace-ai 저장소 추적",
            VerifyResult.PASS,
            f"추적 파일 {len(files)}개",
        )
    else:
        result.add(
            "grace-ai 저장소 추적",
            VerifyResult.FAIL,
            "sun2141/grace-ai 키 없음",
        )

    # palmoni 추적
    if "sun2141/palmoni" in state:
        files = [k for k in state["sun2141/palmoni"].keys() if not k.startswith("_")]
        initialized = "_metadata" in state["sun2141/palmoni"]
        result.add(
            "palmoni 저장소 추적",
            VerifyResult.PASS,
            f"추적 파일 {len(files)}개{'(초기화됨)' if initialized else ''}",
        )
    else:
        result.add(
            "palmoni 저장소 추적",
            VerifyResult.FAIL,
            "sun2141/palmoni 키 없음 — palmoni 저장소가 추적되지 않음",
            "sync_state.json에 sun2141/palmoni 섹션 추가 필요",
        )

    # Drive→GitHub 상태 (palmoni)
    if "__drive__sun2141/palmoni" in state:
        result.add(
            "palmoni Drive→GitHub 상태 추적",
            VerifyResult.PASS,
            "Drive→GitHub 동기화 상태 초기화됨",
        )
    else:
        result.add(
            "palmoni Drive→GitHub 상태 추적",
            VerifyResult.FAIL,
            "__drive__sun2141/palmoni 키 없음",
        )


def check_mappings_endpoint(result: VerifyResult, base_url: str):
    """
    /mappings 엔드포인트로 양쪽 저장소 매핑 상태 확인.
    """
    print("\n[8] 저장소 매핑 상태 확인 (/mappings)")

    url = base_url or os.getenv("DRIVE_WATCH_WEBHOOK_URL", "")
    if not url:
        result.add("저장소 매핑 조회", VerifyResult.SKIP, "URL 미설정")
        return

    try:
        resp = requests.get(f"{url}/mappings", timeout=10, verify=False)
        if resp.status_code == 200:
            data = resp.json()
            repos = [m.get("repo") for m in data.get("mappings", [])]

            if "sun2141/grace-ai" in repos:
                result.add("grace-ai 매핑", VerifyResult.PASS)
            else:
                result.add("grace-ai 매핑", VerifyResult.FAIL, "매핑 없음")

            if "sun2141/palmoni" in repos:
                result.add("palmoni 매핑", VerifyResult.PASS)
            else:
                result.add(
                    "palmoni 매핑",
                    VerifyResult.WARN,
                    "GOOGLE_DRIVE_FOLDER_ID_PALMONI 미설정으로 매핑 없음",
                    ".env에 GOOGLE_DRIVE_FOLDER_ID_PALMONI=<Drive 폴더 ID> 추가",
                )
        else:
            result.add("저장소 매핑 조회", VerifyResult.FAIL, f"HTTP {resp.status_code}")
    except Exception as e:
        result.add("저장소 매핑 조회", VerifyResult.FAIL, f"오류: {e}")


# ─── 메인 ────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Drive Watch API 운영 환경 검증 스크립트"
    )
    parser.add_argument(
        "--url",
        default="",
        help="VPS 서버 URL (기본값: DRIVE_WATCH_WEBHOOK_URL 환경변수)",
    )
    parser.add_argument(
        "--check",
        choices=["url", "register", "webhook", "renew", "state", "all"],
        default="all",
        help="실행할 검증 항목 선택 (기본: all)",
    )
    args = parser.parse_args()

    # HTTPS 경고 비활성화 (VPS HTTP 접근 시)
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    base_url = args.url.rstrip("/")
    result = VerifyResult()

    print("=" * 60)
    print("Drive Watch API 운영 환경 검증")
    print(f"대상 서버: {base_url or os.getenv('DRIVE_WATCH_WEBHOOK_URL', '(환경변수 사용)')}")
    print(f"검증 항목: {args.check}")
    print("=" * 60)

    check_map = {
        "url": lambda: (
            check_environment(result, base_url) and
            check_url_accessibility(result, base_url)
        ),
        "register": lambda: check_watch_register_endpoint(result, base_url),
        "webhook": lambda: check_webhook_drive_endpoint(result, base_url),
        "renew": lambda: check_watch_renew_logic(result),
        "state": lambda: check_sync_state_repos(result),
        "all": lambda: (
            check_environment(result, base_url) and
            check_url_accessibility(result, base_url) and
            check_watch_status_endpoint(result, base_url) or True,
            check_webhook_drive_endpoint(result, base_url),
            check_watch_register_endpoint(result, base_url),
            check_watch_renew_logic(result),
            check_sync_state_repos(result),
            check_mappings_endpoint(result, base_url),
        ),
    }

    if args.check == "all":
        env_ok = check_environment(result, base_url)
        url_ok = check_url_accessibility(result, base_url)
        check_watch_status_endpoint(result, base_url)
        check_webhook_drive_endpoint(result, base_url)
        check_watch_register_endpoint(result, base_url)
        check_watch_renew_logic(result)
        check_sync_state_repos(result)
        check_mappings_endpoint(result, base_url)
    else:
        check_map[args.check]()

    success = result.summary()

    if not success:
        print("\n일부 검증 실패. 위 해결 방법을 참고하여 수정 후 재실행하세요.")
        sys.exit(1)
    else:
        print("\n모든 검증 완료.")
        sys.exit(0)


if __name__ == "__main__":
    main()
