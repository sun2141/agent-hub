import { GoogleGenerativeAI } from '@google/generative-ai';

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
      console.error('GOOGLE_API_KEY not found');
      return res.status(500).json({
        error: 'API configuration error',
        details: 'GOOGLE_API_KEY is not configured'
      });
    }

    // Initialize Gemini API
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    // Generate prayer content
    const prompt = `사용자가 다음과 같은 고민이나 감사의 마음을 전했습니다:
"${topic}"

이를 바탕으로 따뜻하고 위로가 되는 기독교 기도문을 작성해주세요.

다음 형식의 JSON으로 응답해주세요:
{
  "title": "기도문의 주제를 담은 짧은 제목 (예: 주님, 취업 준비로 지쳐갑니다)",
  "content": "300~500자 내외의 기도문. 나-전달법을 사용하고, 정중한 경어체(~하시옵소서, ~기도합니다)를 사용합니다. 마지막에 '예수님의 이름으로 기도드립니다. 아멘.'으로 끝맺습니다."
}

중요: 순수한 JSON만 출력하고, 마크다운 코드 블록(\\`\\`\\`json)은 사용하지 마세요.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text();

    // Remove markdown code blocks if present
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Parse JSON
    const prayerData = JSON.parse(text);

    return res.status(200).json(prayerData);
  } catch (error) {
    console.error('Error generating prayer:', error);
    return res.status(500).json({
      error: 'Internal server error during prayer generation',
      details: error.message
    });
  }
}
