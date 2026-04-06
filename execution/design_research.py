#!/usr/bin/env python3
"""
Design Research Agent
- 디자인 트렌드 검색 및 분석
- 경쟁 앱/사이트 디자인 비교
- AI 기반 시안 생성 및 제안

사용법:
  python design_research.py search "기도앱 UI 트렌드"
  python design_research.py compare "Calm Headspace Pray.com"
  python design_research.py draft "홈페이지 히어로 섹션"
  python design_research.py present <draft_id>
"""

import os
import sys
import json
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
import subprocess

# Google AI (Gemini) 사용
try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False


@dataclass
class DesignDraft:
    """디자인 시안"""
    draft_id: str
    title: str
    description: str
    target_component: str
    research_summary: str
    design_proposal: Dict
    css_changes: List[Dict]
    status: str  # researching, draft, pending_review, approved, rejected
    created_at: str
    updated_at: str
    user_feedback: Optional[str] = None


class DesignResearchAgent:
    """디자인 리서치 및 시안 생성 에이전트"""

    def __init__(self):
        self.workspace = Path("/Users/sun/agent-hub")
        self.palmoni_path = Path("/Users/sun/palmoni")
        self.drafts_dir = self.workspace / ".tmp" / "design_research"
        self.drafts_dir.mkdir(parents=True, exist_ok=True)

        # Gemini 설정
        self.gemini_key = os.environ.get("GEMINI_API_KEY")
        if GEMINI_AVAILABLE and self.gemini_key:
            genai.configure(api_key=self.gemini_key)
            self.model = genai.GenerativeModel('gemini-1.5-flash')
        else:
            self.model = None

        # 디자인 레퍼런스 DB
        self.design_references = {
            "prayer_apps": {
                "Pray.com": {
                    "style": "미니멀, 따뜻한 톤, 부드러운 그라데이션",
                    "colors": ["#4A90A4", "#F5E6D3", "#2C3E50"],
                    "features": ["다크모드", "음성 기도", "커뮤니티"],
                    "url": "https://pray.com"
                },
                "Hallow": {
                    "style": "클래식, 고급스러움, 다크 테마 중심",
                    "colors": ["#1A1A2E", "#E8D5B7", "#C9A227"],
                    "features": ["명상", "성경 읽기", "오디오"],
                    "url": "https://hallow.com"
                },
                "Abide": {
                    "style": "밝고 친근함, 파스텔 톤",
                    "colors": ["#6B8E9F", "#F0E6D8", "#3D5A73"],
                    "features": ["수면 도우미", "기도 가이드"],
                    "url": "https://abide.com"
                }
            },
            "meditation_apps": {
                "Calm": {
                    "style": "자연스러운, 평화로운, 블루 그린 톤",
                    "colors": ["#92C9D3", "#3B6B7F", "#F5F5F5"],
                    "features": ["배경 사운드", "스토리", "호흡 운동"]
                },
                "Headspace": {
                    "style": "밝고 친근한, 일러스트 중심",
                    "colors": ["#FF8674", "#FFC4B8", "#2D4059"],
                    "features": ["애니메이션", "트래킹", "코스"]
                }
            },
            "design_trends_2026": {
                "glassmorphism": "반투명 유리 효과, backdrop-filter 사용",
                "neumorphism": "소프트 그림자, 입체감",
                "gradients": "그라데이션 배경, mesh gradient",
                "micro_interactions": "섬세한 hover 효과, 로딩 애니메이션",
                "dark_mode": "눈 편안함, 에너지 절약",
                "rounded_corners": "더 둥글게 (24px+)",
                "variable_fonts": "가변 폰트로 유연한 타이포",
                "3d_elements": "subtle 3D 요소"
            }
        }

    def _generate_draft_id(self) -> str:
        """고유 시안 ID 생성"""
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        return f"draft_{timestamp}"

    def search_design_trends(self, query: str) -> Dict:
        """디자인 트렌드 검색 및 분석"""
        print(f"🔍 디자인 트렌드 검색 중: {query}")

        # 내부 레퍼런스 DB 검색
        relevant_refs = []
        query_lower = query.lower()

        # 기도/명상 앱 관련
        if any(k in query_lower for k in ["기도", "prayer", "명상", "meditation"]):
            relevant_refs.extend([
                {"category": "기도 앱", "data": self.design_references["prayer_apps"]},
                {"category": "명상 앱", "data": self.design_references["meditation_apps"]}
            ])

        # 트렌드 관련
        if any(k in query_lower for k in ["트렌드", "trend", "2026", "최신"]):
            relevant_refs.append({
                "category": "2026 트렌드",
                "data": self.design_references["design_trends_2026"]
            })

        # Gemini로 분석 (가능한 경우)
        analysis = None
        if self.model:
            try:
                prompt = f"""
                디자인 트렌드 분석 요청: {query}

                다음 레퍼런스 데이터를 기반으로 분석해주세요:
                {json.dumps(relevant_refs, ensure_ascii=False, indent=2)}

                출력 형식 (JSON):
                {{
                    "trend_summary": "핵심 트렌드 요약 (2-3문장)",
                    "key_elements": ["핵심 디자인 요소 1", "요소 2", "요소 3"],
                    "color_recommendations": ["#hex1", "#hex2", "#hex3"],
                    "css_suggestions": ["CSS 속성 제안 1", "제안 2"],
                    "examples": ["참고할 앱/사이트 1", "앱 2"]
                }}
                """
                response = self.model.generate_content(prompt)
                # JSON 파싱 시도
                text = response.text
                if "```json" in text:
                    text = text.split("```json")[1].split("```")[0]
                elif "```" in text:
                    text = text.split("```")[1].split("```")[0]
                analysis = json.loads(text.strip())
            except Exception as e:
                print(f"⚠️ Gemini 분석 실패: {e}")

        return {
            "success": True,
            "query": query,
            "references": relevant_refs,
            "analysis": analysis,
            "message": self._format_search_result(query, relevant_refs, analysis)
        }

    def _format_search_result(self, query: str, refs: List, analysis: Optional[Dict]) -> str:
        """검색 결과 포맷팅"""
        msg = f"🔍 디자인 리서치: {query}\n\n"

        for ref in refs:
            msg += f"📂 {ref['category']}:\n"
            if isinstance(ref['data'], dict):
                for name, info in list(ref['data'].items())[:3]:
                    if isinstance(info, dict):
                        msg += f"  • {name}: {info.get('style', info)[:50]}...\n"
                    else:
                        msg += f"  • {name}: {info[:50]}...\n"
            msg += "\n"

        if analysis:
            msg += "📊 AI 분석 결과:\n"
            msg += f"  {analysis.get('trend_summary', '')}\n\n"
            if analysis.get('key_elements'):
                msg += "🎯 핵심 요소:\n"
                for elem in analysis['key_elements'][:5]:
                    msg += f"  • {elem}\n"

        return msg

    def compare_designs(self, targets: str) -> Dict:
        """경쟁 앱/사이트 디자인 비교 분석"""
        target_list = targets.split()
        print(f"📊 디자인 비교 분석: {target_list}")

        comparisons = []

        # 내부 DB에서 정보 수집
        all_apps = {
            **self.design_references.get("prayer_apps", {}),
            **self.design_references.get("meditation_apps", {})
        }

        for target in target_list:
            target_lower = target.lower()
            for app_name, app_info in all_apps.items():
                if target_lower in app_name.lower():
                    comparisons.append({
                        "name": app_name,
                        "info": app_info
                    })
                    break

        # Palmoni 현재 상태 분석
        palmoni_analysis = self._analyze_current_design()

        # Gemini로 비교 분석
        comparison_result = None
        if self.model and comparisons:
            try:
                prompt = f"""
                Palmoni(기도 앱)과 경쟁 앱 디자인 비교 분석:

                현재 Palmoni 스타일:
                {json.dumps(palmoni_analysis, ensure_ascii=False, indent=2)}

                비교 대상:
                {json.dumps(comparisons, ensure_ascii=False, indent=2)}

                출력 형식 (JSON):
                {{
                    "palmoni_strengths": ["강점 1", "강점 2"],
                    "palmoni_weaknesses": ["개선점 1", "개선점 2"],
                    "competitor_best_practices": ["배울 점 1", "배울 점 2"],
                    "recommendations": [
                        {{
                            "area": "개선 영역",
                            "current": "현재 상태",
                            "suggested": "제안",
                            "reference": "참고 앱"
                        }}
                    ]
                }}
                """
                response = self.model.generate_content(prompt)
                text = response.text
                if "```json" in text:
                    text = text.split("```json")[1].split("```")[0]
                elif "```" in text:
                    text = text.split("```")[1].split("```")[0]
                comparison_result = json.loads(text.strip())
            except Exception as e:
                print(f"⚠️ 비교 분석 실패: {e}")

        return {
            "success": True,
            "targets": target_list,
            "comparisons": comparisons,
            "palmoni_current": palmoni_analysis,
            "analysis": comparison_result,
            "message": self._format_comparison(comparisons, comparison_result)
        }

    def _analyze_current_design(self) -> Dict:
        """Palmoni 현재 디자인 분석"""
        analysis = {
            "colors": [],
            "components": [],
            "style_features": []
        }

        # CSS 파일에서 색상 추출
        css_files = list(self.palmoni_path.glob("src/**/*.css"))
        all_colors = set()

        for css_file in css_files[:10]:  # 최대 10개 파일
            try:
                content = css_file.read_text()
                import re
                colors = re.findall(r'#[0-9a-fA-F]{3,6}', content)
                all_colors.update(colors)

                # 컴포넌트 이름 추가
                analysis["components"].append(css_file.stem)
            except:
                pass

        analysis["colors"] = list(all_colors)[:15]

        # 주요 스타일 특징 분석
        index_css = self.palmoni_path / "src" / "index.css"
        if index_css.exists():
            content = index_css.read_text()
            if "border-radius" in content:
                analysis["style_features"].append("rounded corners")
            if "gradient" in content:
                analysis["style_features"].append("gradients")
            if "box-shadow" in content:
                analysis["style_features"].append("shadows")
            if "transition" in content:
                analysis["style_features"].append("animations")

        return analysis

    def _format_comparison(self, comparisons: List, analysis: Optional[Dict]) -> str:
        """비교 결과 포맷팅"""
        msg = "📊 디자인 비교 분석\n\n"

        for comp in comparisons:
            msg += f"🎨 {comp['name']}:\n"
            info = comp['info']
            if isinstance(info, dict):
                msg += f"   스타일: {info.get('style', '-')}\n"
                if info.get('colors'):
                    msg += f"   컬러: {', '.join(info['colors'][:3])}\n"
            msg += "\n"

        if analysis:
            msg += "💡 Palmoni 개선 제안:\n"
            for rec in analysis.get('recommendations', [])[:3]:
                msg += f"\n  📌 {rec.get('area', '')}:\n"
                msg += f"     현재: {rec.get('current', '')}\n"
                msg += f"     제안: {rec.get('suggested', '')}\n"
                msg += f"     참고: {rec.get('reference', '')}\n"

        return msg

    def create_design_draft(self, description: str) -> Dict:
        """디자인 시안 생성"""
        draft_id = self._generate_draft_id()
        print(f"📝 디자인 시안 생성 중: {description}")

        # 관련 컴포넌트 찾기
        target_component = self._find_target_component(description)

        # 트렌드 검색
        search_result = self.search_design_trends(description)

        # Gemini로 시안 생성
        design_proposal = None
        css_changes = []

        if self.model:
            try:
                # 현재 CSS 읽기
                current_css = ""
                if target_component:
                    css_path = self.palmoni_path / "src" / target_component
                    if css_path.exists():
                        current_css = css_path.read_text()[:2000]  # 최대 2000자

                prompt = f"""
                디자인 시안 생성 요청: {description}

                대상 컴포넌트: {target_component}
                현재 CSS:
                ```css
                {current_css}
                ```

                참고 트렌드:
                {json.dumps(search_result.get('analysis', {}), ensure_ascii=False)}

                출력 형식 (JSON):
                {{
                    "concept": "디자인 컨셉 설명 (1-2문장)",
                    "visual_description": "시각적 변화 설명 (3-4문장)",
                    "color_palette": {{
                        "primary": "#hex",
                        "secondary": "#hex",
                        "accent": "#hex"
                    }},
                    "css_changes": [
                        {{
                            "selector": "CSS 선택자",
                            "property": "속성명",
                            "old_value": "기존값 (없으면 null)",
                            "new_value": "새 값",
                            "reason": "변경 이유"
                        }}
                    ],
                    "before_after_description": "변경 전/후 비교 설명"
                }}
                """
                response = self.model.generate_content(prompt)
                text = response.text
                if "```json" in text:
                    text = text.split("```json")[1].split("```")[0]
                elif "```" in text:
                    text = text.split("```")[1].split("```")[0]
                design_proposal = json.loads(text.strip())
                css_changes = design_proposal.get("css_changes", [])
            except Exception as e:
                print(f"⚠️ 시안 생성 실패: {e}")
                design_proposal = {
                    "concept": f"{description}에 대한 디자인 개선",
                    "visual_description": "AI 분석 실패. 수동으로 작성해주세요.",
                    "error": str(e)
                }

        # Draft 저장
        draft = DesignDraft(
            draft_id=draft_id,
            title=description[:50],
            description=description,
            target_component=target_component or "unknown",
            research_summary=json.dumps(search_result.get('analysis', {}), ensure_ascii=False),
            design_proposal=design_proposal or {},
            css_changes=css_changes,
            status="pending_review",
            created_at=datetime.now().isoformat(),
            updated_at=datetime.now().isoformat()
        )

        draft_file = self.drafts_dir / f"{draft_id}.json"
        with open(draft_file, 'w') as f:
            json.dump(asdict(draft), f, indent=2, ensure_ascii=False)

        return {
            "success": True,
            "draft_id": draft_id,
            "draft": asdict(draft),
            "message": self._format_draft_for_review(draft)
        }

    def _find_target_component(self, description: str) -> Optional[str]:
        """설명에서 대상 컴포넌트 경로 찾기"""
        desc_lower = description.lower()

        component_keywords = {
            "홈": "pages/Home.jsx",
            "home": "pages/Home.jsx",
            "로그인": "components/auth/LoginModal.jsx",
            "login": "components/auth/LoginModal.jsx",
            "가격": "pages/Pricing.jsx",
            "pricing": "pages/Pricing.jsx",
            "기도": "components/prayer/",
            "prayer": "components/prayer/",
            "버튼": "components/ui/button.jsx",
            "button": "components/ui/button.jsx",
            "카드": "components/ui/card.jsx",
            "card": "components/ui/card.jsx",
            "히어로": "pages/Home.jsx",
            "hero": "pages/Home.jsx"
        }

        for keyword, path in component_keywords.items():
            if keyword in desc_lower:
                return path

        return None

    def _format_draft_for_review(self, draft: DesignDraft) -> str:
        """시안 리뷰용 포맷팅"""
        msg = f"📐 디자인 시안 #{draft.draft_id}\n\n"
        msg += f"📝 요청: {draft.description}\n"
        msg += f"🎯 대상: {draft.target_component}\n\n"

        proposal = draft.design_proposal
        if proposal:
            msg += f"💡 컨셉: {proposal.get('concept', '-')}\n\n"
            msg += f"🎨 시각적 변화:\n{proposal.get('visual_description', '-')}\n\n"

            if proposal.get('color_palette'):
                palette = proposal['color_palette']
                msg += "🎨 컬러 팔레트:\n"
                for name, color in palette.items():
                    msg += f"   {name}: {color}\n"
                msg += "\n"

            if draft.css_changes:
                msg += "✏️ CSS 변경 사항:\n"
                for change in draft.css_changes[:5]:
                    msg += f"   • {change.get('selector', '-')}\n"
                    msg += f"     {change.get('property', '-')}: {change.get('new_value', '-')}\n"
                    msg += f"     이유: {change.get('reason', '-')}\n"

        msg += "\n👇 다음 단계:\n"
        msg += f"/design approve {draft.draft_id} - 승인\n"
        msg += f"/design reject {draft.draft_id} - 거절\n"
        msg += f"/design modify {draft.draft_id} '수정사항' - 수정 요청"

        return msg

    def present_draft(self, draft_id: str) -> Dict:
        """시안 상세 프레젠테이션"""
        draft_file = self.drafts_dir / f"{draft_id}.json"

        if not draft_file.exists():
            return {
                "success": False,
                "error": f"시안 {draft_id}를 찾을 수 없습니다"
            }

        with open(draft_file) as f:
            draft_data = json.load(f)

        draft = DesignDraft(**draft_data)

        return {
            "success": True,
            "draft": draft_data,
            "message": self._format_draft_for_review(draft)
        }

    def list_drafts(self) -> Dict:
        """모든 시안 목록"""
        drafts = []
        for draft_file in self.drafts_dir.glob("draft_*.json"):
            try:
                with open(draft_file) as f:
                    data = json.load(f)
                    drafts.append({
                        "id": data["draft_id"],
                        "title": data["title"],
                        "status": data["status"],
                        "created_at": data["created_at"]
                    })
            except:
                pass

        drafts.sort(key=lambda x: x["created_at"], reverse=True)

        msg = "📋 디자인 시안 목록\n\n"
        for d in drafts[:10]:
            status_icon = {
                "pending_review": "⏳",
                "approved": "✅",
                "rejected": "❌",
                "applied": "🚀"
            }.get(d["status"], "❓")
            msg += f"{status_icon} #{d['id']}: {d['title']}\n"

        return {
            "success": True,
            "drafts": drafts,
            "message": msg
        }


