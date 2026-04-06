#!/usr/bin/env python3
"""
프로젝트 관리 스크립트
- 등록된 프로젝트 목록 조회
- 프로젝트 상태 확인
- 새 프로젝트 등록
"""

import os
import json
import subprocess
from pathlib import Path
from datetime import datetime

# 프로젝트 레지스트리
PROJECTS = {
    "palmoni": {
        "name": "Palmoni 기도앱",
        "path": "/Users/sun/palmoni",
        "github": "sun2141/palmoni",
        "deploy_url": "https://palmoni.vercel.app",
        "health_check": "/api/test",
        "active": True
    },
    "facepick": {
        "name": "FacePick",
        "path": "/Users/sun/facepick",
        "github": None,
        "deploy_url": None,
        "active": False
    },
    "reddit-insight": {
        "name": "Reddit Insight",
        "path": "/Users/sun/reddit-insight",
        "github": None,
        "deploy_url": None,
        "active": False
    }
}

AGENT_HUB_PATH = Path("/Users/sun/agent-hub")


def list_projects():
    """등록된 프로젝트 목록 출력"""
    print("\n=== 등록된 프로젝트 ===\n")

    for pid, info in PROJECTS.items():
        status = "✅ Active" if info["active"] else "⏸️  Inactive"
        exists = "📁" if Path(info["path"]).exists() else "❌"

        print(f"{exists} [{pid}] {info['name']}")
        print(f"   경로: {info['path']}")
        print(f"   GitHub: {info['github'] or '-'}")
        print(f"   배포: {info['deploy_url'] or '-'}")
        print(f"   상태: {status}")
        print()


def check_project_status(project_id: str):
    """특정 프로젝트 상태 확인"""
    if project_id not in PROJECTS:
        print(f"❌ 프로젝트 '{project_id}'를 찾을 수 없습니다.")
        return None

    info = PROJECTS[project_id]
    path = Path(info["path"])

    status = {
        "id": project_id,
        "name": info["name"],
        "exists": path.exists(),
        "has_claude_md": (path / "CLAUDE.md").exists() if path.exists() else False,
        "has_git": (path / ".git").exists() if path.exists() else False,
        "last_modified": None,
        "git_status": None
    }

    if path.exists():
        # 마지막 수정 시간
        stat = path.stat()
        status["last_modified"] = datetime.fromtimestamp(stat.st_mtime).isoformat()

        # Git 상태
        if status["has_git"]:
            try:
                result = subprocess.run(
                    ["git", "status", "--porcelain"],
                    cwd=path,
                    capture_output=True,
                    text=True
                )
                changes = len(result.stdout.strip().split('\n')) if result.stdout.strip() else 0
                status["git_status"] = f"{changes} uncommitted changes" if changes else "clean"
            except:
                status["git_status"] = "error"

    return status


def check_all_projects():
    """모든 프로젝트 상태 확인"""
    print("\n=== 프로젝트 상태 점검 ===\n")
    print(f"시간: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

    for pid in PROJECTS:
        status = check_project_status(pid)
        if status:
            icon = "✅" if status["exists"] and status["has_claude_md"] else "⚠️"
            print(f"{icon} {status['name']} ({pid})")
            print(f"   폴더 존재: {'예' if status['exists'] else '아니오'}")
            print(f"   CLAUDE.md: {'있음' if status['has_claude_md'] else '없음'}")
            print(f"   Git: {status['git_status'] or '-'}")
            print()


def create_project_claude_md(project_id: str, **kwargs):
    """프로젝트용 CLAUDE.md 생성"""
    if project_id not in PROJECTS:
        print(f"❌ 프로젝트 '{project_id}'를 찾을 수 없습니다.")
        return False

    info = PROJECTS[project_id]
    path = Path(info["path"])

    if not path.exists():
        print(f"❌ 프로젝트 폴더가 존재하지 않습니다: {path}")
        return False

    template_path = AGENT_HUB_PATH / "directives/templates/project_claude_md.md"

    if not template_path.exists():
        print("❌ 템플릿 파일을 찾을 수 없습니다.")
        return False

    # 템플릿 읽기
    template = template_path.read_text()

    # 기본값 설정
    defaults = {
        "PROJECT_NAME": info["name"],
        "PROJECT_ID": project_id,
        "PROJECT_DESCRIPTION": kwargs.get("description", "프로젝트 설명"),
        "TECH_STACK": kwargs.get("tech_stack", "TBD"),
        "DEPLOYMENT_INFO": info["deploy_url"] or "TBD",
        "PROJECT_FOCUS": kwargs.get("focus", "기능 개발"),
        "DEPLOYMENT_CONSIDERATIONS": kwargs.get("deployment_notes", "배포 환경 확인"),
        "GITHUB_REPO": info["github"] or "TBD",
        "BRANCH_STRATEGY": kwargs.get("branch_strategy", "main (production)")
    }

    # 템플릿 변수 치환
    content = template
    for key, value in defaults.items():
        content = content.replace(f"{{{key}}}", value)

    # 파일 저장
    output_path = path / "CLAUDE.md"
    output_path.write_text(content)

    print(f"✅ CLAUDE.md 생성 완료: {output_path}")
    return True


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("사용법:")
        print("  python project_manager.py list          # 프로젝트 목록")
        print("  python project_manager.py status        # 전체 상태 점검")
        print("  python project_manager.py check <id>    # 특정 프로젝트 상태")
        print("  python project_manager.py init <id>     # CLAUDE.md 생성")
        sys.exit(1)

    command = sys.argv[1]

    if command == "list":
        list_projects()
    elif command == "status":
        check_all_projects()
    elif command == "check" and len(sys.argv) > 2:
        status = check_project_status(sys.argv[2])
        if status:
            print(json.dumps(status, indent=2, ensure_ascii=False))
    elif command == "init" and len(sys.argv) > 2:
        create_project_claude_md(sys.argv[2])
    else:
        print("알 수 없는 명령어입니다.")
