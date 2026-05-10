#!/usr/bin/env python3
"""
report_ui.py - 작업 결과 리포트 TUI 시스템

작업 완료 후 변경사항을 카드 형태로 표시하고,
각 변경사항에 대해 적용/취소 토글을 제공합니다.

사용법:
  # 리포트 표시 (인터랙티브 모드)
  python execution/report_ui.py --report .tmp/reports/report_20240101_120000.json

  # 리포트 히스토리 열람
  python execution/report_ui.py --history

  # 직접 변경사항으로 리포트 생성 및 표시
  python execution/report_ui.py --changes changes.json

키보드 조작:
  Space / Enter : 현재 항목 토글 (ON/OFF)
  j / ↓        : 다음 항목
  k / ↑        : 이전 항목
  a            : 전체 선택
  n            : 전체 해제
  d            : diff 상세보기 토글
  q            : 종료 (적용 없이)
  Enter (Apply버튼에서) : 선택된 항목 적용
"""

import json
import sys
import os
import argparse
import subprocess
import termios
import tty
import textwrap
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
from difflib import unified_diff


REPORTS_DIR = Path(__file__).parent.parent / ".tmp" / "reports"

# ANSI 색상 코드
class Color:
    RESET   = "\033[0m"
    BOLD    = "\033[1m"
    DIM     = "\033[2m"
    RED     = "\033[91m"
    GREEN   = "\033[92m"
    YELLOW  = "\033[93m"
    BLUE    = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN    = "\033[96m"
    WHITE   = "\033[97m"
    BG_BLUE = "\033[44m"
    BG_GREEN= "\033[42m"
    BG_RED  = "\033[41m"
    BG_GRAY = "\033[100m"


def colorize(text: str, *codes: str) -> str:
    return "".join(codes) + text + Color.RESET


def get_terminal_width() -> int:
    try:
        return os.get_terminal_size().columns
    except OSError:
        return 80


@dataclass
class ChangeItem:
    """단일 변경 항목"""
    id: str
    change_type: str          # "added" | "modified" | "deleted" | "config"
    path: str                 # 파일 경로 또는 설정 키
    description: str          # 변경 설명
    old_content: Optional[str] = None
    new_content: Optional[str] = None
    metadata: dict = field(default_factory=dict)
    selected: bool = True     # 기본값 ON

    def type_label(self) -> str:
        labels = {
            "added":    colorize(" + 추가 ", Color.BOLD, Color.BG_GREEN, Color.WHITE),
            "modified": colorize(" ~ 수정 ", Color.BOLD, Color.BG_BLUE, Color.WHITE),
            "deleted":  colorize(" - 삭제 ", Color.BOLD, Color.BG_RED, Color.WHITE),
            "config":   colorize(" ⚙ 설정 ", Color.BOLD, Color.BG_GRAY, Color.WHITE),
        }
        return labels.get(self.change_type, colorize(f" {self.change_type} ", Color.BOLD))

    def type_color(self) -> str:
        colors = {
            "added":    Color.GREEN,
            "modified": Color.BLUE,
            "deleted":  Color.RED,
            "config":   Color.YELLOW,
        }
        return colors.get(self.change_type, Color.WHITE)

    def get_diff_lines(self) -> list[str]:
        """unified diff 형식으로 변경사항 반환"""
        if self.old_content is None and self.new_content is None:
            return []

        old_lines = (self.old_content or "").splitlines(keepends=True)
        new_lines = (self.new_content or "").splitlines(keepends=True)

        diff = list(unified_diff(
            old_lines,
            new_lines,
            fromfile=f"a/{self.path}",
            tofile=f"b/{self.path}",
            lineterm=""
        ))
        return diff