def main():
    """CLI 진입점"""
    if len(sys.argv) < 2:
        print("사용법:")
        print("  python design_research.py search '기도앱 UI 트렌드'")
        print("  python design_research.py compare 'Calm Headspace Pray.com'")
        print("  python design_research.py draft '홈페이지 히어로 섹션 개선'")
        print("  python design_research.py present <draft_id>")
        print("  python design_research.py list")
        sys.exit(1)

    agent = DesignResearchAgent()
    command = sys.argv[1]

    if command == "search":
        if len(sys.argv) < 3:
            print("Error: 검색어 필요")
            sys.exit(1)
        result = agent.search_design_trends(sys.argv[2])

    elif command == "compare":
        if len(sys.argv) < 3:
            print("Error: 비교 대상 필요 (예: 'Calm Headspace')")
            sys.exit(1)
        result = agent.compare_designs(sys.argv[2])

    elif command == "draft":
        if len(sys.argv) < 3:
            print("Error: 시안 설명 필요")
            sys.exit(1)
        result = agent.create_design_draft(sys.argv[2])

    elif command == "present":
        if len(sys.argv) < 3:
            print("Error: draft_id 필요")
            sys.exit(1)
        result = agent.present_draft(sys.argv[2])

    elif command == "list":
        result = agent.list_drafts()

    else:
        print(f"알 수 없는 명령어: {command}")
        sys.exit(1)

    # 결과 출력
    if result.get("message"):
        print("\n" + "="*50)
        print(result["message"])
        print("="*50)

    # JSON 결과도 저장
    output_file = agent.drafts_dir / "last_result.json"
    with open(output_file, 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\n📁 상세 결과: {output_file}")


if __name__ == "__main__":
    main()
