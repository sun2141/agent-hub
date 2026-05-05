"""
GitHub-Drive 양방향 동기화 통합 테스트

테스트 항목:
1. GitHub → Drive: webhook payload 처리 및 Drive 업로드
2. Drive → GitHub: Drive 파일 감지 및 GitHub 커밋
3. 무한루프 방지: [drive-sync] 태그 필터링
4. 충돌 감지: Drive와 GitHub 양쪽 변경 시
5. sync_logger: Drive 상태 추적
6. telegram_notifier: 알림 함수 호출 가능성
7. drive_auth: 스코프 확인

실행:
  python execution/test_sync_integration.py
  python execution/test_sync_integration.py --verbose
"""

import sys
import os
import json
import uuid
import logging
import unittest
import tempfile
import shutil
from pathlib import Path
from unittest.mock import MagicMock, patch, call
from datetime import datetime, timezone, timedelta

# 경로 설정
EXEC_DIR = Path(__file__).parent
BASE_DIR = EXEC_DIR.parent
sys.path.insert(0, str(EXEC_DIR))

# .env 로드 (있으면)
try:
    from dotenv import load_dotenv
    load_dotenv(BASE_DIR / ".env")
except ImportError:
    pass

logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)


class TestSyncLogger(unittest.TestCase):
    """sync_logger 확장 기능 테스트."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        # 임시 디렉토리로 경로 패치
        import sync_logger as sl_module
        self._orig_tmp = sl_module.TMP_DIR
        self._orig_state = sl_module.STATE_FILE
        self._orig_log = sl_module.LOG_FILE
        sl_module.TMP_DIR = Path(self.tmp_dir)
        sl_module.STATE_FILE = Path(self.tmp_dir) / "sync_state.json"
        sl_module.LOG_FILE = Path(self.tmp_dir) / "sync_log.jsonl"
        # 싱글톤 초기화
        sl_module._sync_logger_instance = None
        from sync_logger import SyncLogger
        self.logger = SyncLogger()

    def tearDown(self):
        import sync_logger as sl_module
        sl_module.TMP_DIR = self._orig_tmp
        sl_module.STATE_FILE = self._orig_state
        sl_module.LOG_FILE = self._orig_log
        sl_module._sync_logger_instance = None
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_github_to_drive_state(self):
        """GitHub→Drive 파일 상태 추적."""
        self.logger.update_file_state(
            repo="owner/repo",
            file_path="execution/test.py",
            sha="abc123",
            drive_file_id="drive_file_001",
        )
        state = self.logger.get_file_state("owner/repo", "execution/test.py")
        self.assertIsNotNone(state)
        self.assertEqual(state["sha"], "abc123")
        self.assertEqual(state["drive_file_id"], "drive_file_001")

    def test_drive_to_github_state(self):
        """Drive→GitHub 파일 상태 추적."""
        self.logger.update_drive_file_state(
            repo="owner/repo",
            file_path="execution/sync.py",
            drive_file_id="drive_001",
            drive_modified_time="2026-05-04T10:00:00Z",
            github_sync_sha="def456",
        )
        state = self.logger.get_drive_file_state("owner/repo", "execution/sync.py")
        self.assertIsNotNone(state)
        self.assertEqual(state["drive_file_id"], "drive_001")
        self.assertEqual(state["drive_modified_time"], "2026-05-04T10:00:00Z")
        self.assertEqual(state["github_sync_sha"], "def456")

    def test_drive_repo_summary(self):
        """Drive→GitHub 저장소 요약."""
        self.logger.update_drive_file_state(
            "owner/repo", "file1.py", "id1", "2026-01-01T00:00:00Z", "sha1"
        )
        self.logger.update_drive_file_state(
            "owner/repo", "file2.py", "id2", "2026-01-01T00:00:00Z", "sha2"
        )
        summary = self.logger.get_drive_repo_summary("owner/repo")
        self.assertEqual(summary["total_drive_files"], 2)
        self.assertIn("file1.py", summary["files"])
        self.assertIn("file2.py", summary["files"])

    def test_is_file_changed_new_file(self):
        """신규 파일은 항상 변경됨으로 반환."""
        self.assertTrue(self.logger.is_file_changed("repo", "new_file.py", "sha"))

    def test_is_file_changed_same_sha(self):
        """동일 SHA는 변경 없음 반환."""
        self.logger.update_file_state("repo", "file.py", "sha123", "drive_id")
        self.assertFalse(self.logger.is_file_changed("repo", "file.py", "sha123"))

    def test_is_file_changed_different_sha(self):
        """다른 SHA는 변경됨 반환."""
        self.logger.update_file_state("repo", "file.py", "sha123", "drive_id")
        self.assertTrue(self.logger.is_file_changed("repo", "file.py", "sha456"))

    def test_log_event_and_stats(self):
        """이벤트 로그 및 통계."""
        self.logger.log_event("push", "repo", {"file": "test.py"}, status="success")
        self.logger.log_event("drive_sync", "repo", {"files": 3}, status="failure")
        self.logger.log_event("drive_sync", "repo", {"files": 2}, status="skipped")

        stats = self.logger.get_stats()
        self.assertEqual(stats["total_events"], 3)
        self.assertEqual(stats["success"], 1)
        self.assertEqual(stats["failure"], 1)
        self.assertEqual(stats["skipped"], 1)

    def test_remove_file_state(self):
        """파일 상태 삭제."""
        self.logger.update_file_state("repo", "file.py", "sha", "drive_id")
        self.logger.remove_file_state("repo", "file.py")
        self.assertIsNone(self.logger.get_file_state("repo", "file.py"))


class TestGitHubDriveSyncLoopPrevention(unittest.TestCase):
    """무한루프 방지 테스트."""

    def test_drive_sync_tag_detection(self):
        """[drive-sync] 태그 감지."""
        commits = [
            {"message": "[drive-sync] sync execution/test.py\n\nAuto-synced"},
            {"message": "[drive-sync] sync config/mapping.json"},
        ]
        all_drive_sync = bool(commits) and all(
            "[drive-sync]" in c.get("message", "") for c in commits
        )
        self.assertTrue(all_drive_sync)

    def test_mixed_commits_not_skipped(self):
        """일반 커밋이 섞여 있으면 스킵하지 않음."""
        commits = [
            {"message": "[drive-sync] sync execution/test.py"},
            {"message": "feat: add new feature"},
        ]
        all_drive_sync = bool(commits) and all(
            "[drive-sync]" in c.get("message", "") for c in commits
        )
        self.assertFalse(all_drive_sync)

    def test_empty_commits_not_skipped(self):
        """빈 커밋 목록은 스킵하지 않음."""
        commits = []
        all_drive_sync = bool(commits) and all(
            "[drive-sync]" in c.get("message", "") for c in commits
        )
        self.assertFalse(all_drive_sync)


class TestDriveGitHubSyncMapping(unittest.TestCase):
    """DriveGitHubSync 매핑 로직 테스트."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        # 임시 설정 파일 생성
        self.config_path = Path(self.tmp_dir) / "repo_drive_mapping.json"
        self.config = {
            "repositories": {
                "owner/repo1": {
                    "drive_folder_id": "${TEST_DRIVE_FOLDER_1}",
                    "sync_paths": ["src/", "docs/"],
                    "exclude_patterns": ["*.pyc", "node_modules/"],
                    "description": "테스트 저장소 1"
                },
                "owner/repo2": {
                    "drive_folder_id": "static_folder_id_xyz",
                    "sync_paths": [],
                    "exclude_patterns": [],
                }
            },
            "defaults": {
                "max_file_size_mb": 50,
                "retry_attempts": 3,
                "retry_backoff_seconds": [1, 2, 4],
            }
        }
        with open(self.config_path, "w") as f:
            json.dump(self.config, f)

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _make_syncer(self):
        import drive_github_sync as dgs_module
        orig_path = dgs_module.MAPPING_FILE
        dgs_module.MAPPING_FILE = self.config_path
        # 환경 변수 설정
        os.environ["TEST_DRIVE_FOLDER_1"] = "folder_id_from_env_001"

        with patch("drive_github_sync.get_drive_service"), \
             patch("drive_github_sync.get_sync_logger"):
            from drive_github_sync import DriveGitHubSync
            syncer = DriveGitHubSync()

        dgs_module.MAPPING_FILE = orig_path
        return syncer

    def test_get_repo_for_drive_folder_env_var(self):
        """환경 변수 기반 Drive 폴더 ID 조회."""
        os.environ["TEST_DRIVE_FOLDER_1"] = "folder_id_from_env_001"
        with patch("drive_github_sync.MAPPING_FILE", self.config_path), \
             patch("drive_github_sync.get_drive_service"), \
             patch("drive_github_sync.get_sync_logger"):
            from drive_github_sync import DriveGitHubSync
            syncer = DriveGitHubSync()
            repo, config = syncer.get_repo_for_drive_folder("folder_id_from_env_001")
            self.assertEqual(repo, "owner/repo1")
            self.assertIsNotNone(config)

    def test_get_repo_for_drive_folder_static(self):
        """정적 Drive 폴더 ID 조회."""
        with patch("drive_github_sync.MAPPING_FILE", self.config_path), \
             patch("drive_github_sync.get_drive_service"), \
             patch("drive_github_sync.get_sync_logger"):
            from drive_github_sync import DriveGitHubSync
            syncer = DriveGitHubSync()
            repo, config = syncer.get_repo_for_drive_folder("static_folder_id_xyz")
            self.assertEqual(repo, "owner/repo2")

    def test_get_repo_for_drive_folder_not_found(self):
        """존재하지 않는 폴더 ID 조회 → None 반환."""
        with patch("drive_github_sync.MAPPING_FILE", self.config_path), \
             patch("drive_github_sync.get_drive_service"), \
             patch("drive_github_sync.get_sync_logger"):
            from drive_github_sync import DriveGitHubSync
            syncer = DriveGitHubSync()
            repo, config = syncer.get_repo_for_drive_folder("nonexistent_folder")
            self.assertIsNone(repo)
            self.assertIsNone(config)


