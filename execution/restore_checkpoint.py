#!/usr/bin/env python3
"""
restore_checkpoint.py - 작업 체크포인트 복원 스크립트

.tmp/interrupted_task.json을 읽어 중단된 작업 상태를 출력합니다.
세션 시작 시 호출하여 이전에 중단된 작업이 있는지 확인합니다.

사용법:
  python execution/restore_checkpoint.py          # 체크포인트 조회
  python execution/restore_checkpoint.py --json   # JSON 형식으로 출력
  python execution/restore_checkpoint.py --clear  # 체크포인트 삭제
"""

import json
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path


CHECKPOINT_PATH = Path(__file__).parent.parent / ".tmp" / "interrupted_task.json"


def load_checkpoint() -> dict | None:
    """
    체크포인트 파일을 로드합니다.

    Returns:
        체크포인트 데이터 딕셔너리, 파일이 없으면 None
    """
    if not CHECKPOINT_PATH.exists():
        return None

    try:
        data = json.loads(CHECKPOINT_PATH.read_text())
        return data
    except (json.JSONDecodeError, OSError) as e:
        print(f"[오류] 체크포인트 파일 읽기 실패: {e}", file=sys.stderr)
        return None


def format_checkpoint(checkpoint: dict) -> str:
    """체크포인트를 사람이 읽기 쉬운 형식으로 포맷합니다."""
    lines = []
    auto_saved = checkpoint.get("auto_saved", False)
    save_type = "자동 저장 (토큰 리미트 감지)" if auto_saved else "수동 저장"

    lines.append("=" * 60)
    lines.append(f"  중단된 작업 감지됨 [{save_type}]")
    lines.append("=" * 60)

    saved_at = checkpoint.get("saved_at", "알 수 없음")
    # ISO 형식 파싱하여 로컬 시간으로 표시
    try:
        dt = datetime.fromisoformat(saved_at)
        saved_at = dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    except ValueError:
        pass

    lines.append(f"저장 시각  : {saved_at}")
    lines.append(f"작업 ID    : {checkpoint.get('task_id', '없음')}")
    lines.append(f"작업 요약  : {checkpoint.get('summary', '없음')}")
    lines.append(f"마지막 단계: {checkpoint.get('last_completed_step', '없음')}")
    lines.append("")

    completed = checkpoint.get("completed_todos", [])
    if completed:
        lines.append(f"완료된 작업 ({len(completed)}개):")
        for i, todo in enumerate(completed, 1):
            lines.append(f"  [완료] {i}. {todo}")
    else:
        lines.append("완료된 작업: 없음")

    lines.append("")

    remaining = checkpoint.get("remaining_todos", [])
    if remaining:
        lines.append(f"남은 작업 ({len(remaining)}개):")
        for i, todo in enumerate(remaining, 1):
            lines.append(f"  [ ]    {i}. {todo}")
    else:
        lines.append("남은 작업: 없음 (모두 완료)")

    context = checkpoint.get("context", {})
    if context:
        lines.append("")
        lines.append("저장된 컨텍스트:")
        for key, value in context.items():
            lines.append(f"  {key}: {value}")

    lines.append("=" * 60)
    lines.append("재개하려면: 위 남은 작업 목록을 TodoWrite로 복원하세요.")
    lines.append("완료 후 삭제: python execution/restore_checkpoint.py --clear")
    lines.append("=" * 60)

    return "\n".join(lines)


def check_and_prompt() -> dict | None:
    """
    체크포인트를 확인하고 재개 여부를 표시합니다.
    Claude가 세션 시작 시 이 함수를 호출하여 중단 작업 존재를 확인합니다.

    Returns:
        체크포인트 데이터 (재개할 경우), None (체크포인트 없거나 무시할 경우)
    """
    checkpoint = load_checkpoint()
    if checkpoint is None:
        print("[체크포인트 없음] 중단된 작업이 없습니다.")
        return None

    print(format_checkpoint(checkpoint))
    return checkpoint


def main():
    parser = argparse.ArgumentParser(
        description="중단된 작업 체크포인트를 복원합니다."
    )
    parser.add_argument(
        "--json", action="store_true", dest="as_json",
        help="JSON 형식으로 출력 (스크립트 간 연동용)"
    )
    parser.add_argument(
        "--clear", action="store_true",
        help="체크포인트 파일 삭제"
    )
    parser.add_argument(
        "--exists", action="store_true",
        help="체크포인트 존재 여부만 확인 (exit code: 0=있음, 1=없음)"
    )

    args = parser.parse_args()

    if args.clear:
        if CHECKPOINT_PATH.exists():
            CHECKPOINT_PATH.unlink()
            print(f"[삭제 완료] {CHECKPOINT_PATH}")
        else:
            print("[없음] 삭제할 체크포인트가 없습니다.")
        return

    if args.exists:
        if CHECKPOINT_PATH.exists():
            print("체크포인트 있음")
            sys.exit(0)
        else:
            print("체크포인트 없음")
            sys.exit(1)

    checkpoint = load_checkpoint()

    if checkpoint is None:
        print("[체크포인트 없음] 중단된 작업이 없습니다.")
        sys.exit(1)

    if args.as_json:
        print(json.dumps(checkpoint, ensure_ascii=False, indent=2))
    else:
        print(format_checkpoint(checkpoint))


if __name__ == "__main__":
    main()
