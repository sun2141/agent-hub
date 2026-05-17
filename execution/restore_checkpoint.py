#!/usr/bin/env python3
"""
restore_checkpoint.py - 작업 체크포인트 복원 스크립트

.tmp/interrupted_task.json을 읽어 중단된 작업 상태를 출력합니다.
세션 시작 시 호출하여 이전에 중단된 작업이 있는지 확인합니다.

사용법:
  python execution/restore_checkpoint.py          # 체크포인트 조회
  python execution/restore_checkpoint.py --json   # JSON 형식으로 출력
  python execution/restore_checkpoint.py --resume # TodoWrite용 JSON 출력 (에이전트 자동 복원)
  python execution/restore_checkpoint.py --clear  # 체크포인트 삭제

종료 코드:
  0 - 체크포인트 없음 (정상, 새 작업 시작)
  2 - 체크포인트 있음 (중단된 작업 감지, 재개 필요)
  1 - 오류 (파일 읽기 실패 등)
"""

import json
import sys
import argparse
from datetime import datetime, timezone, timedelta
from pathlib import Path

# 체크포인트 만료 기한 (이 시간보다 오래된 체크포인트는 경고 표시)
STALE_HOURS = 24


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
        sys.exit(1)


def is_stale(checkpoint: dict) -> bool:
    """체크포인트가 STALE_HOURS보다 오래되었는지 확인합니다."""
    saved_at = checkpoint.get("saved_at")
    if not saved_at:
        return False
    try:
        dt = datetime.fromisoformat(saved_at)
        age = datetime.now(timezone.utc) - dt
        return age > timedelta(hours=STALE_HOURS)
    except (ValueError, TypeError):
        return False


def format_checkpoint(checkpoint: dict) -> str:
    """체크포인트를 사람이 읽기 쉬운 형식으로 포맷합니다."""
    lines = []
    auto_saved = checkpoint.get("auto_saved", False)
    trigger = checkpoint.get("context", {}).get("trigger", "")
    if trigger == "rate_limited":
        save_type = "자동 저장 (Claude 사용량 초과)"
    elif auto_saved:
        save_type = "자동 저장 (컨텍스트 한도 감지)"
    else:
        save_type = "수동 저장"

    lines.append("=" * 60)
    lines.append(f"  중단된 작업 감지됨 [{save_type}]")
    lines.append("=" * 60)

    saved_at_raw = checkpoint.get("saved_at", "알 수 없음")
    saved_at = saved_at_raw
    # ISO 형식 파싱하여 로컬 시간으로 표시
    try:
        dt = datetime.fromisoformat(saved_at_raw)
        # UTC → 로컬 시간으로 변환
        local_dt = dt.astimezone()
        saved_at = local_dt.strftime("%Y-%m-%d %H:%M:%S %Z")
    except (ValueError, TypeError):
        pass

    # 만료 경고
    if is_stale(checkpoint):
        lines.append(f"⚠️  경고: {STALE_HOURS}시간 이상 지난 체크포인트입니다. 내용이 유효하지 않을 수 있습니다.")

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
    if trigger == "rate_limited":
        lines.append("💡 Claude 사용량 한도 초과로 중단됨. 한도 리셋 후 재개 가능합니다.")
    lines.append("재개하려면: python execution/restore_checkpoint.py --resume")
    lines.append("완료 후 삭제: python execution/restore_checkpoint.py --clear")
    lines.append("=" * 60)

    return "\n".join(lines)