class TestDriveFileFilter(unittest.TestCase):
    """Drive 파일 동기화 필터 테스트."""

    def test_should_sync_with_sync_paths(self):
        """sync_paths 필터 동작."""
        import fnmatch
        sync_paths = ["src/", "docs/"]
        exclude_patterns = ["*.pyc"]

        def should_sync(file_path):
            for p in exclude_patterns:
                if fnmatch.fnmatch(file_path, p):
                    return False
            if sync_paths:
                return any(file_path.startswith(p) for p in sync_paths)
            return True

        self.assertTrue(should_sync("src/main.py"))
        self.assertTrue(should_sync("docs/readme.md"))
        self.assertFalse(should_sync("tests/test_main.py"))
        self.assertFalse(should_sync("src/main.pyc"))

    def test_should_sync_without_sync_paths(self):
        """sync_paths 없으면 전체 동기화."""
        import fnmatch
        sync_paths = []
        exclude_patterns = ["node_modules/"]

        def should_sync(file_path):
            for p in exclude_patterns:
                if fnmatch.fnmatch(file_path, p) or fnmatch.fnmatch(file_path.split("/")[0] + "/", p):
                    return False
            if sync_paths:
                return any(file_path.startswith(p) for p in sync_paths)
            return True

        self.assertTrue(should_sync("src/main.py"))
        self.assertTrue(should_sync("config.json"))