@dataclass
class Report:
    """작업 결과 리포트"""
    report_id: str
    task_summary: str
    created_at: str
    changes: list[ChangeItem] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict) -> "Report":
        changes = []
        for i, c in enumerate(data.get("changes", [])):
            changes.append(ChangeItem(
                id=c.get("id", f"change_{i}"),
                change_type=c.get("change_type", "modified"),
                path=c.get("path", ""),
                description=c.get("description", ""),
                old_content=c.get("old_content"),
                new_content=c.get("new_content"),
                metadata=c.get("metadata", {}),
                selected=c.get("selected", True),
            ))
        return cls(
            report_id=data.get("report_id", ""),
            task_summary=data.get("task_summary", ""),
            created_at=data.get("created_at", ""),
            changes=changes,
            metadata=data.get("metadata", {}),
        )

    def to_dict(self) -> dict:
        return {
            "report_id": self.report_id,
            "task_summary": self.task_summary,
            "created_at": self.created_at,
            "changes": [
                {
                    "id": c.id,
                    "change_type": c.change_type,
                    "path": c.path,
                    "description": c.description,
                    "old_content": c.old_content,
                    "new_content": c.new_content,
                    "metadata": c.metadata,
                    "selected": c.selected,
                }
                for c in self.changes
            ],
            "metadata": self.metadata,
        }

    def selected_changes(self) -> list[ChangeItem]:
        return [c for c in self.changes if c.selected]

    def save(self, path: Optional[Path] = None) -> Path:
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        if path is None:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            path = REPORTS_DIR / f"report_{ts}_{self.report_id[:8]}.json"
        path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2))
        return path


def load_report(path: Path) -> Report:
    data = json.loads(path.read_text())
    return Report.from_dict(data)


def list_reports() -> list[Path]:
    if not REPORTS_DIR.exists():
        return []
    reports = sorted(REPORTS_DIR.glob("report_*.json"), reverse=True)
    return list(reports)


# ─── 터미널 입력 처리 ───────────────────────────────────────────────────────

def getch() -> str:
    """단일 키 입력 (raw mode)"""
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = sys.stdin.read(1)
        # 화살표 키 처리 (ESC [ A/B/C/D)
        if ch == "\x1b":
            next1 = sys.stdin.read(1)
            if next1 == "[":
                next2 = sys.stdin.read(1)
                return f"ARROW_{next2}"
            return ch
        return ch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


# ─── 렌더링 함수 ────────────────────────────────────────────────────────────

def clear_screen():
    print("\033[2J\033[H", end="", flush=True)


def move_cursor(row: int, col: int = 1):
    print(f"\033[{row};{col}H", end="", flush=True)


def render_header(report: Report, width: int):
    print(colorize("=" * width, Color.CYAN))
    title = f"  작업 결과 리포트  |  {report.created_at}"
    print(colorize(title, Color.BOLD, Color.CYAN))
    # 요약 텍스트 줄바꿈 처리
    summary_lines = textwrap.wrap(f"  {report.task_summary}", width - 2)
    for line in summary_lines:
        print(colorize(line, Color.WHITE))
    print(colorize("=" * width, Color.CYAN))


def render_change_card(
    item: ChangeItem,
    index: int,
    is_focused: bool,
    show_diff: bool,
    width: int,
):
    """변경 항목 카드 렌더링"""
    # 포커스 표시
    focus_indicator = colorize("▶ ", Color.YELLOW, Color.BOLD) if is_focused else "  "

    # 토글 상태
    toggle = (
        colorize("[✓]", Color.GREEN, Color.BOLD)
        if item.selected
        else colorize("[ ]", Color.DIM)
    )

    # 타입 레이블
    type_label = item.type_label()

    # 경로 (길면 축약)
    path_max = width - 30
    path_str = item.path
    if len(path_str) > path_max:
        path_str = "..." + path_str[-(path_max - 3):]

    path_colored = colorize(path_str, item.type_color(), Color.BOLD)

    # 카드 상단 줄
    print(f"{focus_indicator}{toggle} {type_label} {path_colored}")

    # 설명
    desc_indent = "      "
    desc_lines = textwrap.wrap(item.description, width - len(desc_indent))
    for line in desc_lines:
        print(colorize(f"{desc_indent}{line}", Color.DIM))

    # diff 뷰 (펼침 시)
    if show_diff and is_focused:
        diff_lines = item.get_diff_lines()
        if diff_lines:
            print(colorize(f"      {'─' * (width - 6)}", Color.DIM))
            for line in diff_lines[:40]:  # 최대 40줄
                if line.startswith("+++") or line.startswith("---"):
                    print(colorize(f"      {line}", Color.BOLD))
                elif line.startswith("+"):
                    print(colorize(f"      {line}", Color.GREEN))
                elif line.startswith("-"):
                    print(colorize(f"      {line}", Color.RED))
                elif line.startswith("@@"):
                    print(colorize(f"      {line}", Color.CYAN))
                else:
                    print(colorize(f"      {line}", Color.DIM))
            if len(diff_lines) > 40:
                print(colorize(f"      ... (총 {len(diff_lines)}줄, 40줄만 표시)", Color.DIM))
            print(colorize(f"      {'─' * (width - 6)}", Color.DIM))
        else:
            print(colorize("      [diff 없음]", Color.DIM))

    print()


