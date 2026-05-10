#!/usr/bin/env python3
"""
task_wrapper.py - 작업 실행 래퍼 레이어

기존 execution/ 스크립트 실행 흐름을 변경하지 않고,
실행 전후 파일 상태를 스냅샷하여 변경사항을 감지하고
리포트를 자동 생성합니다.

사용법:
  # 스크립트를 래핑하여 실행
  python execution/task_wrapper.py \
      --cmd "python execution/some_script.py --arg value" \
      --summary "some_script 실행 결과" \
      --watch "config/" "execution/"

  # 변경사항 딕셔너리를 직접 전달하여 리포트만 생성
  python execution/task_wrapper.py \
      --report-only \
      --changes-json '[{"change_type":"added","path":"...","description":"..."}]' \
      --summary "수동 변경사항 리포트"

  # 리포트 생성 후 자동 적용 (UI 없이)
  python execution/task_wrapper.py \
      --cmd "python execution/some_script.py" \
      --auto-apply

Python API:
  from execution.task_wrapper import TaskWrapper

  with TaskWrapper(
      summary="작업 요약",
      watch_paths=["config/", "execution/"],
  ) as wrapper:
      # 여기서 실제 작업 실행
      subprocess.run(["python", "execution/some_script.py"])
      # 수동으로 변경사항 추가도 가능
      wrapper.add_change("added", "new_file.py", "새 파일 추가")

  # with 블록이 끝나면 자동으로 리포트 생성 및 TUI 표시
  report, applied_changes = wrapper.result
"""

import json
import os
import subprocess
import sys
import hashlib
import argparse
from datetime import datetime
from pathlib import Path
from typing import Optional

# 같은 패키지에서 임포트
_THIS_DIR = Path(__file__).parent
sys.path.insert(0, str(_THIS_DIR.parent))

from execution.report_ui import (
    create_report,
    run_interactive,
    apply_changes,
    print_apply_result,
    print_report_summary,
    Report,
    ChangeItem,
    colorize,
    Color,
)

# 기본 감시 제외 패턴
DEFAULT_IGNORE_PATTERNS = [
    ".git",
    "__pycache__",
    ".pyc",
    ".tmp",
    "node_modules",
    ".venv",
    "venv",
    ".env",
    "token.json",
]


def _should_ignore(path: Path, ignore_patterns: list[str]) -> bool:
    """파일이 무시 목록에 해당하는지 확인"""
    path_str = str(path)
    for pat in ignore_patterns:
        if pat in path_str:
            return True
    return False


def _file_hash(path: Path) -> str:
    """파일 내용의 MD5 해시 반환"""
    try:
        return hashlib.md5(path.read_bytes()).hexdigest()
    except (OSError, PermissionError):
        return ""


def _read_text_safe(path: Path) -> Optional[str]:
    """텍스트 파일을 안전하게 읽기 (바이너리는 None 반환)"""
    try:
        content = path.read_bytes()
        # 바이너리 파일 감지 (null byte 존재 시)
        if b"\x00" in content[:8192]:
            return None
        return content.decode("utf-8", errors="replace")
    except (OSError, PermissionError):
        return None


def snapshot_directory(
    paths: list[Path],
    base_dir: Path,
    ignore_patterns: list[str] = None,
) -> dict[str, dict]:
    """
    감시 대상 경로들의 현재 상태를 스냅샷합니다.

    Returns:
        {relative_path_str: {"hash": str, "content": str|None, "mtime": float}}
    """
    if ignore_patterns is None:
        ignore_patterns = DEFAULT_IGNORE_PATTERNS

    snapshot = {}
    for watch_path in paths:
        abs_path = (base_dir / watch_path).resolve()
        if not abs_path.exists():
            continue

        if abs_path.is_file():
            files = [abs_path]
        else:
            files = [f for f in abs_path.rglob("*") if f.is_file()]

        for f in files:
            if _should_ignore(f, ignore_patterns):
                continue
            rel = str(f.relative_to(base_dir))
            snapshot[rel] = {
                "hash": _file_hash(f),
                "content": _read_text_safe(f),
                "mtime": f.stat().st_mtime,
            }

    return snapshot


