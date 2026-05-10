#!/usr/bin/env python3
"""
auto_checkpoint.py - 컨텍스트 임계치 도달 시 자동 체크포인트 저장

Claude Code의 gsd-context-monitor.js hook에서 CRITICAL 임계치 도달 시 호출됩니다.
현재 세션의 TodoWrite 상태를 읽어 interrupted_task.json에 자동 저장합니다.

사용법 (hook에서 직접 호출):
  python3 /Users/sun/agent-hub/execution/auto_checkpoint.py \
      --session-id <session_id> \
      --cwd <working_directory> \
      --context-pct <remaining_percentage>

반환 코드:
  0 - 저장 성공 (또는 저장 불필요)
  1 - 오류 발생
"""

import json
import os
import sys
import argparse
import glob
import tempfile
from datetime import datetime, timezone
from pathlib import Path


TODOS_DIR = Path.home() / ".claude" / "todos"
LOCK_FILE = Path(tempfile.gettempdir()) / "auto_checkpoint.lock"
LOCK_TTL_SECONDS = 120  # 2분 이상 된 락 파일은 무효

# 기본 스크립트 위치 기준 상대경로 (하드코딩 제거)
_DEFAULT_CHECKPOINT_PATH = Path(__file__).parent.parent / ".tmp" / "interrupted_task.json"


def get_checkpoint_path(cwd: str = "") -> Path:
    """
    체크포인트 파일 경로를 결정합니다.

    우선순위:
      1. 환경변수 CHECKPOINT_PATH (절대경로)
      2. cwd 인수가 주어진 경우 cwd/.tmp/interrupted_task.json
      3. 스크립트 위치 기준 상대경로 (../  .tmp/interrupted_task.json)
    """
    env_path = os.environ.get("CHECKPOINT_PATH", "").strip()
    if env_path:
        return Path(env_path)

    if cwd:
        cwd_path = Path(cwd) / ".tmp" / "interrupted_task.json"
        # cwd가 실제로 존재하는 디렉토리인 경우에만 사용
        if Path(cwd).is_dir():
            return cwd_path

    return _DEFAULT_CHECKPOINT_PATH