def render_footer(
    report: Report,
    focused_idx: int,
    show_diff: bool,
    width: int,
):
    selected_count = sum(1 for c in report.changes if c.selected)
    total_count = len(report.changes)

    print(colorize("─" * width, Color.DIM))

    # 상태 줄
    status = (
        f"  {focused_idx + 1}/{total_count} 항목  |  "
        f"선택: {colorize(str(selected_count), Color.GREEN, Color.BOLD)}/{total_count}  |  "
        f"diff: {'ON' if show_diff else 'OFF'}"
    )
    print(status)

    # 키 도움말
    keys = (
        colorize("Space", Color.YELLOW) + "/Enter=토글  " +
        colorize("j/k", Color.YELLOW) + "=이동  " +
        colorize("a", Color.YELLOW) + "=전체선택  " +
        colorize("n", Color.YELLOW) + "=전체해제  " +
        colorize("d", Color.YELLOW) + "=diff  " +
        colorize("A", Color.GREEN, Color.BOLD) + "=Apply  " +
        colorize("q", Color.RED) + "=종료"
    )
    print(f"  {keys}")
    print(colorize("─" * width, Color.DIM))


def render_report(
    report: Report,
    focused_idx: int,
    show_diff: bool,
    width: int,
):
    clear_screen()
    render_header(report, width)
    print()

    if not report.changes:
        print(colorize("  변경사항이 없습니다.", Color.DIM))
    else:
        for i, item in enumerate(report.changes):
            render_change_card(
                item,
                index=i,
                is_focused=(i == focused_idx),
                show_diff=show_diff,
                width=width,
            )

    render_footer(report, focused_idx, show_diff, width)


# ─── 인터랙티브 루프 ─────────────────────────────────────────────────────────

def run_interactive(report: Report) -> tuple[list[ChangeItem], bool]:
    """
    인터랙티브 TUI를 실행합니다.

    Returns:
        (selected_changes, applied)
        selected_changes: 사용자가 선택한 변경 항목 목록
        applied: Apply를 눌렀으면 True, q로 종료하면 False
    """
    if not sys.stdin.isatty():
        # 비인터랙티브 환경에서는 전체 선택 후 바로 반환
        return report.selected_changes(), False

    focused_idx = 0
    show_diff = False
    width = get_terminal_width()

    while True:
        if report.changes:
            focused_idx = max(0, min(focused_idx, len(report.changes) - 1))

        render_report(report, focused_idx, show_diff, width)

        key = getch()

        if key in (" ", "\r", "\n") and report.changes:
            # 토글
            report.changes[focused_idx].selected = not report.changes[focused_idx].selected
        elif key in ("j", "ARROW_B"):
            # 다음 항목
            focused_idx = min(focused_idx + 1, len(report.changes) - 1)
        elif key in ("k", "ARROW_A"):
            # 이전 항목
            focused_idx = max(focused_idx - 1, 0)
        elif key == "a":
            # 전체 선택
            for c in report.changes:
                c.selected = True
        elif key == "n":
            # 전체 해제
            for c in report.changes:
                c.selected = False
        elif key == "d":
            # diff 토글
            show_diff = not show_diff
        elif key == "A":
            # Apply
            clear_screen()
            return report.selected_changes(), True
        elif key in ("q", "\x03"):  # q 또는 Ctrl+C
            clear_screen()
            return report.selected_changes(), False
        elif key == "r":
            # 터미널 크기 갱신
            width = get_terminal_width()


