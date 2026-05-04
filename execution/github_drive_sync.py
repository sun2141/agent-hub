"""
GitHub → Google Drive 동기화 엔진

핵심 기능:
1. Delta sync: SHA 비교로 실제 변경 파일만 처리
2. 재시도 로직: 최대 3회, 지수 백오프
3. 저장소별 Drive 폴더 매핑 지원
4. 파일 추가/수정/삭제 모두 처리
5. OAuth2 토큰 자동 갱신
"""

import os
import io
import json
import time
import base64
import fnmatch
import logging
import requests
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

from googleapiclient.http import MediaIoBaseUpload
from googleapiclient.errors import HttpError

from drive_auth import get_drive_service
from sync_logger import get_sync_logger
from telegram_notifier import (
    notify_sync_success,
    notify_sync_failure,
    notify_auth_error,
    notify_rate_limit,
)

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent
MAPPING_FILE = BASE_DIR / "config" / "repo_drive_mapping.json"

# GitHub API
GITHUB_API = "https://api.github.com"
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")


@dataclass
class FileChange:
    """단일 파일 변경 정보."""
    path: str
    action: str  # "added", "modified", "removed"
    sha: str = ""
    content: Optional[bytes] = None  # 파일 내용 (다운로드 후 채워짐)


@dataclass
class SyncResult:
    """동기화 결과 집계."""
    repo: str
    commit_sha: str
    synced: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    failed: list[dict] = field(default_factory=list)

    @property
    def success(self) -> bool:
        return len(self.failed) == 0