def _make_active_form(content: str) -> str:
    """
    content 문자열에서 activeForm(진행형 텍스트)을 추론합니다.

    한국어: 마지막 어절에 '중' 접미사를 붙임
      예) "파일 업로드" → "파일 업로드 중"
    영어: 첫 단어가 동사인 경우 '-ing' 변환 시도
      예) "Upload files" → "Uploading files"
    변환 불가 시 원본 반환.
    """
    if not content:
        return content

    # 영어 첫 단어 동사 → -ing 변환 (단순 규칙)
    words = content.split()
    first = words[0] if words else ""
    if first and first[0].isupper() and first.isascii():
        # 기본 동사 → ing 변환 규칙
        verb = first.lower()
        if verb.endswith("e") and not verb.endswith("ee") and not verb.endswith("ie"):
            ing = verb[:-1] + "ing"
        elif (len(verb) >= 3
              and verb[-1] not in "aeiouywxhcv"
              and verb[-2] in "aeiou"
              and verb[-3] not in "aeiou"):
            ing = verb + verb[-1] + "ing"
        else:
            ing = verb + "ing"
        rest = " ".join(words[1:])
        return (ing.capitalize() + (" " + rest if rest else "")).strip()

    # 한국어: 끝에 ' 중' 추가 (이미 '중'으로 끝나면 그대로)
    if not content.endswith("중") and not content.endswith("중..."):
        return content + " 중"
    return content


def format_resume(checkpoint: dict) -> str:
    """
    에이전트가 TodoWrite 도구에 바로 넣을 수 있는 JSON 형식으로 출력합니다.

    activeForm 복원 우선순위:
      1. *_todo_entries 필드에 저장된 원본 activeForm (save_checkpoint v1.1+)
      2. *_todos 문자열 목록에서 _make_active_form()으로 추론

    출력 구조:
    {
      "summary": "...",
      "last_completed_step": "...",
      "saved_at": "...",
      "stale": false,
      "context": {...},
      "todos": [
        {"content": "...", "status": "completed", "activeForm": "..."},
        {"content": "...", "status": "pending",   "activeForm": "..."}
      ]
    }
    """
    todos = []

    # completed — entries 우선, 없으면 문자열 목록 폴백
    completed_entries = checkpoint.get("completed_todo_entries")
    if completed_entries:
        for entry in completed_entries:
            content = entry.get("content", "")
            active_form = entry.get("activeForm") or content
            todos.append({"content": content, "status": "completed", "activeForm": active_form})
    else:
        for item in checkpoint.get("completed_todos", []):
            todos.append({
                "content": item,
                "status": "completed",
                "activeForm": item,  # 완료된 항목은 진행형 불필요
            })

    # remaining — entries 우선, 없으면 문자열 목록 폴백 + activeForm 추론
    remaining_entries = checkpoint.get("remaining_todo_entries")
    if remaining_entries:
        for entry in remaining_entries:
            content = entry.get("content", "")
            active_form = entry.get("activeForm") or _make_active_form(content)
            todos.append({"content": content, "status": "pending", "activeForm": active_form})
    else:
        for item in checkpoint.get("remaining_todos", []):
            todos.append({
                "content": item,
                "status": "pending",
                "activeForm": _make_active_form(item),
            })

    # 저장 시각을 로컬 시간으로 변환
    saved_at_display = checkpoint.get("saved_at", "")
    try:
        dt = datetime.fromisoformat(saved_at_display)
        saved_at_display = dt.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    except (ValueError, TypeError):
        pass

    result = {
        "summary": checkpoint.get("summary", ""),
        "last_completed_step": checkpoint.get("last_completed_step", ""),
        "saved_at": saved_at_display,
        "stale": is_stale(checkpoint),
        "context": checkpoint.get("context", {}),
        "todos": todos,
    }
    return json.dumps(result, ensure_ascii=False, indent=2)


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
        "--resume", action="store_true",
        help="TodoWrite 자동 복원용 JSON 출력 (completed+remaining todos 포함)"
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
        sys.exit(0)  # 정상 종료 — 새 작업 시작 가능

    if args.resume:
        print(format_resume(checkpoint))
        # --resume은 에이전트가 JSON 파싱 용도로 사용 → exit 0
        sys.exit(0)
    elif args.as_json:
        print(json.dumps(checkpoint, ensure_ascii=False, indent=2))
    else:
        print(format_checkpoint(checkpoint))

    # 체크포인트 있음 = exit 2 (에러가 아니라 "재개 필요" 신호)
    sys.exit(2)


if __name__ == "__main__":
    main()