def diff_snapshots(
    before: dict[str, dict],
    after: dict[str, dict],
    base_dir: Path,
) -> list[dict]:
    """
    두 스냅샷을 비교하여 변경사항 목록을 반환합니다.

    Returns:
        변경사항 딕셔너리 목록 (create_report에 전달 가능한 형식)
    """
    changes = []
    all_paths = set(before.keys()) | set(after.keys())

    for rel_path in sorted(all_paths):
        in_before = rel_path in before
        in_after = rel_path in after

        if in_before and not in_after:
            # 삭제됨
            changes.append({
                "change_type": "deleted",
                "path": rel_path,
                "description": f"파일이 삭제되었습니다",
                "old_content": before[rel_path].get("content"),
                "new_content": None,
            })

        elif not in_before and in_after:
            # 추가됨
            changes.append({
                "change_type": "added",
                "path": rel_path,
                "description": f"새 파일이 추가되었습니다",
                "old_content": None,
                "new_content": after[rel_path].get("content"),
            })

        elif in_before and in_after:
            b_hash = before[rel_path]["hash"]
            a_hash = after[rel_path]["hash"]
            if b_hash != a_hash:
                # 수정됨
                changes.append({
                    "change_type": "modified",
                    "path": rel_path,
                    "description": f"파일 내용이 변경되었습니다",
                    "old_content": before[rel_path].get("content"),
                    "new_content": after[rel_path].get("content"),
                })

    return changes


class TaskWrapper:
    """
    작업 실행을 감싸서 변경사항을 자동으로 감지하는 컨텍스트 매니저.

    사용 예:
        with TaskWrapper(
            summary="config 업데이트",
            watch_paths=["config/"],
            interactive=True,
        ) as wrapper:
            # 실제 작업
            Path("config/settings.json").write_text('{"version": "2.0"}')
            wrapper.add_change("config", "ENV: API_KEY", "API 키 갱신")

        selected_changes, applied = wrapper.result
        report = wrapper.report
    """

    def __init__(
        self,
        summary: str,
        watch_paths: list[str] = None,
        base_dir: Path = None,
        ignore_patterns: list[str] = None,
        interactive: bool = True,
        auto_apply: bool = False,
        save_report: bool = True,
    ):
        self.summary = summary
        self.watch_paths = [Path(p) for p in (watch_paths or [])]
        self.base_dir = base_dir or Path.cwd()
        self.ignore_patterns = ignore_patterns or DEFAULT_IGNORE_PATTERNS
        self.interactive = interactive
        self.auto_apply = auto_apply
        self.save_report = save_report

        self._before_snapshot: dict = {}
        self._manual_changes: list[dict] = []
        self.report: Optional[Report] = None
        self.result: tuple[list[ChangeItem], bool] = ([], False)

    def __enter__(self):
        if self.watch_paths:
            print(colorize(
                f"  [TaskWrapper] 스냅샷 촬영: {', '.join(str(p) for p in self.watch_paths)}",
                Color.DIM
            ))
            self._before_snapshot = snapshot_directory(
                self.watch_paths, self.base_dir, self.ignore_patterns
            )
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is not None:
            # 예외 발생 시 리포트를 생성하지 않음
            return False

        # 사후 스냅샷
        detected_changes = []
        if self.watch_paths:
            after_snapshot = snapshot_directory(
                self.watch_paths, self.base_dir, self.ignore_patterns
            )
            detected_changes = diff_snapshots(
                self._before_snapshot, after_snapshot, self.base_dir
            )

        # 수동 추가된 변경사항과 합치기
        all_changes = detected_changes + self._manual_changes

        # 리포트 생성
        self.report, saved_path = create_report(
            task_summary=self.summary,
            changes=all_changes,
            save=self.save_report,
        )

        if saved_path:
            print(colorize(f"\n  [리포트 저장] {saved_path}", Color.DIM))

        if not all_changes:
            print(colorize("\n  변경사항이 없습니다.", Color.DIM))
            self.result = ([], False)
            return False

        # UI 표시
        if self.interactive and sys.stdin.isatty() and not self.auto_apply:
            print(colorize(f"\n  {len(all_changes)}개 변경사항 감지 — 인터랙티브 리포트 로드 중...", Color.YELLOW))
            selected, applied = run_interactive(self.report)
            if applied:
                results = apply_changes(selected)
                print_apply_result(results, selected)
            self.result = (selected, applied)
        elif self.auto_apply:
            selected = self.report.selected_changes()
            results = apply_changes(selected)
            print_apply_result(results, selected)
            self.result = (selected, True)
        else:
            print_report_summary(self.report)
            self.result = (self.report.selected_changes(), False)

        return False

    def add_change(
        self,
        change_type: str,
        path: str,
        description: str,
        old_content: str = None,
        new_content: str = None,
        metadata: dict = None,
        selected: bool = True,
    ):
        """수동으로 변경사항을 추가합니다."""
        self._manual_changes.append({
            "change_type": change_type,
            "path": path,
            "description": description,
            "old_content": old_content,
            "new_content": new_content,
            "metadata": metadata or {},
            "selected": selected,
        })


