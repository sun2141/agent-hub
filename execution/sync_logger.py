"""
동기화 상태 추적 및 로그 관리 모듈

- .tmp/sync_state.json: 파일별 마지막 동기화 SHA + Drive 파일 ID
- .tmp/sync_log.jsonl: 동기화 이력 (JSON Lines 형식)
"""

import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent
TMP_DIR = BASE_DIR / ".tmp"
STATE_FILE = TMP_DIR / "sync_state.json"
LOG_FILE = TMP_DIR / "sync_log.jsonl"


class SyncLogger:
    """
    동기화 상태 및 이력 관리.
    스레드 안전(thread-safe): Lock으로 파일 접근 보호.
    """

    def __init__(self):
        TMP_DIR.mkdir(exist_ok=True)
        self._lock = threading.Lock()
        self._state = self._load_state()

    # ─── 상태 관리 ───────────────────────────────────────────────

    def _load_state(self) -> dict:
        """sync_state.json 로드. 파일 없으면 빈 dict 반환."""
        if not STATE_FILE.exists():
            return {}
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"sync_state.json 로드 실패: {e}")
            return {}

    def _save_state(self):
        """현재 상태를 sync_state.json에 저장 (락 내부에서 호출)."""
        try:
            with open(STATE_FILE, "w") as f:
                json.dump(self._state, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"sync_state.json 저장 실패: {e}")

    def get_file_state(self, repo: str, file_path: str) -> dict | None:
        """
        특정 파일의 마지막 동기화 상태 반환.

        Returns:
            dict: {"sha": str, "drive_file_id": str, "synced_at": str} or None
        """
        return self._state.get(repo, {}).get(file_path)

    def update_file_state(
        self,
        repo: str,
        file_path: str,
        sha: str,
        drive_file_id: str,
    ):
        """파일 동기화 성공 시 상태 업데이트."""
        with self._lock:
            if repo not in self._state:
                self._state[repo] = {}
            self._state[repo][file_path] = {
                "sha": sha,
                "drive_file_id": drive_file_id,
                "synced_at": _now_iso(),
            }
            self._save_state()

    def remove_file_state(self, repo: str, file_path: str):
        """파일 삭제 시 상태에서 제거."""
        with self._lock:
            if repo in self._state and file_path in self._state[repo]:
                del self._state[repo][file_path]
                self._save_state()

    def get_drive_file_id(self, repo: str, file_path: str) -> str | None:
        """Drive 파일 ID 반환 (기존 파일 업데이트 시 필요)."""
        state = self.get_file_state(repo, file_path)
        return state["drive_file_id"] if state else None

    def is_file_changed(self, repo: str, file_path: str, new_sha: str) -> bool:
        """
        SHA 비교로 파일이 실제로 변경되었는지 확인.
        상태 없으면 True 반환 (신규 파일).
        """
        state = self.get_file_state(repo, file_path)
        if not state:
            return True
        return state["sha"] != new_sha

    def get_repo_summary(self, repo: str) -> dict:
        """저장소 동기화 현황 요약."""
        repo_state = self._state.get(repo, {})
        return {
            "repo": repo,
            "total_files": len(repo_state),
            "files": list(repo_state.keys()),
        }

    # ─── 이력 로깅 ───────────────────────────────────────────────

    def log_event(
        self,
        event_type: str,
        repo: str,
        details: dict,
        status: str = "success",
        error: str | None = None,
    ):
        """
        동기화 이벤트를 sync_log.jsonl에 기록.

        Args:
            event_type: "push", "sync_file", "delete_file", "error" 등
            repo: "owner/repo" 형식
            details: 추가 정보 (파일명, Drive ID 등)
            status: "success", "failure", "skipped"
            error: 오류 메시지 (실패 시)
        """
        entry = {
            "timestamp": _now_iso(),
            "event_type": event_type,
            "repo": repo,
            "status": status,
            "details": details,
        }
        if error:
            entry["error"] = error

        with self._lock:
            try:
                with open(LOG_FILE, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            except Exception as e:
                logger.error(f"로그 기록 실패: {e}")

    def get_recent_logs(self, n: int = 20) -> list[dict]:
        """최근 N개 로그 항목 반환."""
        if not LOG_FILE.exists():
            return []
        try:
            with open(LOG_FILE, encoding="utf-8") as f:
                lines = f.readlines()
            entries = []
            for line in lines[-n:]:
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            return entries
        except Exception as e:
            logger.error(f"로그 읽기 실패: {e}")
            return []

    def get_stats(self) -> dict:
        """전체 동기화 통계 반환."""
        logs = self.get_recent_logs(n=10000)
        total = len(logs)
        success = sum(1 for l in logs if l.get("status") == "success")
        failure = sum(1 for l in logs if l.get("status") == "failure")
        skipped = sum(1 for l in logs if l.get("status") == "skipped")

        return {
            "total_events": total,
            "success": success,
            "failure": failure,
            "skipped": skipped,
            "tracked_repos": list(self._state.keys()),
            "total_tracked_files": sum(
                len(v) for v in self._state.values()
            ),
        }


def _now_iso() -> str:
    """현재 UTC 시각을 ISO 8601 형식으로 반환."""
    return datetime.now(timezone.utc).isoformat()


# 싱글톤 인스턴스
_sync_logger_instance: SyncLogger | None = None


def get_sync_logger() -> SyncLogger:
    """SyncLogger 싱글톤 반환."""
    global _sync_logger_instance
    if _sync_logger_instance is None:
        _sync_logger_instance = SyncLogger()
    return _sync_logger_instance


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    sl = get_sync_logger()
    sl.log_event("test", "sun2141/grace-ai", {"file": "test.py"})
    print("Stats:", sl.get_stats())
    print("Recent logs:", sl.get_recent_logs(5))
