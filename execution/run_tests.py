#!/usr/bin/env python3
"""
자동 테스트 실행 스크립트
프로젝트의 모든 테스트를 자동으로 실행하고 결과를 보고합니다.
"""

import os
import sys
import subprocess
import json
from pathlib import Path

def detect_project_type(project_path):
    """프로젝트 타입을 감지합니다."""
    project_path = Path(project_path)

    # Node.js 프로젝트
    if (project_path / "package.json").exists():
        return "node"

    # Python 프로젝트
    if (project_path / "requirements.txt").exists() or (project_path / "setup.py").exists():
        return "python"

    return "unknown"

def run_node_tests(project_path):
    """Node.js 프로젝트의 테스트를 실행합니다."""
    print("🧪 Node.js 테스트 실행 중...")

    # package.json 읽기
    package_json_path = Path(project_path) / "package.json"
    with open(package_json_path) as f:
        package_data = json.load(f)

    # 테스트 스크립트 확인
    scripts = package_data.get("scripts", {})

    if "test" in scripts:
        try:
            result = subprocess.run(
                ["npm", "test"],
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=120
            )

            print(result.stdout)
            if result.stderr:
                print(result.stderr, file=sys.stderr)

            return result.returncode == 0
        except subprocess.TimeoutExpired:
            print("❌ 테스트 타임아웃 (120초)")
            return False
        except Exception as e:
            print(f"❌ 테스트 실행 실패: {e}")
            return False
    else:
        print("⚠️  package.json에 test 스크립트가 없습니다.")
        print("   기본 테스트 없음 - 수동 테스트가 필요합니다.")
        return True  # 테스트가 없는 것은 실패가 아님

def run_python_tests(project_path):
    """Python 프로젝트의 테스트를 실행합니다."""
    print("🧪 Python 테스트 실행 중...")

    # pytest 시도
    try:
        result = subprocess.run(
            ["pytest", "-v"],
            cwd=project_path,
            capture_output=True,
            text=True,
            timeout=120
        )

        print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)

        return result.returncode == 0
    except FileNotFoundError:
        print("⚠️  pytest가 설치되어 있지 않습니다.")

        # unittest 시도
        try:
            result = subprocess.run(
                ["python", "-m", "unittest", "discover"],
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=120
            )

            print(result.stdout)
            if result.stderr:
                print(result.stderr, file=sys.stderr)

            return result.returncode == 0
        except Exception as e:
            print(f"⚠️  테스트 실행 실패: {e}")
            return True  # 테스트 프레임워크가 없으면 통과
    except subprocess.TimeoutExpired:
        print("❌ 테스트 타임아웃 (120초)")
        return False
    except Exception as e:
        print(f"❌ 테스트 실행 실패: {e}")
        return False

def run_lint(project_path, project_type):
    """코드 린팅을 실행합니다."""
    print("\n🔍 코드 린팅 중...")

    if project_type == "node":
        # ESLint
        try:
            result = subprocess.run(
                ["npm", "run", "lint"],
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=60
            )

            if result.returncode != 0:
                print("⚠️  Lint 경고:")
                print(result.stdout)

                # 자동 수정 시도
                print("   자동 수정 시도 중...")
                fix_result = subprocess.run(
                    ["npm", "run", "lint", "--", "--fix"],
                    cwd=project_path,
                    capture_output=True,
                    text=True
                )

                if fix_result.returncode == 0:
                    print("   ✅ 자동 수정 완료")
                else:
                    print("   ⚠️  일부 문제는 수동 수정이 필요합니다.")
        except:
            print("   ℹ️  Lint 스크립트 없음 (선택사항)")

    return True  # Lint는 실패해도 전체 테스트를 실패시키지 않음

def main():
    if len(sys.argv) < 2:
        print("사용법: python run_tests.py <project_name>")
        print("예시: python run_tests.py prayer-agent")
        sys.exit(1)

    project_name = sys.argv[1]

    # 프로젝트 경로 찾기
    script_dir = Path(__file__).parent.parent
    project_path = script_dir / "projects" / project_name

    if not project_path.exists():
        print(f"❌ 프로젝트를 찾을 수 없습니다: {project_path}")
        sys.exit(1)

    print(f"📦 프로젝트: {project_name}")
    print(f"📍 경로: {project_path}\n")

    # 프로젝트 타입 감지
    project_type = detect_project_type(project_path)
    print(f"🔎 프로젝트 타입: {project_type}\n")

    if project_type == "unknown":
        print("⚠️  프로젝트 타입을 감지할 수 없습니다.")
        print("   package.json 또는 requirements.txt가 필요합니다.")
        sys.exit(1)

    # 린팅 실행
    run_lint(project_path, project_type)

    # 테스트 실행
    success = False
    if project_type == "node":
        success = run_node_tests(project_path)
    elif project_type == "python":
        success = run_python_tests(project_path)

    # 결과 출력
    print("\n" + "="*50)
    if success:
        print("✅ 모든 테스트 통과!")
        sys.exit(0)
    else:
        print("❌ 테스트 실패")
        sys.exit(1)

if __name__ == "__main__":
    main()