# ─── Apply 실행기 ─────────────────────────────────────────────────────────────

def apply_changes(changes: list[ChangeItem]) -> dict:
    """
    선택된 변경사항을 실제로 파일 시스템에 적용합니다.

    지원하는 change_type:
      - added   : new_content를 path에 씀
      - modified: new_content를 path에 씀
      - deleted : path 파일 삭제
      - config  : metadata["apply_script"] 실행 (선택적)

    Returns:
        {"success": [...], "failed": [...]}
    """
    results = {"success": [], "failed": []}

    for change in changes:
        try:
            path = Path(change.path)

            if change.change_type in ("added", "modified"):
                if change.new_content is not None:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(change.new_content, encoding="utf-8")
                    results["success"].append(change.path)
                else:
                    results["failed"].append((change.path, "new_content가 없음"))

            elif change.change_type == "deleted":
                if path.exists():
                    path.unlink()
                results["success"].append(change.path)

            elif change.change_type == "config":
                script = change.metadata.get("apply_script")
                if script:
                    ret = subprocess.run(
                        script, shell=True, capture_output=True, text=True
                    )
                    if ret.returncode == 0:
                        results["success"].append(change.path)
                    else:
                        results["failed"].append((change.path, ret.stderr.strip()))
                else:
                    # apply_script 없으면 성공으로 처리 (수동 적용 필요)
                    results["success"].append(change.path)

        except Exception as e:
            results["failed"].append((change.path, str(e)))

    return results


def print_apply_result(results: dict, selected: list[ChangeItem]):
    """Apply 결과를 출력합니다."""
    width = get_terminal_width()
    print(colorize("=" * width, Color.GREEN))
    print(colorize("  Apply 결과", Color.BOLD, Color.GREEN))
    print(colorize("=" * width, Color.GREEN))

    if results["success"]:
        print(colorize(f"\n  ✓ 성공 ({len(results['success'])}개):", Color.GREEN, Color.BOLD))
        for p in results["success"]:
            print(colorize(f"    • {p}", Color.GREEN))

    if results["failed"]:
        print(colorize(f"\n  ✗ 실패 ({len(results['failed'])}개):", Color.RED, Color.BOLD))
        for p, reason in results["failed"]:
            print(colorize(f"    • {p}", Color.RED))
            print(colorize(f"      이유: {reason}", Color.DIM))

    if not results["success"] and not results["failed"]:
        print(colorize("\n  변경사항이 없습니다.", Color.DIM))

    print()


# ─── 히스토리 열람 ──────────────────────────────────────────────────────────

def show_history():
    """저장된 리포트 히스토리를 표시합니다."""
    reports = list_reports()
    width = get_terminal_width()

    if not reports:
        print(colorize("  저장된 리포트가 없습니다.", Color.DIM))
        print(colorize(f"  위치: {REPORTS_DIR}", Color.DIM))
        return

    print(colorize("=" * width, Color.CYAN))
    print(colorize("  리포트 히스토리", Color.BOLD, Color.CYAN))
    print(colorize("=" * width, Color.CYAN))
    print()

    for i, path in enumerate(reports):
        try:
            data = json.loads(path.read_text())
            created = data.get("created_at", "날짜 없음")
            summary = data.get("task_summary", "요약 없음")
            changes = data.get("changes", [])
            change_count = len(changes)

            print(colorize(f"  [{i + 1}] {path.name}", Color.BOLD))
            print(colorize(f"      날짜: {created}", Color.DIM))
            print(colorize(f"      요약: {summary[:60]}{'...' if len(summary) > 60 else ''}", Color.WHITE))
            print(colorize(f"      변경: {change_count}개", Color.YELLOW))
            print()
        except Exception as e:
            print(colorize(f"  [{i + 1}] {path.name} (읽기 실패: {e})", Color.RED))

    print(colorize(f"  총 {len(reports)}개 리포트  |  위치: {REPORTS_DIR}", Color.DIM))

    # 선택 입력
    if sys.stdin.isatty():
        print()
        print(colorize("  번호를 입력하면 해당 리포트를 열람합니다. (Enter=종료): ", Color.YELLOW), end="", flush=True)
        try:
            raw = input().strip()
            if raw.isdigit():
                idx = int(raw) - 1
                if 0 <= idx < len(reports):
                    report = load_report(reports[idx])
                    selected, applied = run_interactive(report)
                    if applied:
                        results = apply_changes(selected)
                        print_apply_result(results, selected)
                        # 적용 후 리포트 업데이트
                        report.save(reports[idx])
        except (KeyboardInterrupt, EOFError):
            pass


