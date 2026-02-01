import os
import sys
import json
from google import genai
from dotenv import load_dotenv

load_dotenv()

# API Key setup
api_key = os.getenv("GOOGLE_API_KEY")
if api_key:
    client = genai.Client(api_key=api_key)
else:
    client = None

def generate_prayer(topic):
    """
    사용자의 기도 제목을 바탕으로 실제 사람이 기도하는 것 같은 따뜻한 AI 기도문을 생성합니다.
    """
    if not client:
        # Mock response if API key is missing
        return {
            "title": f"'{topic}'을 위한 진심 어린 기도",
            "content": f"사랑과 은혜가 풍성하신 하나님,\n\n오늘 '{topic}'이라는 마음의 짐을 가지고 주님 앞에 나온 당신의 자녀와 함께하여 주시옵소서..."
        }

    try:
        prompt = f"""
        당신은 상처받은 이들을 위로하고 진심으로 공감하는 지혜로운 영적 동반자입니다.
        사용자의 기도 제목: "{topic}"

        다음 원칙에 따라 기도문을 작성해 주세요:
        1. **사람의 따스함**: AI가 아닌, 정말 내 아픔을 아는 사람이 옆에서 손을 잡고 기도해주는 것 같은 따뜻한 어조를 사용하세요.
        2. **깊은 공감**: 기도 제목에 담긴 사용자의 구체적인 감정(불안, 고독, 감사 등)을 깊이 헤아려 문장에 담으세요.
        3. **나-전달법**: "주님, 제가 이분을 위해 기도합니다"가 아닌, 사용자가 직접 주님께 고백하는 듯한 "나"의 언어로 작성하세요.
        4. **비정형성**: 너무 뻔한 종교적 표현만 반복하지 말고, 일상의 언어를 섞어 진실성을 높이세요.
        5. **구성**: 짧고 강렬한 제목, 300~500자의 본문, 그리고 "예수님의 이름으로 기도드립니다. 아멘."으로 마무리하세요.

        응답은 반드시 아래의 JSON 형식으로만 출력하세요:
        {{
          "title": "기도문의 제목",
          "content": "기도문의 본문 내용 (줄바꿈 포함)"
        }}
        """

        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt
        )

        # Handle potential non-JSON output from LLM
        text = response.text.strip()
        if text.startswith('```json'):
            text = text[7:-3].strip()

        return json.loads(text)
    except Exception as e:
        print(f"Error in generation: {e}", file=sys.stderr)
        return {
            "title": "마음을 담은 기도",
            "content": f"오 주님, '{topic}'으로 힘들어하는 당신의 자녀와 지금 이 순간 함께하여 주시옵소서..."
        }

if __name__ == "__main__":
    if len(sys.argv) > 1:
        topic_input = sys.argv[1]
        result = generate_prayer(topic_input)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("기도 제목을 입력해주세요.")
