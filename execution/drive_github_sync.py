"""
Google Drive → GitHub 동기화 엔진

핵심 기능:
1. Drive 폴더 재귀 탐색 (트리 구조 유지)
2. Drive 파일 변경 감지 (modifiedTime 비교)
3. GitHub REST API로 파일 커밋
4. [drive-sync] 태그로 무한루프 방지
5. 바이너리 파일 base64 처리
6. 충돌 감지: GitHub-side 최신 커밋과 Drive 변경 시각 비교
7. Drive Watch API (Push Notification): 실시간 변경 알림 (폴링보다 빠름)

Drive Watch API 동작 방식:
  - files().watch() 호출 → Google이 변경 발생 시 webhook URL로 POST 전송
  - /webhook/drive 엔드포인트에서 수신 → Changes API로 실제 변경 파일 조회
  - 채널은 TTL 만료(기본 24시간) 전 갱신 필요
  - 공개 HTTPS URL 필요 (ngrok 또는 VPS 도메인)
  - 환경변수 DRIVE_WATCH_WEBHOOK_URL 미설정 시 폴링 모드로 자동 폴백
"""

import os
import io
import json
import logging
import base64
import mimetypes
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field
from typing import Optional

import requests
from googleapiclient.errors import HttpError

from drive_auth import get_drive_service
from sync_logger import get_sync_logger
from telegram_notifier import (
    notify_drive_sync_success,
    notify_drive_sync_failure,
    notify_conflict,
    notify_auth_error,
)

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent
MAPPING_FILE = BASE_DIR / "config" / "repo_drive_mapping.json"

# GitHub API
GITHUB_API = "https://api.github.com"
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")

# Drive→GitHub 커밋 태그 (무한루프 방지)
DRIVE_SYNC_TAG = "[drive-sync]"
GITHUB_SYNC_TAG = "[github-sync]"

# 바이너리 확장자 목록
BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp", ".svg",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".zip", ".tar", ".gz", ".rar", ".7z",
    ".mp3", ".mp4", ".mov", ".avi", ".wav",
    ".ttf", ".otf", ".woff", ".woff2",
    ".exe", ".bin", ".so", ".dylib",
    ".pkl", ".pt", ".h5",
}

# 최대 파일 크기: 50MB (GitHub API 한계 100MB, 안전 마진)
MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024


@dataclass
class DriveFile:
    """Drive 파일 정보."""
    file_id: str
    name: str
    path: str             # Drive 루트 기준 상대 경로 (예: execution/sync.py)
    modified_time: str    # ISO 8601
    size: int = 0
    mime_type: str = ""
    is_folder: bool = False


@dataclass
class DriveChangeResult:
    """Drive→GitHub 동기화 결과."""
    folder_id: str
    repo: str
    synced: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    failed: list[dict] = field(default_factory=list)

    @property
    def success(self) -> bool:
        return len(self.failed) == 0


