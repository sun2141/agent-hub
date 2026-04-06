#!/usr/bin/env python3
"""
Design Agent for Palmoni
VPS에서 실행되어 Telegram을 통해 디자인 작업을 수행

사용법:
  python design_agent.py process "버튼 색상 변경"
  python design_agent.py preview "LoginModal"
  python design_agent.py apply design_001
  python design_agent.py status
"""

import os
import sys
import json
import shutil
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
import re


@dataclass
class DesignRequest:
    """디자인 요청"""
    request_id: str
    description: str
    status: str  # pending, analyzing, draft_ready, approved, applied, rejected
    target_files: List[str]
    changes: List[Dict]
    created_at: str
    updated_at: str
    error: Optional[str] = None


class DesignAgent:
    """디자인 에이전트 - CSS/컴포넌트 수정 담당"""

    def __init__(self, project_path: str = None):
        # 환경변수 또는 기본값 사용
        if project_path is None:
            project_path = os.environ.get("PALMONI_PATH", "/home/agent/workspace/palmoni")

        self.project_path = Path(project_path)
        self.workspace = self.project_path.parent  # palmoni의 부모 디렉토리
        self.tmp_dir = self.workspace / ".tmp" / "design_drafts"
        self.state_file = self.workspace / ".tmp" / "design_state.json"

        # 디렉토리 생성
        self.tmp_dir.mkdir(parents=True, exist_ok=True)

        # 상태 로드
        self.state = self._load_state()

        # 컴포넌트 매핑
        self.component_map = self._build_component_map()

    def _load_state(self) -> Dict:
        """상태 파일 로드"""
        if self.state_file.exists():
            with open(self.state_file) as f:
                return json.load(f)
        return {
            "current_request": None,
            "history": [],
            "last_sync": None,
            "counter": 0
        }

    def _save_state(self):
        """상태 저장"""
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        with open(self.state_file, 'w') as f:
            json.dump(self.state, f, indent=2, ensure_ascii=False)

    def _build_component_map(self) -> Dict[str, List[Path]]:
        """컴포넌트 이름 → 파일 경로 매핑 구축"""
        comp_map = {}
        src_dir = self.project_path / "src"

        if not src_dir.exists():
            return comp_map

        # JSX/CSS 파일 탐색
        for ext in ['jsx', 'css', 'tsx']:
            for file in src_dir.rglob(f'*.{ext}'):
                name = file.stem.lower()
                if name not in comp_map:
                    comp_map[name] = []
                comp_map[name].append(file)

                # 별칭 추가 (CamelCase → 소문자)
                # LoginModal → loginmodal, login-modal, login_modal
                kebab = re.sub(r'(?<!^)(?=[A-Z])', '-', file.stem).lower()
                snake = re.sub(r'(?<!^)(?=[A-Z])', '_', file.stem).lower()
                for alias in [kebab, snake]:
                    if alias not in comp_map:
                        comp_map[alias] = []
                    if file not in comp_map[alias]:
                        comp_map[alias].append(file)

        return comp_map

    def _generate_request_id(self) -> str:
        """고유 요청 ID 생성"""
        self.state["counter"] += 1
        self._save_state()
        return f"design_{self.state['counter']:03d}"

    def _find_target_files(self, description: str) -> List[Path]:
        """설명에서 대상 파일 추출"""
        targets = []
        desc_lower = description.lower()

        # 키워드 매칭
        keywords = {
            "로그인": ["loginmodal", "login"],
            "홈": ["home"],
            "가격": ["pricing"],
            "기도": ["prayer", "prayercard", "prayerdashboard"],
            "버튼": ["button"],
            "모달": ["modal"],
            "헤더": ["header", "navigation", "nav"],
            "푸터": ["footer"],
            "카드": ["card"],
            "pdf": ["pdf", "prayerpdfdocument"],
        }

        for keyword, components in keywords.items():
            if keyword in desc_lower:
                for comp in components:
                    if comp in self.component_map:
                        targets.extend(self.component_map[comp])

        # 컴포넌트 이름 직접 매칭
        for comp_name, files in self.component_map.items():
            if comp_name in desc_lower:
                targets.extend(files)

        # 중복 제거
        return list(set(targets))

    def _analyze_css_changes(self, description: str, css_file: Path) -> List[Dict]:
        """CSS 변경 분석"""
        changes = []
        desc_lower = description.lower()

        if not css_file.exists():
            return changes

        content = css_file.read_text()

        # 둥글게 → border-radius 증가
        if "둥글" in desc_lower or "radius" in desc_lower:
            changes.append({
                "type": "border-radius",
                "description": "border-radius 값 증가",
                "suggestion": "16px → 24px 또는 var(--radius-lg)"
            })

        # 애니메이션 → transition 추가
        if "애니메이션" in desc_lower or "부드럽" in desc_lower or "호버" in desc_lower:
            changes.append({
                "type": "transition",
                "description": "transition 효과 추가/개선",
                "suggestion": "transition: all 200ms ease-out"
            })

        # 그림자 → box-shadow
        if "그림자" in desc_lower or "shadow" in desc_lower:
            changes.append({
                "type": "box-shadow",
                "description": "box-shadow 효과 추가",
                "suggestion": "box-shadow: 0 4px 12px rgba(0,0,0,0.1)"
            })

        # 색상 변경
        if "색상" in desc_lower or "컬러" in desc_lower or "color" in desc_lower:
            changes.append({
                "type": "color",
                "description": "색상 값 변경",
                "suggestion": "var(--accent) 또는 지정된 색상"
            })

        # 간격
        if "간격" in desc_lower or "padding" in desc_lower or "margin" in desc_lower:
            changes.append({
                "type": "spacing",
                "description": "padding/margin 조정",
                "suggestion": "var(--space-md) 등 사용"
            })

        # 그라데이션
        if "그라데이션" in desc_lower or "gradient" in desc_lower:
            changes.append({
                "type": "gradient",
                "description": "그라데이션 배경 추가",
                "suggestion": "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
            })

        return changes

    def process_request(self, description: str) -> Dict:
        """디자인 요청 처리"""
        request_id = self._generate_request_id()

        # 대상 파일 찾기
        target_files = self._find_target_files(description)

        if not target_files:
            return {
                "success": False,
                "error": "대상 컴포넌트를 찾을 수 없습니다",
                "suggestion": "컴포넌트 이름을 명시해주세요 (예: LoginModal, Home, Pricing)"
            }

        # CSS 파일만 필터링
        css_files = [f for f in target_files if f.suffix == '.css']
        jsx_files = [f for f in target_files if f.suffix in ['.jsx', '.tsx']]

        # 변경사항 분석
        all_changes = []
        for css_file in css_files:
            changes = self._analyze_css_changes(description, css_file)
            if changes:
                all_changes.append({
                    "file": str(css_file.relative_to(self.project_path)),
                    "changes": changes
                })

        # Draft 디렉토리 생성
        draft_dir = self.tmp_dir / request_id
        draft_dir.mkdir(parents=True, exist_ok=True)
        (draft_dir / "original").mkdir(exist_ok=True)
        (draft_dir / "modified").mkdir(exist_ok=True)

        # 원본 파일 백업
        for f in target_files:
            if f.exists():
                rel_path = f.relative_to(self.project_path)
                backup_path = draft_dir / "original" / rel_path
                backup_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, backup_path)

        # 요청 정보 저장
        request = DesignRequest(
            request_id=request_id,
            description=description,
            status="draft_ready",
            target_files=[str(f.relative_to(self.project_path)) for f in target_files],
            changes=all_changes,
            created_at=datetime.now().isoformat(),
            updated_at=datetime.now().isoformat()
        )

        # 요청 파일 저장
        request_file = draft_dir / "request.json"
        with open(request_file, 'w') as f:
            json.dump(asdict(request), f, indent=2, ensure_ascii=False)

        # 상태 업데이트
        self.state["current_request"] = request_id
        self.state["history"].append({
            "id": request_id,
            "description": description,
            "status": "draft_ready",
            "created_at": request.created_at
        })
        self._save_state()

        return {
            "success": True,
            "request_id": request_id,
            "target_files": [str(f.relative_to(self.project_path)) for f in target_files],
            "changes": all_changes,
            "message": self._format_telegram_message(request)
        }

    def _format_telegram_message(self, request: DesignRequest) -> str:
        """Telegram 알림 메시지 포맷"""
        msg = f"📐 디자인 변경 준비됨 #{request.request_id}\n\n"
        msg += f"📝 요청: {request.description}\n\n"
        msg += "📁 대상 파일:\n"
        for f in request.target_files[:5]:  # 최대 5개
            msg += f"  - {f}\n"
        if len(request.target_files) > 5:
            msg += f"  ... 외 {len(request.target_files) - 5}개\n"

        msg += "\n✏️ 변경 내용:\n"
        for file_change in request.changes[:3]:
            for change in file_change.get("changes", [])[:3]:
                msg += f"  - {change['description']}\n"

        msg += "\n👇 다음 단계:\n"
        msg += "/design approve - 적용\n"
        msg += "/design reject - 취소\n"
        msg += "/design compare - diff 보기"

        return msg

    def preview_component(self, component_name: str) -> Dict:
        """컴포넌트 현재 상태 분석"""
        comp_lower = component_name.lower()

        if comp_lower not in self.component_map:
            return {
                "success": False,
                "error": f"컴포넌트 '{component_name}'를 찾을 수 없습니다",
                "available": list(self.component_map.keys())[:20]
            }

        files = self.component_map[comp_lower]
        analysis = []

        for f in files:
            if f.suffix == '.css':
                content = f.read_text()
                # 주요 속성 추출
                colors = re.findall(r'#[0-9a-fA-F]{3,6}', content)
                radii = re.findall(r'border-radius:\s*([^;]+)', content)
                shadows = re.findall(r'box-shadow:\s*([^;]+)', content)

                analysis.append({
                    "file": str(f.relative_to(self.project_path)),
                    "type": "css",
                    "colors_used": list(set(colors))[:10],
                    "border_radius": list(set(radii))[:5],
                    "shadows": list(set(shadows))[:3],
                    "line_count": len(content.splitlines())
                })
            elif f.suffix in ['.jsx', '.tsx']:
                content = f.read_text()
                # 컴포넌트 구조 분석
                imports = re.findall(r"import .+ from ['\"]([^'\"]+)['\"]", content)

                analysis.append({
                    "file": str(f.relative_to(self.project_path)),
                    "type": "component",
                    "imports": imports[:10],
                    "line_count": len(content.splitlines())
                })

        return {
            "success": True,
            "component": component_name,
            "files": analysis
        }

    def approve_request(self, request_id: str = None) -> Dict:
        """요청 승인 및 적용"""
        if request_id is None:
            request_id = self.state.get("current_request")

        if not request_id:
            return {"success": False, "error": "승인할 요청이 없습니다"}

        draft_dir = self.tmp_dir / request_id
        request_file = draft_dir / "request.json"

        if not request_file.exists():
            return {"success": False, "error": f"요청 {request_id}를 찾을 수 없습니다"}

        with open(request_file) as f:
            request = json.load(f)

        # 상태 업데이트
        request["status"] = "approved"
        request["updated_at"] = datetime.now().isoformat()

        with open(request_file, 'w') as f:
            json.dump(request, f, indent=2, ensure_ascii=False)

        # 상태 히스토리 업데이트
        for h in self.state["history"]:
            if h["id"] == request_id:
                h["status"] = "approved"
        self._save_state()

        return {
            "success": True,
            "request_id": request_id,
            "status": "approved",
            "message": f"✅ #{request_id} 승인됨\n\n/design commit 으로 적용하세요"
        }

    def reject_request(self, request_id: str = None, reason: str = "") -> Dict:
        """요청 거절"""
        if request_id is None:
            request_id = self.state.get("current_request")

        if not request_id:
            return {"success": False, "error": "거절할 요청이 없습니다"}

        draft_dir = self.tmp_dir / request_id
        request_file = draft_dir / "request.json"

        if request_file.exists():
            with open(request_file) as f:
                request = json.load(f)
            request["status"] = "rejected"
            request["error"] = reason
            request["updated_at"] = datetime.now().isoformat()
            with open(request_file, 'w') as f:
                json.dump(request, f, indent=2, ensure_ascii=False)

        # 상태 업데이트
        self.state["current_request"] = None
        for h in self.state["history"]:
            if h["id"] == request_id:
                h["status"] = "rejected"
        self._save_state()

        return {
            "success": True,
            "request_id": request_id,
            "status": "rejected",
            "message": f"❌ #{request_id} 거절됨" + (f"\n이유: {reason}" if reason else "")
        }

    def get_status(self) -> Dict:
        """현재 상태 조회"""
        current = self.state.get("current_request")
        history = self.state.get("history", [])[-5:]  # 최근 5개

        status_msg = "📊 디자인 에이전트 상태\n\n"

        if current:
            status_msg += f"🔄 진행 중: #{current}\n\n"
        else:
            status_msg += "✨ 대기 중 (새 요청 가능)\n\n"

        if history:
            status_msg += "📜 최근 작업:\n"
            for h in reversed(history):
                icon = {"pending": "⏳", "draft_ready": "📝", "approved": "✅",
                        "applied": "🚀", "rejected": "❌"}.get(h["status"], "❓")
                status_msg += f"  {icon} #{h['id']}: {h['description'][:30]}...\n"

        return {
            "success": True,
            "current_request": current,
            "history": history,
            "message": status_msg
        }

    def commit_changes(self, request_id: str = None) -> Dict:
        """변경사항 커밋"""
        if request_id is None:
            request_id = self.state.get("current_request")

        if not request_id:
            return {"success": False, "error": "커밋할 요청이 없습니다"}

        draft_dir = self.tmp_dir / request_id
        request_file = draft_dir / "request.json"

        if not request_file.exists():
            return {"success": False, "error": f"요청 {request_id}를 찾을 수 없습니다"}

        with open(request_file) as f:
            request = json.load(f)

        if request["status"] != "approved":
            return {"success": False, "error": "먼저 /design approve 로 승인하세요"}

        # Modified 폴더에서 파일 적용 (현재는 원본을 그대로 사용)
        # 실제 구현에서는 Claude API를 통해 수정된 파일을 생성

        try:
            os.chdir(self.project_path)

            # Git add & commit
            subprocess.run(["git", "add", "-A"], check=True, capture_output=True)

            commit_msg = f"style: {request['description'][:50]} (#{request_id})"
            result = subprocess.run(
                ["git", "commit", "-m", commit_msg],
                capture_output=True,
                text=True
            )

            if result.returncode != 0:
                if "nothing to commit" in result.stdout:
                    return {"success": False, "error": "커밋할 변경사항이 없습니다"}
                return {"success": False, "error": result.stderr}

            # 상태 업데이트
            request["status"] = "applied"
            request["updated_at"] = datetime.now().isoformat()
            with open(request_file, 'w') as f:
                json.dump(request, f, indent=2, ensure_ascii=False)

            self.state["current_request"] = None
            for h in self.state["history"]:
                if h["id"] == request_id:
                    h["status"] = "applied"
            self._save_state()

            return {
                "success": True,
                "request_id": request_id,
                "status": "applied",
                "message": f"🚀 #{request_id} 적용 완료!\n\n커밋: {commit_msg}\n\ngit push로 배포하세요"
            }

        except subprocess.CalledProcessError as e:
            return {"success": False, "error": str(e)}


