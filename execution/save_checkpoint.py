#!/usr/bin/env python3
"""
save_checkpoint.py - 작업 체크포인트 저장 스크립트

작업 중간 상태를 .tmp/interrupted_task.json에 저장합니다.
토큰 리미트로 세션이 중단될 경우를 대비해 주기적으로 호출합니다.

사용법:
  python execution/save_checkpoint.py --summary "현재 작업 요약" \
      --completed "완료된 단계" --remaining "남은 할일 1" "남은 할일 2" \
      --context '{"key": "value"}'

  또는 Python에서 직접 import하여 사용:
  from execution.save_checkpoint import save_checkpoint
  save_checkpoint(summary="...", completed_todos=[...], remaining_todos=[...])
"""

import json
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path


CHECKPOINT_PATH = Path(__file__).parent.parent / ".tmp" / "interrupted_task.json"


def _normalize_todos(
    items: list,
) -> tuple[list[str], list[dict]]:
    """
    todo 항목 목록을 정규화합니다.

    items는 문자열 또는 {'content': ..., 'activeForm': ...} 딕셔너리를 섞어 받을 수 있습니다.

    Returns:
        (contents, todo_entries) — contents는 하위호환 문자열 목록,
        todo_entries는 activeForm을 포함한 전체 객체 목록
    """
    contents = []
    entries = []
    for item in items:
        if isinstance(item, dict):
            content = item.get("content", "")
            active_form = item.get("activeForm", content)
        else:
            content = str(item)
            active_form = content
        contents.append(content)
        entries.append({"content": content, "activeForm": active_form})
    return contents, entries


def save_checkpoint(
    summary: str,
    completed_todos: list,
    remaining_todos: list,
    last_completed_step: str = "",
    context: dict = None,
    task_id: str = "",
) -> Path:
    """
    작업 체크포인트를 저장합니다.

    Args:
        summary: 전체 작업에 대한 간략한 설명
        completed_todos: 이미 완료된 todo 항목 목록.
            각 항목은 문자열 또는 {'content': str, 'activeForm': str} 딕셔너리.
        remaining_todos: 아직 남은 todo 항목 목록. 동일 형식.
        last_completed_step: 마지막으로 완료한 단계 설명
        context: 재개 시 필요한 추가 컨텍스트 (딕셔너리)
        task_id: 작업 식별자 (선택)

    Returns:
        저장된 체크포인트 파일 경로
    """
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)

    completed_contents, completed_entries = _normalize_todos(completed_todos)
    remaining_contents, remaining_entries = _normalize_todos(remaining_todos)

    # 완료 및 남은 todos가 모두 비어있으면 저장 불필요
    if not completed_contents and not remaining_contents:
        print("[체크포인트 저장 스킵] todos가 비어있어 저장하지 않습니다.")
        return CHECKPOINT_PATH

    checkpoint = {
        "version": "1.1",
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "task_id": task_id or f"task_{int(datetime.now().timestamp())}",
        "summary": summary,
        "last_completed_step": last_completed_step,
        # 하위 호환: 문자열 목록 (기존 파서 대응)
        "completed_todos": completed_contents,
        "remaining_todos": remaining_contents,
        # activeForm 포함 전체 항목 (restore_checkpoint --resume에서 활용)
        "completed_todo_entries": completed_entries,
        "remaining_todo_entries": remaining_entries,
        "context": context or {},
        "status": "interrupted",
    }

    CHECKPOINT_PATH.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2))
    print(f"[체크포인트 저장] {CHECKPOINT_PATH}")
    print(f"  - 완료: {len(completed_contents)}개 | 남은 작업: {len(remaining_contents)}개")
    print(f"  - 마지막 단계: {last_completed_step or '없음'}")
    return CHECKPOINT_PATH


def clear_checkpoint():
    """작업 완료 후 체크포인트 파일을 삭제합니다."""
    if CHECKPOINT_PATH.exists():
        CHECKPOINT_PATH.unlink()
        print(f"[체크포인트 삭제] 작업이 완료되었습니다. {CHECKPOINT_PATH}")
    else:
        print("[체크포인트 없음] 삭제할 체크포인트가 없습니다.")


def _parse_todo_args(items: list[str]) -> list:
    """
    CLI 인수에서 todo 항목을 파싱합니다.

    형식:
      "단순 텍스트"                → content=activeForm=해당 텍스트
      "content:::activeForm 텍스트" → 각각 분리

    ':::' 구분자를 사용하면 activeForm을 별도로 지정할 수 있습니다.
    예: --remaining "파일 업로드:::파일 업로드 중"
    """
    result = []
    for item in items:
        if ":::" in item:
            content, _, active_form = item.partition(":::")
            result.append({"content": content.strip(), "activeForm": active_form.strip()})
        else:
            result.append(item)
    return result


def main():
    parser = argparse.ArgumentParser(
        description="작업 체크포인트를 .tmp/interrupted_task.json에 저장합니다."
    )
    parser.add_argument("--summary", required=True, help="현재 작업 요약")
    parser.add_argument(
        "--completed", nargs="*", default=[],
        help="완료된 todo 목록. 'content:::activeForm' 형식으로 activeForm 지정 가능."
    )
    parser.add_argument(
        "--remaining", nargs="*", default=[],
        help="남은 todo 목록. 'content:::activeForm' 형식으로 activeForm 지정 가능."
    )
    parser.add_argument(
        "--last-step", default="", help="마지막으로 완료한 단계"
    )
    parser.add_argument(
        "--context", default="{}", help="추가 컨텍스트 (JSON 문자열)"
    )
    parser.add_argument("--task-id", default="", help="작업 ID")
    parser.add_argument(
        "--clear", action="store_true", help="체크포인트 파일 삭제 (작업 완료 시)"
    )

    args = parser.parse_args()

    if args.clear:
        clear_checkpoint()
        return

    try:
        context = json.loads(args.context)
    except json.JSONDecodeError:
        print(f"[경고] --context JSON 파싱 실패, 빈 딕셔너리로 대체: {args.context}")
        context = {}

    save_checkpoint(
        summary=args.summary,
        completed_todos=_parse_todo_args(args.completed),
        remaining_todos=_parse_todo_args(args.remaining),
        last_completed_step=args.last_step,
        context=context,
        task_id=args.task_id,
    )


if __name__ == "__main__":
    main()