class DriveGitHubSync:
    """Google Drive 변경사항을 GitHub에 동기화."""

    def __init__(self):
        self.sync_logger = get_sync_logger()
        self.mapping = self._load_mapping()
        self._drive_service = None  # 지연 초기화
        self._github_headers = self._build_github_headers()

    @property
    def drive(self):
        """Drive 서비스 (필요 시 초기화)."""
        if self._drive_service is None:
            try:
                self._drive_service = get_drive_service()
            except Exception as e:
                notify_auth_error(str(e))
                raise
        return self._drive_service

    def _build_github_headers(self) -> dict:
        headers = {
            "Accept": "application/vnd.github.v3+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if GITHUB_TOKEN:
            headers["Authorization"] = f"token {GITHUB_TOKEN}"
        return headers

    # ─── 매핑 ─────────────────────────────────────────────────────

    def _load_mapping(self) -> dict:
        if not MAPPING_FILE.exists():
            return {"repositories": {}, "defaults": {}}
        with open(MAPPING_FILE) as f:
            return json.load(f)

    def get_repo_for_drive_folder(self, folder_id: str) -> tuple[str, dict] | tuple[None, None]:
        """Drive 폴더 ID로 해당 저장소 설정 반환."""
        for repo, config in self.mapping.get("repositories", {}).items():
            # 환경 변수 치환
            drive_folder_id = config.get("drive_folder_id", "")
            if drive_folder_id.startswith("${"):
                var_name = drive_folder_id[2:-1]
                drive_folder_id = os.getenv(var_name, "")

            if drive_folder_id == folder_id:
                config = dict(config)
                config["drive_folder_id"] = drive_folder_id
                return repo, config

        return None, None

    def get_all_mapped_folders(self) -> list[tuple[str, str, dict]]:
        """매핑된 모든 (repo, folder_id, config) 반환."""
        result = []
        for repo, config in self.mapping.get("repositories", {}).items():
            drive_folder_id = config.get("drive_folder_id", "")
            if drive_folder_id.startswith("${"):
                var_name = drive_folder_id[2:-1]
                drive_folder_id = os.getenv(var_name, "")
            if drive_folder_id:
                result.append((repo, drive_folder_id, dict(config)))
        return result

    # ─── Drive 탐색 ───────────────────────────────────────────────

    def list_drive_files(
        self,
        folder_id: str,
        path_prefix: str = "",
        exclude_patterns: list[str] | None = None,
    ) -> list[DriveFile]:
        """
        Drive 폴더를 재귀 탐색하여 모든 파일 반환.

        Args:
            folder_id: Drive 폴더 ID
            path_prefix: 상위 폴더 경로 (재귀 시 사용)
            exclude_patterns: 제외할 패턴 목록

        Returns:
            DriveFile 목록 (폴더 제외, 파일만)
        """
        import fnmatch
        exclude_patterns = exclude_patterns or []
        files = []
        page_token = None

        while True:
            params = {
                "q": f"'{folder_id}' in parents and trashed=false",
                "fields": "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
                "pageSize": 100,
                "orderBy": "name",
            }
            if page_token:
                params["pageToken"] = page_token

            try:
                result = self.drive.files().list(**params).execute()
            except HttpError as e:
                logger.error(f"Drive 폴더 목록 조회 실패 ({folder_id}): {e}")
                break

            for item in result.get("files", []):
                name = item["name"]
                rel_path = f"{path_prefix}{name}" if path_prefix else name
                is_folder = item["mimeType"] == "application/vnd.google-apps.folder"

                # 제외 패턴 확인
                skip = False
                for pattern in exclude_patterns:
                    if fnmatch.fnmatch(rel_path, pattern) or fnmatch.fnmatch(name, pattern):
                        skip = True
                        break
                if skip:
                    continue

                if is_folder:
                    # 재귀 탐색
                    sub_files = self.list_drive_files(
                        folder_id=item["id"],
                        path_prefix=f"{rel_path}/",
                        exclude_patterns=exclude_patterns,
                    )
                    files.extend(sub_files)
                else:
                    # Google Docs/Sheets/Slides는 텍스트로 export 가능
                    files.append(DriveFile(
                        file_id=item["id"],
                        name=name,
                        path=rel_path,
                        modified_time=item.get("modifiedTime", ""),
                        size=int(item.get("size", 0)),
                        mime_type=item.get("mimeType", ""),
                        is_folder=False,
                    ))

            page_token = result.get("nextPageToken")
            if not page_token:
                break

        return files

    def get_changed_drive_files(
        self,
        folder_id: str,
        repo: str,
        config: dict,
    ) -> list[DriveFile]:
        """
        마지막 동기화 이후 변경된 Drive 파일만 반환.
        sync_state의 drive_modified_time과 비교.
        """
        import fnmatch
        exclude_patterns = config.get("exclude_patterns", [])
        sync_paths = config.get("sync_paths", [])

        all_files = self.list_drive_files(folder_id, exclude_patterns=exclude_patterns)

        changed = []
        for f in all_files:
            # sync_paths 필터
            if sync_paths and not any(f.path.startswith(p) for p in sync_paths):
                continue

            # 마지막 동기화 시각 비교
            state = self.sync_logger.get_drive_file_state(repo, f.path)
            if state:
                last_sync_time = state.get("drive_modified_time", "")
                if last_sync_time and f.modified_time <= last_sync_time:
                    logger.debug(f"변경 없음 — 스킵: {f.path}")
                    continue

            changed.append(f)

        logger.info(f"Drive 변경 파일: {len(changed)}/{len(all_files)}개")
        return changed

    # ─── 파일 내용 다운로드 ──────────────────────────────────────

    def download_drive_file(self, drive_file: DriveFile) -> bytes | None:
        """
        Drive 파일 내용 다운로드.
        Google Docs 형식은 텍스트로 export.
        바이너리 파일은 bytes 그대로 반환.
        크기 초과 시 None 반환.
        """
        if drive_file.size > MAX_FILE_SIZE_BYTES:
            logger.warning(f"파일 크기 초과 — 스킵: {drive_file.path} ({drive_file.size / 1024 / 1024:.1f}MB)")
            return None

        try:
            # Google Native 파일 (Docs, Sheets, Slides) → export
            google_mime_export = {
                "application/vnd.google-apps.document": (
                    "text/plain", ".txt"
                ),
                "application/vnd.google-apps.spreadsheet": (
                    "text/csv", ".csv"
                ),
                "application/vnd.google-apps.presentation": (
                    "text/plain", ".txt"
                ),
            }

            if drive_file.mime_type in google_mime_export:
                export_mime, _ = google_mime_export[drive_file.mime_type]
                request = self.drive.files().export_media(
                    fileId=drive_file.file_id,
                    mimeType=export_mime,
                )
            else:
                request = self.drive.files().get_media(
                    fileId=drive_file.file_id
                )

            content = request.execute()
            if isinstance(content, bytes):
                return content
            return content.encode("utf-8") if content else b""

        except HttpError as e:
            logger.error(f"Drive 다운로드 실패: {drive_file.path} — {e}")
            return None
        except Exception as e:
            logger.error(f"Drive 다운로드 예외: {drive_file.path} — {e}")
            return None

    # ─── 충돌 감지 ───────────────────────────────────────────────

    def check_conflict(
        self,
        repo: str,
        file_path: str,
        drive_modified_time: str,
    ) -> bool:
        """
        충돌 감지: GitHub에 있는 최신 커밋 시각과 Drive 수정 시각 비교.

        충돌 조건:
        - GitHub에 해당 파일이 있고
        - GitHub 마지막 커밋이 Drive 마지막 동기화 이후에 발생
        - 그 커밋이 [drive-sync] 태그가 아닌 경우

        Returns:
            True: 충돌 있음, False: 없음
        """
        state = self.sync_logger.get_drive_file_state(repo, file_path)
        if not state:
            # 신규 파일: 충돌 없음
            return False

        last_github_sync_sha = state.get("github_sync_sha", "")
        if not last_github_sync_sha:
            return False

        # GitHub에서 해당 파일의 최신 커밋 조회
        try:
            url = f"{GITHUB_API}/repos/{repo}/commits"
            resp = requests.get(
                url,
                headers=self._github_headers,
                params={"path": file_path, "per_page": 1},
                timeout=15,
            )
            resp.raise_for_status()
            commits = resp.json()
            if not commits:
                return False

            latest_commit = commits[0]
            latest_sha = latest_commit["sha"]
            latest_message = latest_commit["commit"]["message"]

            # 마지막으로 알려진 GitHub sync SHA와 다르고
            # 그 커밋이 drive-sync 커밋이 아닌 경우 = 충돌
            if latest_sha != last_github_sync_sha and DRIVE_SYNC_TAG not in latest_message:
                logger.warning(
                    f"충돌 감지: {file_path}\n"
                    f"  GitHub 최신: {latest_sha[:7]} ({latest_message[:60]})\n"
                    f"  Drive 수정: {drive_modified_time}"
                )
                return True

        except Exception as e:
            logger.warning(f"충돌 확인 실패 (무시하고 진행): {file_path} — {e}")

        return False

    # ─── GitHub 업로드 ───────────────────────────────────────────

    def get_github_file_sha(self, repo: str, file_path: str, branch: str = "main") -> str | None:
        """GitHub에서 파일의 blob SHA 조회 (업데이트 시 필요)."""
        url = f"{GITHUB_API}/repos/{repo}/contents/{file_path}"
        try:
            resp = requests.get(
                url,
                headers=self._github_headers,
                params={"ref": branch},
                timeout=15,
            )
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json().get("sha")
        except Exception as e:
            logger.warning(f"GitHub 파일 SHA 조회 실패: {file_path} — {e}")
            return None

    def commit_file_to_github(
        self,
        repo: str,
        file_path: str,
        content: bytes,
        drive_modified_time: str,
        branch: str = "main",
    ) -> dict | None:
        """
        GitHub에 파일 커밋.

        Returns:
            커밋 정보 dict 또는 None (실패 시)
        """
        url = f"{GITHUB_API}/repos/{repo}/contents/{file_path}"

        # 파일 내용을 base64 인코딩
        content_b64 = base64.b64encode(content).decode("utf-8")

        # 기존 파일 SHA 조회 (업데이트 시 필요)
        existing_sha = self.get_github_file_sha(repo, file_path, branch)

        # 커밋 메시지 (무한루프 방지 태그 포함)
        commit_message = (
            f"{DRIVE_SYNC_TAG} sync {file_path}\n\n"
            f"Drive modified: {drive_modified_time}\n"
            f"Auto-synced by GitHub-Drive Sync Agent"
        )

        body = {
            "message": commit_message,
            "content": content_b64,
            "branch": branch,
        }
        if existing_sha:
            body["sha"] = existing_sha

        try:
            resp = requests.put(
                url,
                headers=self._github_headers,
                json=body,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            commit_sha = data.get("commit", {}).get("sha", "")
            logger.info(f"GitHub 커밋 완료: {file_path} ({commit_sha[:7]})")
            return data
        except requests.HTTPError as e:
            logger.error(f"GitHub 커밋 실패: {file_path} — {e.response.status_code}: {e.response.text[:200]}")
            return None
        except Exception as e:
            logger.error(f"GitHub 커밋 예외: {file_path} — {e}")
            return None

    # ─── 메인 동기화 ─────────────────────────────────────────────

    def sync_drive_to_github(
        self,
        folder_id: str,
        repo: str,
        config: dict | None = None,
        branch: str = "main",
    ) -> DriveChangeResult:
        """
        Drive 폴더의 변경사항을 GitHub에 동기화.

        Args:
            folder_id: Drive 폴더 ID
            repo: GitHub 저장소 (owner/repo)
            config: 매핑 설정 (None이면 자동 조회)
            branch: 대상 브랜치 (기본: main)

        Returns:
            DriveChangeResult
        """
        if config is None:
            _, config = self.get_repo_for_drive_folder(folder_id)

        result = DriveChangeResult(folder_id=folder_id, repo=repo)

        if not config:
            logger.warning(f"매핑 설정 없음: folder={folder_id}, repo={repo}")
            return result

        if not GITHUB_TOKEN:
            logger.error("GITHUB_TOKEN 미설정 — Drive→GitHub 동기화 불가")
            result.failed.append({"file": "*", "error": "GITHUB_TOKEN not set"})
            return result

        # Drive 변경 파일 수집
        changed_files = self.get_changed_drive_files(folder_id, repo, config)

        if not changed_files:
            logger.info(f"Drive 변경 파일 없음: {repo}")
            self.sync_logger.log_event(
                "drive_poll", repo,
                {"folder_id": folder_id, "reason": "no_changes"},
                status="skipped",
            )
            return result

        logger.info(f"Drive→GitHub 동기화 시작: {len(changed_files)}개 파일")

        defaults = self.mapping.get("defaults", {})
        max_attempts = defaults.get("retry_attempts", 3)
        backoff = defaults.get("retry_backoff_seconds", [1, 2, 4])

        for drive_file in changed_files:
            self._sync_drive_file_with_retry(
                drive_file=drive_file,
                repo=repo,
                branch=branch,
                result=result,
                max_attempts=max_attempts,
                backoff=backoff,
            )

        # 결과 알림
        if result.synced:
            notify_drive_sync_success(
                repo=repo,
                folder_id=folder_id,
                files_synced=result.synced,
                files_skipped=len(result.skipped),
            )
        if result.failed:
            notify_drive_sync_failure(
                repo=repo,
                folder_id=folder_id,
                failed_files=result.failed,
            )
        if result.conflicts:
            for conflict in result.conflicts:
                notify_conflict(
                    repo=repo,
                    file_path=conflict["file"],
                    conflict_info=conflict.get("info", ""),
                )

        self.sync_logger.log_event(
            "drive_sync", repo,
            {
                "folder_id": folder_id,
                "synced": len(result.synced),
                "skipped": len(result.skipped),
                "conflicts": len(result.conflicts),
                "failed": len(result.failed),
            },
            status="success" if result.success else "failure",
        )

        return result

    def _sync_drive_file_with_retry(
        self,
        drive_file: DriveFile,
        repo: str,
        branch: str,
        result: DriveChangeResult,
        max_attempts: int = 3,
        backoff: list[int] | None = None,
    ):
        """재시도 로직 포함 단일 파일 동기화."""
        backoff = backoff or [1, 2, 4]

        # 충돌 확인
        if self.check_conflict(repo, drive_file.path, drive_file.modified_time):
            result.conflicts.append({
                "file": drive_file.path,
                "info": f"GitHub에 별도 변경 존재. Drive 수정: {drive_file.modified_time}",
            })
            # 충돌 시: 로그에 기록하되 Drive 버전을 우선 적용 (전략: Drive wins)
            logger.warning(f"충돌 — Drive 우선 적용: {drive_file.path}")

        for attempt in range(max_attempts):
            try:
                # 파일 내용 다운로드
                content = self.download_drive_file(drive_file)
                if content is None:
                    result.skipped.append(drive_file.path)
                    return

                # GitHub에 커밋
                commit_data = self.commit_file_to_github(
                    repo=repo,
                    file_path=drive_file.path,
                    content=content,
                    drive_modified_time=drive_file.modified_time,
                    branch=branch,
                )

                if commit_data is None:
                    if attempt < max_attempts - 1:
                        wait = backoff[min(attempt, len(backoff) - 1)]
                        logger.warning(f"GitHub 커밋 실패 ({attempt+1}/{max_attempts}) — {wait}초 후 재시도")
                        time.sleep(wait)
                        continue
                    else:
                        result.failed.append({
                            "file": drive_file.path,
                            "error": "GitHub commit failed after retries",
                        })
                        self.sync_logger.log_event(
                            "drive_sync_file", repo,
                            {"file": drive_file.path},
                            status="failure",
                            error="GitHub commit failed",
                        )
                        return

                # 성공: 상태 업데이트
                commit_sha = commit_data.get("commit", {}).get("sha", "")
                self.sync_logger.update_drive_file_state(
                    repo=repo,
                    file_path=drive_file.path,
                    drive_file_id=drive_file.file_id,
                    drive_modified_time=drive_file.modified_time,
                    github_sync_sha=commit_sha,
                )
                result.synced.append(drive_file.path)
                self.sync_logger.log_event(
                    "drive_sync_file", repo,
                    {
                        "file": drive_file.path,
                        "drive_id": drive_file.file_id,
                        "commit_sha": commit_sha[:7] if commit_sha else "",
                    },
                )
                return

            except Exception as e:
                error_msg = str(e)
                logger.error(f"Drive→GitHub 동기화 오류: {drive_file.path} — {error_msg}")
                if attempt < max_attempts - 1:
                    wait = backoff[min(attempt, len(backoff) - 1)]
                    time.sleep(wait)
                else:
                    result.failed.append({"file": drive_file.path, "error": error_msg})
                    self.sync_logger.log_event(
                        "drive_sync_file", repo,
                        {"file": drive_file.path},
                        status="failure",
                        error=error_msg,
                    )

    # ─── 전체 폴링 실행 ──────────────────────────────────────────

    def poll_all_folders(self) -> list[DriveChangeResult]:
        """
        매핑된 모든 Drive 폴더를 폴링하여 변경사항 동기화.
        스케줄러에서 주기적으로 호출.
        """
        results = []
        for repo, folder_id, config in self.get_all_mapped_folders():
            logger.info(f"Drive 폴링: {repo} (folder: {folder_id[:8]}...)")
            try:
                result = self.sync_drive_to_github(
                    folder_id=folder_id,
                    repo=repo,
                    config=config,
                )
                results.append(result)
            except Exception as e:
                logger.error(f"폴링 오류: {repo} — {e}")
                self.sync_logger.log_event(
                    "drive_poll", repo,
                    {"folder_id": folder_id},
                    status="failure",
                    error=str(e),
                )
        return results


# ─── Drive Watch API (Push Notification) ─────────────────────

# Watch 채널 상태 저장 경로
WATCH_STATE_FILE = Path(__file__).parent.parent / ".tmp" / "watch_channels.json"

# Watch 채널 TTL: Google 최대 604800초(7일), 실용적으로 23시간 갱신
WATCH_CHANNEL_TTL_SECONDS = 23 * 3600


@dataclass
class WatchChannel:
    """Drive Watch 채널 정보."""
    channel_id: str       # UUID (우리가 생성)
    resource_id: str      # Google이 반환한 resource ID
    folder_id: str        # 감시하는 Drive 폴더 ID
    repo: str             # 연결된 GitHub 저장소
    expiration_ms: int    # 만료 타임스탬프 (밀리초, epoch)
    page_token: str       # Changes API 페이지 토큰 (다음 변경 조회 시작점)
    created_at: str       # 생성 시각 ISO 8601


class DriveWatchManager:
    """
    Google Drive Watch API (Push Notification) 관리.

    폴링 방식보다 실시간성 높음:
    - 파일 변경 → Google이 즉시 /webhook/drive로 POST 전송
    - 서버는 Changes API로 실제 변경 내용 조회
    - 채널 만료 전 자동 갱신

    환경 변수:
      DRIVE_WATCH_WEBHOOK_URL  — 공개 HTTPS URL (예: https://your-server.com)
                                 미설정 시 Watch API 비활성화, 폴링으로 폴백

    제약:
      - 공개 HTTPS 엔드포인트 필수 (localhost 불가)
      - Watch 알림은 변경 발생 알림만 포함; 실제 파일 목록은 Changes API로 별도 조회
      - 채널당 폴더 1개 (재귀 탐색 별도 필요)
    """

    def __init__(self, syncer: "DriveGitHubSync"):
        self.syncer = syncer
        self._channels: dict[str, WatchChannel] = {}  # channel_id → WatchChannel
        self._webhook_url = os.getenv("DRIVE_WATCH_WEBHOOK_URL", "").rstrip("/")
        self._load_channels()

    @property
    def is_enabled(self) -> bool:
        """Watch API 활성화 여부 (HTTPS URL 설정 시 활성화)."""
        return bool(self._webhook_url)

    # ─── 채널 영속성 ──────────────────────────────────────────

    def _load_channels(self):
        """저장된 Watch 채널 정보 로드."""
        if not WATCH_STATE_FILE.exists():
            return
        try:
            with open(WATCH_STATE_FILE) as f:
                data = json.load(f)
            for ch_data in data.get("channels", []):
                ch = WatchChannel(**ch_data)
                self._channels[ch.channel_id] = ch
            logger.info(f"Watch 채널 {len(self._channels)}개 로드")
        except Exception as e:
            logger.warning(f"Watch 채널 상태 로드 실패: {e}")

    def _save_channels(self):
        """Watch 채널 정보 저장."""
        WATCH_STATE_FILE.parent.mkdir(exist_ok=True)
        try:
            channels_data = [
                {
                    "channel_id": ch.channel_id,
                    "resource_id": ch.resource_id,
                    "folder_id": ch.folder_id,
                    "repo": ch.repo,
                    "expiration_ms": ch.expiration_ms,
                    "page_token": ch.page_token,
                    "created_at": ch.created_at,
                }
                for ch in self._channels.values()
            ]
            with open(WATCH_STATE_FILE, "w") as f:
                json.dump({"channels": channels_data}, f, indent=2)
        except Exception as e:
            logger.error(f"Watch 채널 상태 저장 실패: {e}")

    # ─── Changes API 페이지 토큰 ──────────────────────────────

    def _get_start_page_token(self) -> str:
        """Changes API 시작 페이지 토큰 조회."""
        try:
            result = self.syncer.drive.changes().getStartPageToken().execute()
            return result.get("startPageToken", "")
        except Exception as e:
            logger.error(f"Changes API 시작 토큰 조회 실패: {e}")
            return ""

    # ─── Watch 채널 등록 ──────────────────────────────────────

    def register_watch(self, folder_id: str, repo: str) -> WatchChannel | None:
        """
        Drive 폴더에 Watch 채널 등록.

        Args:
            folder_id: 감시할 Drive 폴더 ID
            repo: 연결된 GitHub 저장소

        Returns:
            WatchChannel 또는 None (실패/비활성화 시)
        """
        if not self.is_enabled:
            logger.info(
                "Watch API 비활성화 (DRIVE_WATCH_WEBHOOK_URL 미설정) — 폴링 모드 유지\n"
                "실시간 Watch를 활성화하려면 .env에 DRIVE_WATCH_WEBHOOK_URL=https://your-server.com 추가"
            )
            return None

        channel_id = str(uuid.uuid4())
        webhook_url = f"{self._webhook_url}/webhook/drive"
        expiration_ms = int((datetime.now(timezone.utc) + timedelta(seconds=WATCH_CHANNEL_TTL_SECONDS)).timestamp() * 1000)

        # Changes API 시작 토큰 (채널 등록 이후의 변경만 수신)
        page_token = self._get_start_page_token()

        try:
            response = self.syncer.drive.files().watch(
                fileId=folder_id,
                body={
                    "id": channel_id,
                    "type": "web_hook",
                    "address": webhook_url,
                    "expiration": str(expiration_ms),
                    "token": f"repo={repo}",  # 검증용 토큰
                },
            ).execute()

            resource_id = response.get("resourceId", "")
            channel = WatchChannel(
                channel_id=channel_id,
                resource_id=resource_id,
                folder_id=folder_id,
                repo=repo,
                expiration_ms=int(response.get("expiration", expiration_ms)),
                page_token=page_token,
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            self._channels[channel_id] = channel
            self._save_channels()

            logger.info(
                f"Drive Watch 채널 등록 완료: {repo}\n"
                f"  채널 ID: {channel_id}\n"
                f"  만료: {datetime.fromtimestamp(channel.expiration_ms / 1000, tz=timezone.utc).isoformat()}"
            )
            return channel

        except Exception as e:
            logger.error(f"Drive Watch 채널 등록 실패: {folder_id} ({repo}) — {e}")
            return None

    # ─── Watch 채널 해제 ──────────────────────────────────────

    def stop_watch(self, channel_id: str) -> bool:
        """Watch 채널 해제."""
        ch = self._channels.get(channel_id)
        if not ch:
            logger.warning(f"Watch 채널 없음: {channel_id}")
            return False

        try:
            self.syncer.drive.channels().stop(body={
                "id": ch.channel_id,
                "resourceId": ch.resource_id,
            }).execute()
            del self._channels[channel_id]
            self._save_channels()
            logger.info(f"Watch 채널 해제: {channel_id}")
            return True
        except Exception as e:
            logger.error(f"Watch 채널 해제 실패: {channel_id} — {e}")
            return False

    # ─── 채널 갱신 ────────────────────────────────────────────

    def renew_expiring_channels(self, threshold_seconds: int = 3600):
        """
        만료 임박 채널 갱신.
        threshold_seconds 이내 만료 예정인 채널을 재등록.
        스케줄러에서 주기적으로 호출 (1시간 간격 권장).
        """
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        threshold_ms = threshold_seconds * 1000
        expired = []

        for ch in list(self._channels.values()):
            if ch.expiration_ms - now_ms < threshold_ms:
                logger.info(f"Watch 채널 만료 임박 — 갱신: {ch.channel_id} ({ch.repo})")
                expired.append(ch)

        for ch in expired:
            self.stop_watch(ch.channel_id)
            self.register_watch(ch.folder_id, ch.repo)

    # ─── 변경 이벤트 처리 ─────────────────────────────────────

    def get_channel_by_id(self, channel_id: str) -> WatchChannel | None:
        """채널 ID로 채널 정보 조회."""
        return self._channels.get(channel_id)

    def process_watch_notification(
        self,
        channel_id: str,
        resource_state: str,
    ) -> list[DriveChangeResult]:
        """
        Drive Watch 알림 수신 후 실제 변경 파일 처리.

        Args:
            channel_id: Watch 채널 ID
            resource_state: 알림 상태 ("change", "sync" 등)

        Returns:
            동기화 결과 목록
        """
        ch = self.get_channel_by_id(channel_id)
        if not ch:
            logger.warning(f"알 수 없는 Watch 채널 ID: {channel_id}")
            return []

        if resource_state == "sync":
            # 채널 등록 확인용 초기 알림 — 변경 없음
            logger.info(f"Watch 채널 sync 알림 수신 (채널 등록 확인): {channel_id}")
            return []

        logger.info(f"Drive Watch 알림 수신: channel={channel_id[:8]}... state={resource_state}")

        # Changes API로 실제 변경 파일 목록 조회
        try:
            changes, new_token = self._list_changes(ch.page_token)

            # 페이지 토큰 업데이트 (다음 조회 시작점)
            if new_token:
                ch.page_token = new_token
                self._save_channels()

            if not changes:
                logger.info(f"Watch 알림 수신했으나 관련 변경 없음: {ch.repo}")
                return []

            logger.info(f"Drive 변경 {len(changes)}건 감지: {ch.repo}")

            # 변경된 파일 경로 수집 후 Drive→GitHub 동기화 실행
            result = self.syncer.sync_drive_to_github(
                folder_id=ch.folder_id,
                repo=ch.repo,
            )
            return [result]

        except Exception as e:
            logger.error(f"Watch 알림 처리 오류: {channel_id} — {e}")
            return []

    def _list_changes(self, page_token: str) -> tuple[list[dict], str]:
        """
        Changes API로 변경 목록 조회.

        Returns:
            (변경 목록, 다음 페이지 토큰)
        """
        if not page_token:
            return [], ""

        changes = []
        next_token = page_token

        try:
            while True:
                response = self.syncer.drive.changes().list(
                    pageToken=next_token,
                    fields="nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,parents))",
                    includeRemoved=False,
                    restrictToMyDrive=True,
                ).execute()

                changes.extend(response.get("changes", []))

                if "nextPageToken" in response:
                    next_token = response["nextPageToken"]
                else:
                    # newStartPageToken: 다음 폴링 시작점
                    next_token = response.get("newStartPageToken", next_token)
                    break

        except Exception as e:
            logger.error(f"Changes API 조회 실패: {e}")

        return changes, next_token

    # ─── 전체 폴더 Watch 등록 ─────────────────────────────────

    def register_all_mapped_folders(self):
        """
        매핑된 모든 Drive 폴더에 Watch 채널 등록.
        서버 시작 시 호출.
        이미 유효한 채널이 있으면 스킵.
        """
        if not self.is_enabled:
            return

        mapped = self.syncer.get_all_mapped_folders()
        registered_folders = {ch.folder_id for ch in self._channels.values()}

        for repo, folder_id, _ in mapped:
            if folder_id in registered_folders:
                logger.debug(f"Watch 채널 이미 존재: {repo} ({folder_id[:12]}...)")
                continue
            self.register_watch(folder_id, repo)

    def get_watch_status(self) -> dict:
        """Watch 채널 현황 반환."""
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        channels = []
        for ch in self._channels.values():
            remaining_seconds = max(0, (ch.expiration_ms - now_ms) // 1000)
            channels.append({
                "channel_id": ch.channel_id,
                "repo": ch.repo,
                "folder_id": ch.folder_id,
                "expiration": datetime.fromtimestamp(
                    ch.expiration_ms / 1000, tz=timezone.utc
                ).isoformat(),
                "remaining_seconds": remaining_seconds,
                "created_at": ch.created_at,
            })
        return {
            "enabled": self.is_enabled,
            "webhook_url": self._webhook_url or "(미설정 — 폴링 모드)",
            "active_channels": len(channels),
            "channels": channels,
        }


# ─── 편의 함수 ───────────────────────────────────────────────────

_drive_syncer: DriveGitHubSync | None = None
_watch_manager: DriveWatchManager | None = None


def get_drive_syncer() -> DriveGitHubSync:
    """DriveGitHubSync 싱글톤 반환."""
    global _drive_syncer
    if _drive_syncer is None:
        _drive_syncer = DriveGitHubSync()
    return _drive_syncer


def get_watch_manager() -> DriveWatchManager:
    """DriveWatchManager 싱글톤 반환."""
    global _watch_manager
    if _watch_manager is None:
        _watch_manager = DriveWatchManager(get_drive_syncer())
    return _watch_manager


def poll_all_drive_folders() -> list[DriveChangeResult]:
    """모든 Drive 폴더 폴링 진입점 (Watch API 미설정 시 사용)."""
    return get_drive_syncer().poll_all_folders()


if __name__ == "__main__":
    import sys
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )
    from dotenv import load_dotenv
    load_dotenv(BASE_DIR / ".env")

    syncer = DriveGitHubSync()
    mapped = syncer.get_all_mapped_folders()
    print(f"매핑된 저장소: {len(mapped)}개")
    for repo, folder_id, config in mapped:
        print(f"  {repo} → Drive:{folder_id[:20]}...")

    if "--watch-status" in sys.argv:
        wm = DriveWatchManager(syncer)
        status = wm.get_watch_status()
        print(f"\nWatch API 상태:")
        print(f"  활성화: {status['enabled']}")
        print(f"  Webhook URL: {status['webhook_url']}")
        print(f"  활성 채널: {status['active_channels']}개")
        for ch in status['channels']:
            print(f"    {ch['repo']}: 만료까지 {ch['remaining_seconds']}초")

    if "--poll" in sys.argv:
        print("\nDrive 폴링 시작...")
        results = syncer.poll_all_folders()
        for r in results:
            print(f"\n{r.repo}:")
            print(f"  동기화: {len(r.synced)}")
            print(f"  스킵: {len(r.skipped)}")
            print(f"  충돌: {len(r.conflicts)}")
            print(f"  실패: {len(r.failed)}")