def find_session_todos(session_id: str) -> list[dict]:
    """
    세션 ID에 해당하는 TodoWrite 파일을 찾아 todo 목록을 반환합니다.
    session_id가 없으면 가장 최근 파일을 사용합니다.
    """
    if not TODOS_DIR.exists():
        return []

    # session_id로 매칭되는 파일 찾기
    if session_id:
        pattern = str(TODOS_DIR / f"{session_id}-*.json")
        matches = sorted(glob.glob(pattern), key=lambda p: Path(p).stat().st_mtime, reverse=True)
        if matches:
            try:
                return json.loads(Path(matches[0]).read_text())
            except (json.JSONDecodeError, OSError):
                pass

    # fallback: 가장 최근에 수정된 todo 파일
    all_files = sorted(TODOS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for f in all_files[:3]:  # 최근 3개만 시도
        try:
            data = json.loads(f.read_text())
            if isinstance(data, list) and len(data) > 0:
                return data
        except (json.JSONDecodeError, OSError):
            continue

    return []


def is_lock_valid() -> bool:
    """락 파일이 유효한지 확인합니다 (너무 오래된 락은 무시)."""
    if not LOCK_FILE.exists():
        return False
    age = datetime.now().timestamp() - LOCK_FILE.stat().st_mtime
    return age < LOCK_TTL_SECONDS


def save_auto_checkpoint(
    session_id: str,
    cwd: str,
    context_pct: float,
    todos: list[dict],
) -> bool:
    """
    Todo 목록을 기반으로 자동 체크포인트를 저장합니다.

    이미 체크포인트가 있으면 덮어쓰지 않습니다 (수동 저장 우선).
    """
    checkpoint_path = get_checkpoint_path(cwd)

    # 이미 존재하는 체크포인트가 있고 수동으로 저장된 것이면 보존
    if checkpoint_path.exists():
        try:
            existing = json.loads(checkpoint_path.read_text())
            # 수동 저장이면 건드리지 않음 (auto 플래그 없음)
            if not existing.get("auto_saved"):
                print(f"[자동 저장 스킵] 기존 수동 체크포인트 보존: {checkpoint_path}", file=sys.stderr)
                return True
        except (json.JSONDecodeError, OSError):
            pass

    # Todo 분류 (content + activeForm 모두 보존)
    completed_items = [t for t in todos if t.get("status") == "completed"]
    remaining_items = [t for t in todos if t.get("status") in ("pending", "in_progress")]

    completed_todos = [t["content"] for t in completed_items]
    remaining_todos = [t["content"] for t in remaining_items]

    # 남은 작업이 없으면 저장 불필요
    if not remaining_todos:
        print("[자동 저장 스킵] 남은 작업 없음", file=sys.stderr)
        return True

    # in_progress 항목을 마지막 단계로 사용
    in_progress = [t["content"] for t in todos if t.get("status") == "in_progress"]
    last_step = in_progress[0] if in_progress else (completed_todos[-1] if completed_todos else "")

    # activeForm 보존 항목 생성 (없으면 content로 폴백)
    def _entry(t: dict) -> dict:
        return {"content": t["content"], "activeForm": t.get("activeForm") or t["content"]}

    completed_entries = [_entry(t) for t in completed_items]
    remaining_entries = [_entry(t) for t in remaining_items]

    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)

    checkpoint = {
        "version": "1.1",
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "task_id": f"auto_{session_id[:8] if session_id else 'unknown'}_{int(datetime.now().timestamp())}",
        "summary": f"컨텍스트 {100 - context_pct:.0f}% 사용 — 자동 저장됨 (작업 디렉토리: {cwd})",
        "last_completed_step": last_step,
        # 하위 호환: 문자열 목록
        "completed_todos": completed_todos,
        "remaining_todos": remaining_todos,
        # activeForm 포함 전체 항목
        "completed_todo_entries": completed_entries,
        "remaining_todo_entries": remaining_entries,
        "context": {
            "session_id": session_id,
            "cwd": cwd,
            "context_remaining_pct": context_pct,
            "trigger": "context_critical",
        },
        "auto_saved": True,
        "status": "interrupted",
    }

    checkpoint_path.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2))
    print(
        f"[자동 체크포인트] 저장 완료 — 남은 작업 {len(remaining_todos)}개 | "
        f"컨텍스트 잔여 {context_pct:.0f}% | 경로: {checkpoint_path}",
        file=sys.stderr,
    )
    return True


def main():
    parser = argparse.ArgumentParser(
        description="컨텍스트 임계치 도달 시 자동으로 체크포인트를 저장합니다."
    )
    parser.add_argument("--session-id", default="", help="Claude Code 세션 ID")
    parser.add_argument("--cwd", default="", help="현재 작업 디렉토리")
    parser.add_argument(
        "--context-pct", type=float, default=0.0,
        help="남은 컨텍스트 비율 (0-100)"
    )
    parser.add_argument(
        "--force", action="store_true",
        help="기존 체크포인트가 있어도 덮어쓰기"
    )

    args = parser.parse_args()

    # 중복 실행 방지 (빠른 연속 호출 시)
    if is_lock_valid():
        print("[자동 저장 스킵] 락 파일 활성 중", file=sys.stderr)
        sys.exit(0)

    # 락 설정
    LOCK_FILE.write_text(str(datetime.now().timestamp()))

    try:
        todos = find_session_todos(args.session_id)

        if not todos:
            print("[자동 저장 스킵] Todo 항목 없음", file=sys.stderr)
            sys.exit(0)

        success = save_auto_checkpoint(
            session_id=args.session_id,
            cwd=args.cwd,
            context_pct=args.context_pct,
            todos=todos,
        )
        sys.exit(0 if success else 1)

    finally:
        # 락 해제
        if LOCK_FILE.exists():
            LOCK_FILE.unlink()


if __name__ == "__main__":
    main()