# ─── 리포트 생성 헬퍼 ────────────────────────────────────────────────────────

def create_report(
    task_summary: str,
    changes: list[dict],
    report_id: str = "",
    metadata: dict = None,
    save: bool = True,
) -> tuple[Report, Path]:
    """
    리포트 객체를 생성하고 저장합니다.

    Args:
        task_summary: 작업 요약
        changes: 변경 항목 딕셔너리 목록
            각 항목:
              - change_type: "added" | "modified" | "deleted" | "config"
              - path: 파일 경로 또는 설정 키
              - description: 변경 설명
              - old_content: (선택) 이전 내용
              - new_content: (선택) 새 내용
              - metadata: (선택) 추가 정보
        report_id: 리포트 식별자 (없으면 자동 생성)
        metadata: 리포트 수준 메타데이터
        save: True면 .tmp/reports/에 저장

    Returns:
        (report, saved_path)
    """
    import uuid
    rid = report_id or uuid.uuid4().hex[:8]
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    change_items = []
    for i, c in enumerate(changes):
        change_items.append(ChangeItem(
            id=c.get("id", f"change_{i}"),
            change_type=c.get("change_type", "modified"),
            path=c.get("path", ""),
            description=c.get("description", ""),
            old_content=c.get("old_content"),
            new_content=c.get("new_content"),
            metadata=c.get("metadata", {}),
            selected=c.get("selected", True),
        ))

    report = Report(
        report_id=rid,
        task_summary=task_summary,
        created_at=now,
        changes=change_items,
        metadata=metadata or {},
    )

    saved_path = None
    if save:
        saved_path = report.save()

    return report, saved_path


# ─── 비인터랙티브 출력 ──────────────────────────────────────────────────────

def print_report_summary(report: Report):
    """터미널에 리포트 요약을 출력합니다 (비인터랙티브)."""
    width = get_terminal_width()
    print(colorize("=" * width, Color.CYAN))
    print(colorize(f"  작업 결과 리포트  |  {report.created_at}", Color.BOLD, Color.CYAN))
    print(colorize(f"  {report.task_summary}", Color.WHITE))
    print(colorize("=" * width, Color.CYAN))
    print()

    if not report.changes:
        print(colorize("  변경사항 없음", Color.DIM))
        return

    for i, item in enumerate(report.changes):
        toggle = colorize("[✓]", Color.GREEN, Color.BOLD) if item.selected else colorize("[ ]", Color.DIM)
        type_label = item.type_label()
        path_colored = colorize(item.path, item.type_color(), Color.BOLD)
        print(f"  {toggle} {type_label} {path_colored}")
        print(colorize(f"       {item.description}", Color.DIM))

    print()
    selected = sum(1 for c in report.changes if c.selected)
    print(colorize(f"  총 {len(report.changes)}개 변경, {selected}개 선택됨", Color.YELLOW))
    print()


