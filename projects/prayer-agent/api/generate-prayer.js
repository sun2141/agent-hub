export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { topic } = req.body;

  if (!topic) {
    return res.status(400).json({ error: 'Prayer topic is required' });
  }

  try {
    const apiKey = process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: 'API configuration error',
        details: 'GOOGLE_API_KEY is not configured'
      });
    }

    // Generate prayer content using Google Gemini REST API
    const prompt = `당신은 상처받은 이들을 위로하고 진심으로 공감하는 지혜로운 영적 동반자입니다.
사용자의 기도 제목: "${topic}"

다음 원칙에 따라 기도문을 작성해 주세요:
1. **사람의 따스함**: AI가 아닌, 정말 내 아픔을 아는 사람이 옆에서 손을 잡고 기도해주는 것 같은 따뜻한 어조를 사용하세요.
2. **깊은 공감**: 기도 제목에 담긴 사용자의 구체적인 감정(불안, 고독, 감사 등)을 깊이 헤아려 문장에 담으세요.
3. **나-전달법**: "주님, 제가 이분을 위해 기도합니다"가 아닌, 사용자가 직접 주님께 고백하는 듯한 "나"의 언어로 작성하세요.
4. **비정형성**: 너무 뻔한 종교적 표현만 반복하지 말고, 일상의 언어를 섞어 진실성을 높이세요.
5. **구성**: 짧고 강렬한 제목, 300~500자의 본문, 그리고 "예수님의 이름으로 기도드립니다. 아멘."으로 마무리하세요.

응답은 반드시 아래의 JSON 형식으로만 출력하세요 (코드 블록 없이):
{
  "title": "기도문의 제목",
  "content": "기도문의 본문 내용"
}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Gemini API error:', errorData);
      return res.status(500).json({
        error: 'Failed to generate prayer',
        details: `API returned ${response.status}`
      });
    }

    const data = await response.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Remove markdown code blocks if present
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
      // Parse JSON
      const prayerData = JSON.parse(text);
      return res.status(200).json(prayerData);
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      console.error('Raw text:', text);

      // Fallback: try to extract title and content manually
      const titleMatch = text.match(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      const contentMatch = text.match(/"content"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/s);

      if (titleMatch && contentMatch) {
        return res.status(200).json({
          title: titleMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
          content: contentMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
        });
      }

      throw parseError;
    }
  } catch (error) {
    console.error('Error generating prayer:', error);
    return res.status(500).json({
      error: 'Internal server error during prayer generation',
      details: error.message
    });
  }
}