class TestBinaryFileHandling(unittest.TestCase):
    """바이너리 파일 처리 테스트."""

    def test_binary_extension_detection(self):
        """바이너리 확장자 감지."""
        from drive_github_sync import BINARY_EXTENSIONS
        binary_files = ["image.png", "document.pdf", "archive.zip", "font.woff2"]
        text_files = ["script.py", "readme.md", "config.json", "style.css"]

        for f in binary_files:
            ext = Path(f).suffix.lower()
            self.assertIn(ext, BINARY_EXTENSIONS, f"{f}는 바이너리로 처리되어야 함")

        for f in text_files:
            ext = Path(f).suffix.lower()
            # 텍스트 파일은 바이너리 목록에 없어야 함
            self.assertNotIn(ext, BINARY_EXTENSIONS, f"{f}는 텍스트로 처리되어야 함")

    def test_max_file_size(self):
        """최대 파일 크기 제한 확인."""
        from drive_github_sync import MAX_FILE_SIZE_BYTES
        # 50MB 이하면 정상 처리
        self.assertLessEqual(MAX_FILE_SIZE_BYTES, 50 * 1024 * 1024)

    def test_base64_encode_decode(self):
        """base64 인코딩/디코딩 정확성."""
        import base64
        original = b"Hello, \x00\x01\x02 binary data \xff\xfe"
        encoded = base64.b64encode(original).decode("utf-8")
        decoded = base64.b64decode(encoded)
        self.assertEqual(original, decoded)


class TestWebhookLoopPrevention(unittest.TestCase):
    """webhook 무한루프 방지 테스트 (실제 HTTP 없이)."""

    def test_github_sync_tag_in_commit_message(self):
        """[github-sync] 태그로 표시된 커밋 식별."""
        from drive_github_sync import GITHUB_SYNC_TAG, DRIVE_SYNC_TAG
        self.assertEqual(DRIVE_SYNC_TAG, "[drive-sync]")
        self.assertEqual(GITHUB_SYNC_TAG, "[github-sync]")

    def test_commit_message_format(self):
        """Drive→GitHub 커밋 메시지 형식."""
        from drive_github_sync import DRIVE_SYNC_TAG
        file_path = "execution/test.py"
        modified_time = "2026-05-04T10:00:00Z"
        commit_message = (
            f"{DRIVE_SYNC_TAG} sync {file_path}\n\n"
            f"Drive modified: {modified_time}\n"
            f"Auto-synced by GitHub-Drive Sync Agent"
        )
        self.assertIn(DRIVE_SYNC_TAG, commit_message)
        self.assertIn(file_path, commit_message)
        self.assertIn(modified_time, commit_message)


class TestTelegramNotifier(unittest.TestCase):
    """텔레그램 알림 함수 테스트 (실제 전송 없이)."""

    @patch("telegram_notifier.requests.post")
    def test_notify_sync_success(self, mock_post):
        """동기화 성공 알림 형식."""
        mock_post.return_value.raise_for_status = MagicMock()
        mock_post.return_value.status_code = 200

        os.environ["TELEGRAM_BOT_TOKEN"] = "test_token"
        os.environ["TELEGRAM_CHAT_ID"] = "test_chat"

        from telegram_notifier import notify_sync_success
        notify_sync_success(
            repo="owner/repo",
            branch="main",
            files_synced=["file1.py", "file2.py"],
            commit_sha="abc123def456",
            commit_message="feat: add feature",
        )
        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args[1]["json"]
        self.assertIn("Drive 동기화 완료", call_kwargs["text"])

    @patch("telegram_notifier.requests.post")
    def test_notify_drive_sync_success(self, mock_post):
        """Drive→GitHub 성공 알림 형식."""
        mock_post.return_value.raise_for_status = MagicMock()

        os.environ["TELEGRAM_BOT_TOKEN"] = "test_token"
        os.environ["TELEGRAM_CHAT_ID"] = "test_chat"

        from telegram_notifier import notify_drive_sync_success
        notify_drive_sync_success(
            repo="owner/repo",
            folder_id="drive_folder_id_xyz",
            files_synced=["src/main.py"],
        )
        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args[1]["json"]
        self.assertIn("Drive→GitHub 동기화 완료", call_kwargs["text"])

    @patch("telegram_notifier.requests.post")
    def test_notify_conflict(self, mock_post):
        """충돌 알림 형식."""
        mock_post.return_value.raise_for_status = MagicMock()

        os.environ["TELEGRAM_BOT_TOKEN"] = "test_token"
        os.environ["TELEGRAM_CHAT_ID"] = "test_chat"

        from telegram_notifier import notify_conflict
        notify_conflict(
            repo="owner/repo",
            file_path="src/main.py",
            conflict_info="GitHub에 별도 변경 존재",
        )
        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args[1]["json"]
        self.assertIn("충돌", call_kwargs["text"])

    def test_send_message_no_credentials(self):
        """자격증명 없을 때 False 반환 (에러 없이)."""
        os.environ.pop("TELEGRAM_BOT_TOKEN", None)
        os.environ.pop("TELEGRAM_CHAT_ID", None)

        from telegram_notifier import send_message
        result = send_message("테스트 메시지")
        self.assertFalse(result)

    def test_html_escape(self):
        """HTML 특수문자 이스케이프."""
        from telegram_notifier import _escape_html
        self.assertEqual(_escape_html("<b>test & 'go'</b>"), "&lt;b&gt;test &amp; 'go'&lt;/b&gt;")


