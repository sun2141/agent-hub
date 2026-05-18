#!/usr/bin/env python3
"""
rate_limit_checkpoint.py - Claude 사용량 초과 시 체크포인트 저장

'You're out of extra usage' 메시지 감지 시, 또는 사용자가 수동으로 호출할 때
현재 세션의 TodoWrite 상태를 .tmp/interrupted_task.json에 저장합니다.

Stop hook에서 rate_limited 감지 후 호출되거나, 사용자가 직접 실행합니다.

사용법:
  # 직접 실행 (수동 저장)
  python3 /Users/sun/agent-hub/execution/rate_limit_checkpoint.py \
      --session-id <session_id> \
      --cwd <working_directory>

  # 강제 덮어쓰기 (이미 체크포인트가 있어도)
  python3 /Users/sun/agent-hub/execution/rate_limit_checkpoint.py --force

반환 코드:
  0 - 저장 성공 (또는 저장 불필요)
  1 - 오류 발생
"""

import json
import os
import sys
import argparse
import glob
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any


TODOS_DIR = Path.home() / ".claude" / "todos"

# 기본 체크포인트 경로 (스크립트 위치 기준)
_DEFAULT_CHECKPOINT_PATH = Path(__file__).parent.parent / ".tmp" / "interrupted_task.json"


def get_checkpoint_path(cwd: str = "") -> Path:
    """
    체크포인트 파일 경로를 결정합니다.

    우선순위:
      1. 환경변수 CHECKPOINT_PATH (절대경로)
      2. cwd 인수가 주어진 경우 cwd/.tmp/interrupted_task.json
      3. 스크립트 위치 기준 상대경로
    """
    env_path = os.environ.get("CHECKPOINT_PATH", "").strip()
    if env_path:
        return Path(env_path)

    if cwd:
        cwd_path = Path(cwd) / ".tmp" / "interrupted_task.json"
        if Path(cwd).is_dir():
            return cwd_path

    return _DEFAULT_CHECKPOINT_PATH


def find_session_todos(session_id: str) -> List[Dict[str, Any]]:
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
    for f in all_files[:3]:
        try:
            data = json.loads(f.read_text())
            if isinstance(data, list) and len(data) > 0:
                return data
        except (json.JSONDecodeError, OSError):
            continue

    return []


def save_rate_limit_checkpoint(
    session_id: str,
    cwd: str,
    todos: List[Dict[str, Any]],
    force: bool = False,
    reset_time: str = "",
) -> bool:
    """
    rate_limited trigger로 체크포인트를 저장합니다.

    이미 수동 체크포인트(auto_saved 없음)가 있으면 덮어쓰지 않습니다.
    (force=True면 항상 덮어씁니다)
    """
    checkpoint_path = get_checkpoint_path(cwd)

    # 이미 수동 저장된 체크포인트 보존 (force 아니면)
    if not force and checkpoint_path.exists():
        try:
            existing = json.loads(checkpoint_path.read_text())
            if not existing.get("auto_saved"):
                print(
                    f"[rate_limit 저장 스킵] 기존 수동 체크포인트 보존: {checkpoint_path}",
                    file=sys.stderr
                )
                return True
        except (json.JSONDecodeError, OSError):
            pass

    # Todo 분류
    completed_items = [t for t in todos if t.get("status") == "completed"]
    remaining_items = [t for t in todos if t.get("status") in ("pending", "in_progress")]

    completed_todos = [t["content"] for t in completed_items]
    remaining_todos = [t["content"] for t in remaining_items]

    # in_progress 항목을 마지막 단계로 사용
    in_progress = [t["content"] for t in todos if t.get("status") == "in_progress"]
    last_step = in_progress[0] if in_progress else (completed_todos[-1] if completed_todos else "")

    def _entry(t: dict) -> dict:
        return {"content": t["content"], "activeForm": t.get("activeForm") or t["content"]}

    completed_entries = [_entry(t) for t in completed_items]
    remaining_entries = [_entry(t) for t in remaining_items]

    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)

    # 요약 문자열: 리셋 시각 포함 시 명시
    reset_note = f" (리셋 예정: {reset_time})" if reset_time else ""
    summary = (
        f"Claude 사용량 초과로 세션 중단됨 — 자동 저장"
        f"{reset_note}"
        f" (작업 디렉토리: {cwd or '알 수 없음'})"
    )

    checkpoint = {
        "version": "1.1",
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "task_id": f"rate_limited_{session_id[:8] if session_id else 'manual'}_{int(datetime.now().timestamp())}",
        "summary": summary,
        "last_completed_step": last_step,
        "completed_todos": completed_todos,
        "remaining_todos": remaining_todos,
        "completed_todo_entries": completed_entries,
        "remaining_todo_entries": remaining_entries,
        "context": {
            "session_id": session_id,
            "cwd": cwd,
            "trigger": "rate_limited",
            "reset_time": reset_time,
        },
        "auto_saved": True,
        "status": "interrupted",
    }

    checkpoint_path.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2))
    reset_note = f" | 리셋 예정: {reset_time}" if reset_time else ""
    print(
        f"[rate_limit 체크포인트] 저장 완료 — 남은 작업 {len(remaining_todos)}개 | "
        f"trigger: rate_limited{reset_note} | 경로: {checkpoint_path}",
        file=sys.stderr,
    )
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Claude 사용량 초과 시 현재 작업 상태를 체크포인트로 저장합니다."
    )
    parser.add_argument("--session-id", default="", help="Claude Code 세션 ID")
    parser.add_argument("--cwd", default="", help="현재 작업 디렉토리")
    parser.add_argument("--reset-time", default="", help="한도 리셋 예정 시각 (예: 2am Asia/Seoul)")
    parser.add_argument(
        "--force", action="store_true",
        help="기존 체크포인트가 있어도 덮어쓰기"
    )

    args = parser.parse_args()

    cwd = args.cwd or os.getcwd()
    todos = find_session_todos(args.session_id)

    # todos가 없어도 rate limit 체크포인트는 저장 (한도 리셋 후 재개 안내용)
    # 단, force가 아니고 이미 수동 체크포인트가 있으면 스킵
    if not todos:
        checkpoint_path = get_checkpoint_path(cwd)
        if not args.force and checkpoint_path.exists():
            try:
                existing = json.loads(checkpoint_path.read_text())
                if not existing.get("auto_saved"):
                    print("[rate_limit 저장 스킵] 기존 수동 체크포인트 보존", file=sys.stderr)
                    sys.exit(0)
            except (json.JSONDecodeError, OSError):
                pass
        print("[rate_limit 저장] Todo 없음 — 최소 체크포인트 저장", file=sys.stderr)

    success = save_rate_limit_checkpoint(
        session_id=args.session_id,
        cwd=cwd,
        todos=todos,
        force=args.force,
        reset_time=args.reset_time,
    )
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
