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
    const prompt = `사용자의 기도 제목: "${topic}"

위 주제로 따뜻하고 위로가 되는 기독교 기도문을 작성하세요.

- 제목: 기도문의 주제를 담은 짧은 제목
- 본문: 300~500자 내외의 기도문. 나-전달법을 사용하고, 정중한 경어체를 사용합니다. 마지막에 "예수님의 이름으로 기도드립니다. 아멘."으로 끝맺습니다.

JSON 형식으로 응답하세요. 줄바꿈은 실제 줄바꿈 문자가 아닌 \\n으로 표현하세요.`;

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
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: '기도문의 제목'
                },
                content: {
                  type: 'string',
                  description: '기도문의 본문 내용'
                }
              },
              required: ['title', 'content']
            }
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

    try {
      // The response is already a JSON string, just parse it directly
      const prayerData = JSON.parse(text);
      return res.status(200).json(prayerData);
    } catch (parseError) {
      // Return raw response for debugging
      return res.status(200).json({
        debug: true,
        rawText: text,
        parseError: parseError.message
      });
    }
  } catch (error) {
    console.error('Error generating prayer:', error);
    return res.status(500).json({
      error: 'Internal server error during prayer generation',
      details: error.message
    });
  }
}