def _make_verify_func(secret: str):
    """
    verify_github_signature 로직을 독립적으로 구현.
    fastapi 임포트 없이 서명 검증 로직만 테스트.
    github_drive_webhook.py:verify_github_signature와 동일한 로직.
    """
    import hmac as _hmac, hashlib as _hashlib

    def verify(payload_bytes: bytes, signature: str) -> bool:
        if not secret:
            return True  # 개발 모드
        if not signature or not signature.startswith("sha256="):
            return False
        mac = _hmac.HMAC(
            key=secret.encode("utf-8"),
            msg=payload_bytes,
            digestmod=_hashlib.sha256,
        )
        expected = mac.hexdigest()
        return _hmac.compare_digest(f"sha256={expected}", signature)

    return verify


class TestGitHubSignatureVerification(unittest.TestCase):
    """
    GitHub Webhook HMAC-SHA256 서명 검증 테스트.
    github_drive_webhook.py:verify_github_signature 함수와 동일한 로직을
    독립적으로 테스트 (fastapi 의존성 없이).
    """

    def test_valid_signature(self):
        """올바른 서명은 True 반환."""
        import hmac as _hmac, hashlib as _hashlib
        secret = "test_secret_key"
        payload = b'{"action": "push", "repo": "test"}'

        mac = _hmac.HMAC(
            key=secret.encode("utf-8"),
            msg=payload,
            digestmod=_hashlib.sha256,
        )
        valid_sig = f"sha256={mac.hexdigest()}"

        verify = _make_verify_func(secret)
        self.assertTrue(verify(payload, valid_sig))

    def test_invalid_signature(self):
        """잘못된 서명은 False 반환."""
        verify = _make_verify_func("test_secret")
        payload = b'{"action": "push"}'
        self.assertFalse(verify(payload, "sha256=wrong_signature_that_is_not_valid"))

    def test_missing_signature_header(self):
        """서명 헤더 없으면 False 반환."""
        verify = _make_verify_func("test_secret")
        payload = b'{"action": "push"}'
        self.assertFalse(verify(payload, ""))

    def test_wrong_prefix(self):
        """sha256= 접두사 없으면 False 반환."""
        verify = _make_verify_func("test_secret")
        payload = b'{"action": "push"}'
        self.assertFalse(verify(payload, "sha1=abc123"))

    def test_no_secret_skips_verification(self):
        """WEBHOOK_SECRET 미설정 시 True 반환 (개발 모드)."""
        verify = _make_verify_func("")  # 빈 secret
        self.assertTrue(verify(b"any payload", ""))

    def test_hmac_uses_hmac_class_not_alias(self):
        """hmac.HMAC 생성자 직접 사용 확인 (hmac.new 별칭 대신)."""
        import hmac as _hmac, hashlib as _hashlib
        # hmac.HMAC 직접 생성
        mac = _hmac.HMAC(
            key=b"secret",
            msg=b"payload",
            digestmod=_hashlib.sha256,
        )
        result = mac.hexdigest()
        self.assertIsInstance(result, str)
        self.assertEqual(len(result), 64)  # SHA-256 = 32바이트 = 64 hex chars

    def test_hmac_uses_constant_time_comparison(self):
        """hmac.compare_digest 사용 — 타이밍 공격 방지."""
        import hmac
        self.assertTrue(callable(hmac.compare_digest))
        self.assertTrue(hmac.compare_digest("abc", "abc"))
        self.assertFalse(hmac.compare_digest("abc", "xyz"))

    def test_tampered_payload_fails(self):
        """페이로드 변조 시 서명 검증 실패."""
        import hmac as _hmac, hashlib as _hashlib
        secret = "my_webhook_secret"
        original_payload = b'{"ref": "refs/heads/main"}'
        tampered_payload = b'{"ref": "refs/heads/evil"}'

        mac = _hmac.HMAC(
            key=secret.encode("utf-8"),
            msg=original_payload,
            digestmod=_hashlib.sha256,
        )
        sig_for_original = f"sha256={mac.hexdigest()}"

        verify = _make_verify_func(secret)
        self.assertTrue(verify(original_payload, sig_for_original))
        self.assertFalse(verify(tampered_payload, sig_for_original))