def main():
    """CLI 진입점"""
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python design_agent.py process '<description>'")
        print("  python design_agent.py preview '<component>'")
        print("  python design_agent.py approve [request_id]")
        print("  python design_agent.py reject [request_id] [reason]")
        print("  python design_agent.py commit [request_id]")
        print("  python design_agent.py status")
        sys.exit(1)

    # 프로젝트 경로 (환경에 맞게 조정)
    project_path = os.environ.get("PALMONI_PATH", "/home/sun/workspace/palmoni")

    agent = DesignAgent(project_path)
    command = sys.argv[1]

    if command == "process":
        if len(sys.argv) < 3:
            print("Error: description required")
            sys.exit(1)
        result = agent.process_request(sys.argv[2])

    elif command == "preview":
        if len(sys.argv) < 3:
            print("Error: component name required")
            sys.exit(1)
        result = agent.preview_component(sys.argv[2])

    elif command == "approve":
        request_id = sys.argv[2] if len(sys.argv) > 2 else None
        result = agent.approve_request(request_id)

    elif command == "reject":
        request_id = sys.argv[2] if len(sys.argv) > 2 else None
        reason = sys.argv[3] if len(sys.argv) > 3 else ""
        result = agent.reject_request(request_id, reason)

    elif command == "commit":
        request_id = sys.argv[2] if len(sys.argv) > 2 else None
        result = agent.commit_changes(request_id)

    elif command == "status":
        result = agent.get_status()

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)

    # 결과 출력
    print(json.dumps(result, indent=2, ensure_ascii=False))

    # Telegram 메시지가 있으면 별도 출력
    if result.get("message"):
        print("\n--- Telegram Message ---")
        print(result["message"])


if __name__ == "__main__":
    main()