class GitHubDriveSync:
    """GitHub 변경사항을 Google Drive에 동기화."""

    def __init__(self):
        self.sync_logger = get_sync_logger()
        self.mapping = self._load_mapping()
        self._drive_service = None  # 지연 초기화

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

    # ─── 매핑 설정 ────────────────────────────────────────────────

    def _load_mapping(self) -> dict:
        """repo_drive_mapping.json 로드."""
        if not MAPPING_FILE.exists():
            logger.warning(f"매핑 파일 없음: {MAPPING_FILE}")
            return {"repositories": {}, "defaults": {}}
        with open(MAPPING_FILE) as f:
            return json.load(f)

    def get_repo_config(self, repo: str) -> dict | None:
        """저장소 설정 반환. 없으면 None."""
        repos = self.mapping.get("repositories", {})
        config = repos.get(repo)
        if not config:
            return None

        # 환경 변수 치환 (${VAR_NAME} 형식)
        if config.get("drive_folder_id", "").startswith("${"):
            var_name = config["drive_folder_id"][2:-1]
            config = dict(config)
            config["drive_folder_id"] = os.getenv(var_name, "")

        return config

    def _should_sync_file(self, file_path: str, config: dict) -> bool:
        """파일이 동기화 대상인지 확인."""
        defaults = self.mapping.get("defaults", {})
        exclude_patterns = config.get("exclude_patterns", defaults.get("exclude_patterns", []))
        sync_paths = config.get("sync_paths", [])

        # 제외 패턴 확인
        for pattern in exclude_patterns:
            if fnmatch.fnmatch(file_path, pattern) or fnmatch.fnmatch(
                Path(file_path).name, pattern
            ):
                return False

        # sync_paths가 없으면 전체 동기화
        if not sync_paths:
            return True

        # sync_paths 중 하나로 시작하면 동기화
        return any(file_path.startswith(p) for p in sync_paths)

    # ─── 메인 동기화 ─────────────────────────────────────────────

    def process_push_event(self, payload: dict) -> SyncResult:
        """
        GitHub push webhook 처리.

        Args:
            payload: GitHub webhook payload dict

        Returns:
            SyncResult
        """
        repo = payload.get("repository", {}).get("full_name", "")
        branch = payload.get("ref", "").replace("refs/heads/", "")
        commit_sha = payload.get("after", "")
        pusher = payload.get("pusher", {}).get("name", "")
        commits = payload.get("commits", [])

        logger.info(f"Push 이벤트: {repo}@{branch} ({commit_sha[:7]})")

        # 저장소 매핑 확인
        config = self.get_repo_config(repo)
        if not config:
            logger.info(f"매핑 없음 — 스킵: {repo}")
            self.sync_logger.log_event(
                "push", repo,
                {"branch": branch, "sha": commit_sha, "reason": "no_mapping"},
                status="skipped"
            )
            return SyncResult(repo=repo, commit_sha=commit_sha)

        drive_folder_id = config.get("drive_folder_id", "")
        if not drive_folder_id:
            logger.warning(f"Drive 폴더 ID 미설정: {repo}")
            return SyncResult(repo=repo, commit_sha=commit_sha)

        # 변경 파일 수집 (모든 커밋)
        changes = self._collect_changes(commits, config)

        result = SyncResult(repo=repo, commit_sha=commit_sha)

        if not changes:
            logger.info("동기화할 파일 없음")
            self.sync_logger.log_event(
                "push", repo,
                {"branch": branch, "sha": commit_sha, "reason": "no_changes"},
                status="skipped"
            )
            return result

        logger.info(f"동기화 대상: {len(changes)}개 파일")

        # 파일 내용 다운로드 (removed 제외)
        self._fetch_file_contents(repo, commit_sha, changes)

        # Drive 업로드/삭제
        for change in changes:
            self._sync_file_with_retry(
                change=change,
                repo=repo,
                drive_folder_id=drive_folder_id,
                result=result,
            )

        # 결과 알림
        if result.synced:
            notify_sync_success(
                repo=repo,
                branch=branch,
                files_synced=result.synced,
                files_skipped=len(result.skipped),
                commit_sha=commit_sha,
                commit_message=commits[-1].get("message", "") if commits else "",
            )
        if result.failed:
            notify_sync_failure(
                repo=repo,
                branch=branch,
                failed_files=result.failed,
                commit_sha=commit_sha,
            )

        self.sync_logger.log_event(
            "push", repo,
            {
                "branch": branch,
                "sha": commit_sha,
                "synced": len(result.synced),
                "skipped": len(result.skipped),
                "failed": len(result.failed),
            },
            status="success" if result.success else "failure",
        )

        return result

    def _collect_changes(self, commits: list, config: dict) -> list[FileChange]:
        """
        커밋 목록에서 변경 파일 수집 (중복 제거, 최신 상태 우선).
        같은 파일이 여러 커밋에 있으면 마지막 상태만 처리.
        """
        file_changes: dict[str, FileChange] = {}

        for commit in commits:
            sha = commit.get("id", "")
            for action in ("added", "modified", "removed"):
                for file_path in commit.get(action, []):
                    if not self._should_sync_file(file_path, config):
                        logger.debug(f"제외: {file_path}")
                        continue
                    file_changes[file_path] = FileChange(
                        path=file_path,
                        action=action,
                        sha=sha,
                    )

        return list(file_changes.values())

    def _fetch_file_contents(self, repo: str, ref: str, changes: list[FileChange]):
        """GitHub Contents API로 파일 내용 병렬 다운로드."""
        headers = {"Accept": "application/vnd.github.v3+json"}
        if GITHUB_TOKEN:
            headers["Authorization"] = f"token {GITHUB_TOKEN}"

        for change in changes:
            if change.action == "removed":
                continue

            # SHA 비교 — 변경 없으면 스킵 (실제 SHA는 blob SHA가 아닌 commit SHA라
            # 정확하지 않을 수 있어 상태 비교는 파일 경로 기반으로도 처리)
            url = f"{GITHUB_API}/repos/{repo}/contents/{change.path}"
            try:
                resp = requests.get(url, headers=headers, params={"ref": ref}, timeout=30)
                resp.raise_for_status()
                data = resp.json()
                content_b64 = data.get("content", "").replace("\n", "")
                change.content = base64.b64decode(content_b64)
                change.sha = data.get("sha", change.sha)
                logger.debug(f"다운로드: {change.path} ({len(change.content)} bytes)")
            except Exception as e:
                logger.error(f"파일 다운로드 실패: {change.path} — {e}")
                change.content = None

    # ─── Drive 업로드 ─────────────────────────────────────────────

    def _sync_file_with_retry(
        self,
        change: FileChange,
        repo: str,
        drive_folder_id: str,
        result: SyncResult,
    ):
        """재시도 로직 포함 파일 동기화."""
        defaults = self.mapping.get("defaults", {})
        max_attempts = defaults.get("retry_attempts", 3)
        backoff = defaults.get("retry_backoff_seconds", [1, 2, 4])

        for attempt in range(max_attempts):
            try:
                if change.action == "removed":
                    self._delete_file(repo, change)
                else:
                    if change.content is None:
                        result.skipped.append(change.path)
                        return
                    # Delta sync: SHA 같으면 스킵
                    if not self.sync_logger.is_file_changed(repo, change.path, change.sha):
                        logger.info(f"변경 없음 — 스킵: {change.path}")
                        result.skipped.append(change.path)
                        return
                    self._upload_file(repo, change, drive_folder_id)

                result.synced.append(change.path)
                self.sync_logger.log_event(
                    "sync_file", repo,
                    {"file": change.path, "action": change.action},
                )
                return

            except HttpError as e:
                if e.resp.status == 429:
                    wait = backoff[min(attempt, len(backoff) - 1)]
                    notify_rate_limit("Google Drive", wait)
                    logger.warning(f"Rate limit — {wait}초 대기")
                    time.sleep(wait)
                elif attempt < max_attempts - 1:
                    wait = backoff[min(attempt, len(backoff) - 1)]
                    logger.warning(f"Drive 오류 ({attempt+1}/{max_attempts}): {e} — {wait}초 후 재시도")
                    time.sleep(wait)
                else:
                    error_msg = str(e)
                    logger.error(f"동기화 최종 실패: {change.path} — {error_msg}")
                    result.failed.append({"file": change.path, "error": error_msg})
                    self.sync_logger.log_event(
                        "sync_file", repo,
                        {"file": change.path, "action": change.action},
                        status="failure",
                        error=error_msg,
                    )

            except Exception as e:
                error_msg = str(e)
                logger.error(f"예상치 못한 오류: {change.path} — {error_msg}")
                result.failed.append({"file": change.path, "error": error_msg})
                self.sync_logger.log_event(
                    "sync_file", repo,
                    {"file": change.path, "action": change.action},
                    status="failure",
                    error=error_msg,
                )
                return

    def _upload_file(self, repo: str, change: FileChange, folder_id: str):
        """
        Drive에 파일 업로드 또는 업데이트.
        기존 Drive 파일 ID가 있으면 update, 없으면 create.
        """
        file_name = Path(change.path).name
        # 폴더 구조를 유지하려면 경로 기반 폴더 생성 필요
        # 현재는 단순히 파일명으로 루트 폴더에 업로드
        drive_folder = self._get_or_create_subfolder(folder_id, change.path)

        media = MediaIoBaseUpload(
            io.BytesIO(change.content),
            mimetype="application/octet-stream",
            resumable=False,
        )

        existing_id = self.sync_logger.get_drive_file_id(repo, change.path)

        if existing_id:
            # 기존 파일 업데이트
            updated = self.drive.files().update(
                fileId=existing_id,
                media_body=media,
                fields="id, name, modifiedTime",
            ).execute()
            logger.info(f"파일 업데이트: {change.path} (Drive ID: {existing_id})")
            drive_id = updated["id"]
        else:
            # 새 파일 생성
            metadata = {
                "name": file_name,
                "parents": [drive_folder],
            }
            created = self.drive.files().create(
                body=metadata,
                media_body=media,
                fields="id, name",
            ).execute()
            logger.info(f"파일 생성: {change.path} (Drive ID: {created['id']})")
            drive_id = created["id"]

        self.sync_logger.update_file_state(repo, change.path, change.sha, drive_id)

    def _delete_file(self, repo: str, change: FileChange):
        """Drive에서 파일 삭제."""
        drive_id = self.sync_logger.get_drive_file_id(repo, change.path)
        if not drive_id:
            logger.info(f"Drive ID 없음 — 삭제 스킵: {change.path}")
            return

        self.drive.files().delete(fileId=drive_id).execute()
        self.sync_logger.remove_file_state(repo, change.path)
        logger.info(f"파일 삭제: {change.path} (Drive ID: {drive_id})")

    def _get_or_create_subfolder(self, parent_folder_id: str, file_path: str) -> str:
        """
        파일 경로의 디렉토리 구조를 Drive에 재현.
        예: execution/sync_logger.py → Drive의 execution/ 폴더 ID 반환.
        폴더가 없으면 생성.
        """
        parts = Path(file_path).parent.parts
        if not parts or parts == (".",):
            return parent_folder_id

        current_parent = parent_folder_id
        for folder_name in parts:
            current_parent = self._find_or_create_folder(current_parent, folder_name)

        return current_parent

    def _find_or_create_folder(self, parent_id: str, folder_name: str) -> str:
        """Drive에서 폴더 찾거나 없으면 생성."""
        # 이미 존재하는지 검색
        query = (
            f"name='{folder_name}' and "
            f"'{parent_id}' in parents and "
            f"mimeType='application/vnd.google-apps.folder' and "
            f"trashed=false"
        )
        results = self.drive.files().list(
            q=query, fields="files(id, name)", pageSize=1
        ).execute()

        files = results.get("files", [])
        if files:
            return files[0]["id"]

        # 없으면 생성
        folder_metadata = {
            "name": folder_name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
        }
        folder = self.drive.files().create(
            body=folder_metadata, fields="id"
        ).execute()
        logger.info(f"Drive 폴더 생성: {folder_name} (ID: {folder['id']})")
        return folder["id"]


# ─── 편의 함수 ──────────────────────────────────────────────────

_syncer: GitHubDriveSync | None = None


def get_syncer() -> GitHubDriveSync:
    """GitHubDriveSync 싱글톤 반환."""
    global _syncer
    if _syncer is None:
        _syncer = GitHubDriveSync()
    return _syncer


def sync_push_event(payload: dict) -> SyncResult:
    """push 이벤트 동기화 진입점."""
    return get_syncer().process_push_event(payload)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from dotenv import load_dotenv
    load_dotenv()

    # 테스트용 더미 payload
    test_payload = {
        "repository": {"full_name": "sun2141/grace-ai"},
        "ref": "refs/heads/main",
        "after": "abc123def456",
        "pusher": {"name": "sun2141"},
        "commits": [
            {
                "id": "abc123def456",
                "message": "test: sync test",
                "added": ["execution/test_sync.py"],
                "modified": [],
                "removed": [],
            }
        ],
    }

    syncer = GitHubDriveSync()
    config = syncer.get_repo_config("sun2141/grace-ai")
    print("저장소 설정:", config)
    print("매핑 로드 성공")