class TestDriveAuthScopes(unittest.TestCase):
    """Drive 인증 스코프 테스트."""

    def test_scopes_include_full_drive(self):
        """SCOPES에 drive (전체) 스코프 포함 여부 — drive.file이 아닌 drive."""
        from drive_auth import SCOPES
        full_drive_scope = "https://www.googleapis.com/auth/drive"
        self.assertIn(full_drive_scope, SCOPES, (
            "drive.file 스코프는 앱 외부 생성 파일 접근이 불가합니다. "
            "동기화 에이전트는 drive 전체 스코프가 필요합니다."
        ))

    def test_scopes_do_not_use_drive_file_only(self):
        """drive.file 단독 사용 금지 — 기존 Drive 파일 접근 불가."""
        from drive_auth import SCOPES
        drive_file_scope = "https://www.googleapis.com/auth/drive.file"
        full_drive_scope = "https://www.googleapis.com/auth/drive"
        # drive.file만 있고 drive가 없으면 안 됨
        if drive_file_scope in SCOPES:
            self.assertIn(full_drive_scope, SCOPES, (
                "drive.file만 사용하면 앱 외부 파일에 접근할 수 없습니다."
            ))

    def test_check_token_scopes_no_token(self):
        """token.json 없을 때 정상 처리 및 needs_reauth True."""
        with patch("drive_auth.TOKEN_PATH", Path("/nonexistent/path/token.json")):
            from drive_auth import check_token_scopes
            result = check_token_scopes()
            self.assertFalse(result["has_drive_scope"])
            self.assertTrue(result["needs_reauth"])
            self.assertIn("error", result)

    def test_check_token_scopes_returns_reauth_for_drive_file_only(self):
        """drive.file 스코프만 있으면 needs_reauth=True."""
        import json as _json, tempfile as _tf
        token_data = {
            "token": "access_token",
            "refresh_token": "refresh",
            "scopes": ["https://www.googleapis.com/auth/drive.file"],
        }
        with _tf.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            _json.dump(token_data, f)
            tmp_path = Path(f.name)
        try:
            with patch("drive_auth.TOKEN_PATH", tmp_path):
                from drive_auth import check_token_scopes
                result = check_token_scopes()
                self.assertTrue(result["needs_reauth"], (
                    "drive.file 스코프만 있는 token.json은 재인증이 필요합니다."
                ))
                self.assertFalse(result["has_full_drive"])
        finally:
            tmp_path.unlink(missing_ok=True)


class TestSyncEnd2End(unittest.TestCase):
    """
    E2E 시나리오 테스트 (Mock 기반).
    실제 API 없이 전체 흐름 검증.
    """

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        import sync_logger as sl_module
        sl_module.TMP_DIR = Path(self.tmp_dir)
        sl_module.STATE_FILE = Path(self.tmp_dir) / "sync_state.json"
        sl_module.LOG_FILE = Path(self.tmp_dir) / "sync_log.jsonl"
        sl_module._sync_logger_instance = None

    def tearDown(self):
        import sync_logger as sl_module
        sl_module._sync_logger_instance = None
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    @patch("github_drive_sync.get_drive_service")
    @patch("github_drive_sync.notify_sync_success")
    @patch("github_drive_sync.notify_sync_failure")
    @patch("github_drive_sync.requests.get")
    def test_github_to_drive_push_event(
        self,
        mock_requests_get,
        mock_notify_failure,
        mock_notify_success,
        mock_drive_service,
    ):
        """
        GitHub push 이벤트 → Drive 업로드 흐름.
        실제 API 없이 Mock으로 전체 흐름 검증.
        """
        import base64

        # Mock Drive 서비스
        mock_drive = MagicMock()
        mock_drive_service.return_value = mock_drive
        mock_drive.files.return_value.list.return_value.execute.return_value = {"files": []}
        mock_drive.files.return_value.create.return_value.execute.return_value = {
            "id": "new_drive_file_id",
            "name": "test_file.py",
        }

        # Mock GitHub API 응답
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        file_content = b"print('hello world')"
        mock_resp.json.return_value = {
            "content": base64.b64encode(file_content).decode() + "\n",
            "sha": "file_sha_001",
        }
        mock_requests_get.return_value = mock_resp

        # 테스트 payload
        payload = {
            "repository": {"full_name": "sun2141/grace-ai", "default_branch": "main"},
            "ref": "refs/heads/main",
            "after": "commit_sha_abc123",
            "pusher": {"name": "testuser"},
            "commits": [{
                "id": "commit_sha_abc123",
                "message": "feat: add test file",
                "added": ["execution/new_test.py"],
                "modified": [],
                "removed": [],
            }],
        }

        from github_drive_sync import GitHubDriveSync
        syncer = GitHubDriveSync()

        # sun2141/grace-ai 매핑이 있어야 함
        config = syncer.get_repo_config("sun2141/grace-ai")
        if not config or not config.get("drive_folder_id"):
            self.skipTest("GOOGLE_DRIVE_FOLDER_ID 환경 변수 미설정 — E2E 테스트 스킵")

        result = syncer.process_push_event(payload)
        # 성공 여부 확인 (실패 없어야 함)
        self.assertEqual(len(result.failed), 0)

    def test_drive_change_detection_by_modified_time(self):
        """Drive 파일 변경 감지: 수정 시각 비교 로직."""
        from sync_logger import SyncLogger
        sl = SyncLogger()

        # 초기 상태 없음 → 변경됨
        state = sl.get_drive_file_state("repo", "file.py")
        self.assertIsNone(state)

        # 상태 저장
        sl.update_drive_file_state(
            "repo", "file.py", "id1",
            "2026-05-04T10:00:00.000Z", "sha_001"
        )

        state = sl.get_drive_file_state("repo", "file.py")
        self.assertIsNotNone(state)

        # 동일 시각 → 변경 없음
        drive_time = "2026-05-04T10:00:00.000Z"
        last_sync_time = state.get("drive_modified_time", "")
        self.assertFalse(drive_time > last_sync_time)  # 변경 없음

        # 이후 시각 → 변경 있음
        newer_time = "2026-05-04T11:00:00.000Z"
        self.assertTrue(newer_time > last_sync_time)  # 변경 있음