def run_command_with_report(
    cmd: str,
    summary: str,
    watch_paths: list[str] = None,
    interactive: bool = True,
    auto_apply: bool = False,
    env: dict = None,
) -> tuple[int, Report, list[ChangeItem], bool]:
    """
    명령어를 실행하고 변경사항 리포트를 생성합니다.

    Args:
        cmd: 실행할 명령어 문자열
        summary: 리포트 요약
        watch_paths: 감시할 경로 목록
        interactive: 인터랙티브 TUI 표시 여부
        auto_apply: 자동 적용 여부
        env: 추가 환경 변수

    Returns:
        (returncode, report, selected_changes, applied)
    """
    base_dir = Path.cwd()
    proc_env = {**os.environ, **(env or {})}

    with TaskWrapper(
        summary=summary,
        watch_paths=watch_paths or [],
        base_dir=base_dir,
        interactive=interactive,
        auto_apply=auto_apply,
    ) as wrapper:
        print(colorize(f"  [실행] {cmd}", Color.DIM))
        result = subprocess.run(
            cmd, shell=True, env=proc_env
        )
        returncode = result.returncode

    report = wrapper.report
    selected, applied = wrapper.result
    return returncode, report, selected, applied


# ─── CLI 진입점 ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="작업 실행 래퍼: 변경사항 감지 및 리포트 생성",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument("--cmd", "-c", help="실행할 명령어")
    mode_group.add_argument("--report-only", action="store_true", help="리포트만 생성 (명령어 실행 없음)")

    parser.add_argument("--summary", "-s", default="작업이 완료되었습니다.", help="리포트 요약")
    parser.add_argument("--watch", "-w", nargs="+", default=[], help="감시할 경로 목록")
    parser.add_argument(
        "--changes-json", help="변경사항 JSON 문자열 (--report-only와 함께 사용)"
    )
    parser.add_argument("--auto-apply", action="store_true", help="선택된 항목 자동 적용")
    parser.add_argument("--no-interactive", action="store_true", help="비인터랙티브 모드")

    args = parser.parse_args()

    if args.report_only:
        changes = []
        if args.changes_json:
            try:
                changes = json.loads(args.changes_json)
            except json.JSONDecodeError as e:
                print(colorize(f"오류: --changes-json 파싱 실패: {e}", Color.RED), file=sys.stderr)
                sys.exit(1)

        report, saved_path = create_report(
            task_summary=args.summary,
            changes=changes,
        )
        if saved_path:
            print(colorize(f"  [리포트 저장] {saved_path}", Color.DIM))

        if args.auto_apply:
            selected = report.selected_changes()
            results = apply_changes(selected)
            print_apply_result(results, selected)
        elif args.no_interactive or not sys.stdin.isatty():
            print_report_summary(report)
        else:
            selected, applied = run_interactive(report)
            if applied:
                results = apply_changes(selected)
                print_apply_result(results, selected)
        return

    if args.cmd:
        returncode, report, selected, applied = run_command_with_report(
            cmd=args.cmd,
            summary=args.summary,
            watch_paths=args.watch,
            interactive=not args.no_interactive,
            auto_apply=args.auto_apply,
        )
        sys.exit(returncode)

    parser.print_help()


if __name__ == "__main__":
    main()
