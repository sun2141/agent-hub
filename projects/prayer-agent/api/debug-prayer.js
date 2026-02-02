export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { topic } = req.body;

  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    const prompt = `사용자의 기도 제목: "${topic || '테스트'}"\n\n위 주제로 기도문을 JSON 형식으로 작성하세요.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 512,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                content: { type: 'string' }
              }
            }
          }
        })
      }
    );

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return res.status(200).json({
      rawText: text,
      rawResponse: data
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
}