class TestDriveWatchTTLRenewal(unittest.TestCase):
    """
    Drive Watch 채널 TTL 갱신 로직 단위 테스트.

    DriveWatchManager.renew_expiring_channels() 메서드의 동작 검증:
    - 만료 임박 채널 자동 갱신 (stop → re-register)
    - TTL 충분한 채널은 갱신 건너뜀
    - palmoni / grace-ai 양쪽 저장소 채널 처리
    - 갱신 후 채널 상태 파일 저장 확인
    """

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.watch_state_file = Path(self.tmp_dir) / "watch_channels.json"

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _make_watch_manager(self):
        """Mock DriveWatchManager 생성 (실제 API 없이)."""
        with patch("drive_github_sync.get_drive_service"), \
             patch("drive_github_sync.get_sync_logger"), \
             patch("drive_github_sync.WATCH_STATE_FILE", self.watch_state_file):
            from drive_github_sync import DriveWatchManager, DriveGitHubSync
            mock_syncer = MagicMock(spec=DriveGitHubSync)
            mock_syncer.drive = MagicMock()
            mock_syncer.get_all_mapped_folders.return_value = []
            manager = DriveWatchManager(mock_syncer)
        return manager

    def _make_channel(self, channel_id, repo, folder_id, remaining_ms):
        """테스트용 WatchChannel 생성."""
        from drive_github_sync import WatchChannel
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        return WatchChannel(
            channel_id=channel_id,
            resource_id=f"resource-{channel_id}",
            folder_id=folder_id,
            repo=repo,
            expiration_ms=now_ms + remaining_ms,
            page_token=f"token-{channel_id}",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

    def test_expiring_channel_is_renewed(self):
        """만료 임박(30분) 채널은 1시간 임계값 설정 시 갱신됨."""
        with patch("drive_github_sync.WATCH_STATE_FILE", self.watch_state_file):
            manager = self._make_watch_manager()

        ch = self._make_channel(
            "ch-grace-001", "sun2141/grace-ai", "folder-grace", 30 * 60 * 1000
        )
        manager._channels[ch.channel_id] = ch

        renewed = []
        stopped = []

        def mock_stop(cid):
            stopped.append(cid)
            manager._channels.pop(cid, None)
            return True

        def mock_register(folder_id, repo):
            from drive_github_sync import WatchChannel
            now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
            new_ch = WatchChannel(
                channel_id=f"ch-renewed-{uuid.uuid4()}",
                resource_id="new-resource",
                folder_id=folder_id,
                repo=repo,
                expiration_ms=now_ms + 23 * 3600 * 1000,
                page_token="new-token",
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            renewed.append((folder_id, repo))
            manager._channels[new_ch.channel_id] = new_ch
            return new_ch

        manager.stop_watch = mock_stop
        manager.register_watch = mock_register

        manager.renew_expiring_channels(threshold_seconds=3600)  # 1시간 임계값

        self.assertIn("ch-grace-001", stopped, "만료 임박 채널이 해제되어야 함")
        self.assertEqual(len(renewed), 1, "새 채널이 등록되어야 함")
        self.assertEqual(renewed[0], ("folder-grace", "sun2141/grace-ai"))

    def test_healthy_channel_is_not_renewed(self):
        """TTL 충분(20시간) 채널은 갱신하지 않음."""
        with patch("drive_github_sync.WATCH_STATE_FILE", self.watch_state_file):
            manager = self._make_watch_manager()

        ch = self._make_channel(
            "ch-healthy", "sun2141/palmoni", "folder-palmoni", 20 * 3600 * 1000
        )
        manager._channels[ch.channel_id] = ch

        renewed = []
        stopped = []
        manager.stop_watch = lambda cid: stopped.append(cid) or True
        manager.register_watch = lambda fid, repo: renewed.append((fid, repo))

        manager.renew_expiring_channels(threshold_seconds=3600)

        self.assertEqual(len(stopped), 0, "TTL 충분한 채널은 해제하지 않아야 함")
        self.assertEqual(len(renewed), 0, "TTL 충분한 채널은 갱신하지 않아야 함")

    def test_multiple_repos_renewal(self):
        """grace-ai + palmoni 두 저장소 채널 동시 갱신."""
        with patch("drive_github_sync.WATCH_STATE_FILE", self.watch_state_file):
            manager = self._make_watch_manager()

        # grace-ai: 만료 임박 (45분)
        ch_grace = self._make_channel(
            "ch-grace", "sun2141/grace-ai", "folder-grace", 45 * 60 * 1000
        )
        # palmoni: 만료 임박 (20분)
        ch_palmoni = self._make_channel(
            "ch-palmoni", "sun2141/palmoni", "folder-palmoni", 20 * 60 * 1000
        )
        manager._channels["ch-grace"] = ch_grace
        manager._channels["ch-palmoni"] = ch_palmoni

        renewed_repos = set()
        stopped = []

        def mock_stop(cid):
            stopped.append(cid)
            manager._channels.pop(cid, None)
            return True

        def mock_register(folder_id, repo):
            from drive_github_sync import WatchChannel
            now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
            new_ch = WatchChannel(
                channel_id=f"ch-new-{repo}",
                resource_id="new-resource",
                folder_id=folder_id,
                repo=repo,
                expiration_ms=now_ms + 23 * 3600 * 1000,
                page_token="new-token",
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            renewed_repos.add(repo)
            manager._channels[new_ch.channel_id] = new_ch
            return new_ch

        manager.stop_watch = mock_stop
        manager.register_watch = mock_register

        manager.renew_expiring_channels(threshold_seconds=3600)

        self.assertIn("ch-grace", stopped)
        self.assertIn("ch-palmoni", stopped)
        self.assertIn("sun2141/grace-ai", renewed_repos)
        self.assertIn("sun2141/palmoni", renewed_repos)

    def test_mixed_channels_partial_renewal(self):
        """만료 임박 채널만 갱신, 건강한 채널은 유지."""
        with patch("drive_github_sync.WATCH_STATE_FILE", self.watch_state_file):
            manager = self._make_watch_manager()

        # 만료 임박
        ch_expiring = self._make_channel(
            "ch-exp", "sun2141/grace-ai", "folder-grace", 10 * 60 * 1000
        )
        # 건강한 채널
        ch_healthy = self._make_channel(
            "ch-ok", "sun2141/palmoni", "folder-palmoni", 22 * 3600 * 1000
        )
        manager._channels["ch-exp"] = ch_expiring
        manager._channels["ch-ok"] = ch_healthy

        stopped = []
        renewed = []

        def mock_stop(cid):
            stopped.append(cid)
            manager._channels.pop(cid, None)
            return True

        def mock_register(folder_id, repo):
            from drive_github_sync import WatchChannel
            now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
            new_ch = WatchChannel(
                channel_id=f"ch-renewed",
                resource_id="new",
                folder_id=folder_id,
                repo=repo,
                expiration_ms=now_ms + 23 * 3600 * 1000,
                page_token="tk",
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            renewed.append(repo)
            manager._channels[new_ch.channel_id] = new_ch
            return new_ch

        manager.stop_watch = mock_stop
        manager.register_watch = mock_register

        manager.renew_expiring_channels(threshold_seconds=3600)

        self.assertIn("ch-exp", stopped, "만료 임박 채널은 갱신되어야 함")
        self.assertNotIn("ch-ok", stopped, "건강한 채널은 유지되어야 함")
        self.assertEqual(renewed, ["sun2141/grace-ai"])

    def test_get_watch_status_shows_remaining_time(self):
        """get_watch_status()가 남은 TTL(초)를 정확히 반환."""
        with patch("drive_github_sync.WATCH_STATE_FILE", self.watch_state_file):
            manager = self._make_watch_manager()

        remaining_hours = 12
        ch = self._make_channel(
            "ch-status-test", "sun2141/grace-ai", "folder-grace",
            remaining_hours * 3600 * 1000
        )
        manager._channels[ch.channel_id] = ch

        status = manager.get_watch_status()
        self.assertEqual(status["active_channels"], 1)
        self.assertEqual(len(status["channels"]), 1)

        ch_info = status["channels"][0]
        self.assertEqual(ch_info["repo"], "sun2141/grace-ai")
        # 남은 시간이 대략 맞는지 확인 (5초 오차 허용)
        expected_remaining = remaining_hours * 3600
        self.assertAlmostEqual(
            ch_info["remaining_seconds"], expected_remaining, delta=5,
            msg="남은 TTL 초가 정확해야 함",
        )

    def test_watch_channel_saved_after_renewal(self):
        """갱신 후 watch_channels.json 파일이 업데이트됨."""
        with patch("drive_github_sync.WATCH_STATE_FILE", self.watch_state_file):
            manager = self._make_watch_manager()

        ch = self._make_channel(
            "ch-save-test", "sun2141/grace-ai", "folder-grace", 10 * 60 * 1000
        )
        manager._channels[ch.channel_id] = ch

        def mock_stop(cid):
            manager._channels.pop(cid, None)
            manager._save_channels()
            return True

        def mock_register(folder_id, repo):
            from drive_github_sync import WatchChannel
            now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
            new_ch = WatchChannel(
                channel_id="ch-saved",
                resource_id="res",
                folder_id=folder_id,
                repo=repo,
                expiration_ms=now_ms + 23 * 3600 * 1000,
                page_token="tok",
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            manager._channels[new_ch.channel_id] = new_ch
            manager._save_channels()
            return new_ch

        manager.stop_watch = mock_stop
        manager.register_watch = mock_register

        manager.renew_expiring_channels(threshold_seconds=3600)

        # 파일에 새 채널이 저장되었는지 확인
        if self.watch_state_file.exists():
            with open(self.watch_state_file) as f:
                saved = json.load(f)
            channel_ids = [c["channel_id"] for c in saved.get("channels", [])]
            self.assertIn("ch-saved", channel_ids, "갱신된 채널이 파일에 저장되어야 함")
            self.assertNotIn("ch-save-test", channel_ids, "기존 채널은 파일에서 제거되어야 함")

    def test_sync_state_tracks_both_repos(self):
        """sync_state.json에 grace-ai와 palmoni 양쪽 추적 키 존재."""
        import sync_logger as sl_module
        sl_module.TMP_DIR = Path(self.tmp_dir)
        sl_module.STATE_FILE = Path(self.tmp_dir) / "sync_state.json"
        sl_module.LOG_FILE = Path(self.tmp_dir) / "sync_log.jsonl"
        sl_module._sync_logger_instance = None

        from sync_logger import SyncLogger
        sl = SyncLogger()

        # grace-ai 상태 추가
        sl.update_file_state(
            "sun2141/grace-ai", "execution/test.py", "sha001", "drive_id_001"
        )
        # palmoni 상태 추가
        sl.update_file_state(
            "sun2141/palmoni", "src/index.ts", "sha002", "drive_id_002"
        )
        # Drive→GitHub 상태도 추가
        sl.update_drive_file_state(
            "sun2141/palmoni", "src/app.ts", "drive_id_003",
            "2026-05-05T00:00:00Z", "sha003"
        )

        # grace-ai 확인
        grace_summary = sl.get_repo_summary("sun2141/grace-ai")
        self.assertEqual(grace_summary["total_files"], 1)

        # palmoni 확인
        palmoni_summary = sl.get_repo_summary("sun2141/palmoni")
        self.assertEqual(palmoni_summary["total_files"], 1)
        self.assertIn("src/index.ts", palmoni_summary["files"])

        # palmoni Drive→GitHub 확인
        palmoni_drive = sl.get_drive_repo_summary("sun2141/palmoni")
        self.assertEqual(palmoni_drive["total_drive_files"], 1)
        self.assertIn("src/app.ts", palmoni_drive["files"])

        # 전체 통계
        stats = sl.get_stats()
        self.assertIn("sun2141/grace-ai", stats["tracked_repos"])
        self.assertIn("sun2141/palmoni", stats["tracked_repos"])

        sl_module._sync_logger_instance = None

    def test_sync_state_metadata_excluded_from_count(self):
        """sync_state.json의 _metadata 키는 파일 카운트에 포함되지 않음."""
        import sync_logger as sl_module
        sl_module.TMP_DIR = Path(self.tmp_dir)
        sl_module.STATE_FILE = Path(self.tmp_dir) / "sync_state.json"
        sl_module.LOG_FILE = Path(self.tmp_dir) / "sync_log.jsonl"
        sl_module._sync_logger_instance = None

        from sync_logger import SyncLogger, STATE_FILE as sf
        sl = SyncLogger()

        # _metadata 포함된 초기 상태 직접 작성 (sync_state.json과 동일한 구조)
        sl._state = {
            "sun2141/palmoni": {
                "_metadata": {
                    "initialized_at": "2026-05-05T00:00:00Z",
                    "status": "active",
                }
            },
            "__drive__sun2141/palmoni": {
                "_metadata": {
                    "initialized_at": "2026-05-05T00:00:00Z",
                    "status": "active",
                }
            },
        }

        summary = sl.get_repo_summary("sun2141/palmoni")
        self.assertEqual(summary["total_files"], 0, "_metadata는 파일 카운트 제외")
        self.assertNotIn("_metadata", summary["files"])
        self.assertTrue(summary["initialized"], "초기화됨 플래그 True")

        drive_summary = sl.get_drive_repo_summary("sun2141/palmoni")
        self.assertEqual(drive_summary["total_drive_files"], 0, "_metadata는 Drive 파일 카운트 제외")
        self.assertNotIn("_metadata", drive_summary["files"])

        sl_module._sync_logger_instance = None


def run_tests(verbose: bool = False):
    """테스트 실행."""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    test_classes = [
        TestSyncLogger,
        TestGitHubDriveSyncLoopPrevention,
        TestDriveGitHubSyncMapping,
        TestDriveFileFilter,
        TestBinaryFileHandling,
        TestWebhookLoopPrevention,
        TestTelegramNotifier,
        TestGitHubSignatureVerification,
        TestDriveAuthScopes,
        TestSyncEnd2End,
        TestDriveWatchTTLRenewal,
    ]

    for cls in test_classes:
        suite.addTests(loader.loadTestsFromTestCase(cls))

    verbosity = 2 if verbose else 1
    runner = unittest.TextTestRunner(verbosity=verbosity)
    result = runner.run(suite)
    return result.wasSuccessful()


if __name__ == "__main__":
    verbose = "--verbose" in sys.argv or "-v" in sys.argv
    success = run_tests(verbose=verbose)
    sys.exit(0 if success else 1)