# ─── CLI 진입점 ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="작업 결과 리포트 TUI 시스템",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--report", "-r", help="표시할 리포트 JSON 파일 경로")
    group.add_argument("--history", "-H", action="store_true", help="리포트 히스토리 열람")
    group.add_argument("--changes", "-c", help="변경사항 JSON 파일로 리포트 생성 및 표시")
    group.add_argument("--demo", action="store_true", help="데모 리포트 표시")

    parser.add_argument("--summary", "-s", default="작업이 완료되었습니다.", help="리포트 요약 (--changes와 함께 사용)")
    parser.add_argument("--no-interactive", action="store_true", help="비인터랙티브 모드 (요약만 출력)")
    parser.add_argument("--auto-apply", action="store_true", help="인터랙션 없이 선택된 항목 자동 적용")

    args = parser.parse_args()

    if args.history:
        show_history()
        return

    if args.demo:
        report, saved = _create_demo_report()
        print(colorize(f"  데모 리포트: {saved}", Color.DIM))
        print()
        if args.no_interactive:
            print_report_summary(report)
        else:
            selected, applied = run_interactive(report)
            if applied:
                results = apply_changes(selected)
                print_apply_result(results, selected)
        return

    if args.changes:
        changes_path = Path(args.changes)
        if not changes_path.exists():
            print(colorize(f"오류: {args.changes} 파일이 없습니다.", Color.RED), file=sys.stderr)
            sys.exit(1)
        changes_data = json.loads(changes_path.read_text())
        if isinstance(changes_data, list):
            changes = changes_data
        else:
            changes = changes_data.get("changes", [])
        report, saved = create_report(args.summary, changes)
        print(colorize(f"  리포트 저장: {saved}", Color.DIM))
    elif args.report:
        report_path = Path(args.report)
        if not report_path.exists():
            print(colorize(f"오류: {args.report} 파일이 없습니다.", Color.RED), file=sys.stderr)
            sys.exit(1)
        report = load_report(report_path)
    else:
        parser.print_help()
        return

    if args.no_interactive:
        print_report_summary(report)
    elif args.auto_apply:
        results = apply_changes(report.selected_changes())
        print_apply_result(results, report.selected_changes())
    else:
        selected, applied = run_interactive(report)
        if applied:
            results = apply_changes(selected)
            print_apply_result(results, selected)
            # 리포트 선택 상태 업데이트 저장
            if args.report:
                report.save(Path(args.report))
        else:
            print(colorize("  종료 (변경사항 미적용)", Color.DIM))


def _create_demo_report() -> tuple[Report, Path]:
    """데모용 리포트 생성"""
    old_config = '{\n  "version": "1.0",\n  "debug": false\n}\n'
    new_config = '{\n  "version": "1.1",\n  "debug": true,\n  "log_level": "INFO"\n}\n'

    old_script = '#!/usr/bin/env python3\nprint("Hello")\n'
    new_script = '#!/usr/bin/env python3\n"""Updated script"""\nprint("Hello, World!")\nprint("Version 2")\n'

    changes = [
        {
            "change_type": "modified",
            "path": "config/settings.json",
            "description": "버전을 1.0에서 1.1로 업그레이드하고 디버그 모드 활성화, 로그 레벨 추가",
            "old_content": old_config,
            "new_content": new_config,
        },
        {
            "change_type": "added",
            "path": "execution/new_feature.py",
            "description": "새로운 기능을 처리하는 스크립트 추가",
            "old_content": None,
            "new_content": new_script,
        },
        {
            "change_type": "deleted",
            "path": ".tmp/old_cache.json",
            "description": "더 이상 사용하지 않는 캐시 파일 제거",
            "old_content": '{"stale": true}',
            "new_content": None,
        },
        {
            "change_type": "config",
            "path": "ENV: DATABASE_URL",
            "description": "데이터베이스 연결 URL을 새 서버로 업데이트",
            "metadata": {"apply_script": "echo 'DB URL updated'"},
        },
    ]

    return create_report(
        task_summary="데모: 시스템 업그레이드 및 신규 기능 추가 작업 완료",
        changes=changes,
        report_id="demo0001",
    )


if __name__ == "__main__":
    main()
