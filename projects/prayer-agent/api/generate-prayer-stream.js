export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { topic } = req.query;

  if (!topic) {
    return res.status(400).json({ error: 'Prayer topic is required' });
  }

  // Set up Server-Sent Events headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const apiKey = process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      res.write(`data: ${JSON.stringify({ error: 'API configuration error' })}\n\n`);
      res.end();
      return;
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
      res.write(`data: ${JSON.stringify({ error: 'Failed to generate prayer' })}\n\n`);
      res.end();
      return;
    }

    const data = await response.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    try {
      // Parse the JSON response
      const prayerData = JSON.parse(text);
      const fullText = `${prayerData.title}\n\n${prayerData.content}`;

      // Stream the text character by character with typing effect
      // Simulate 40ms delay per character for smooth typing effect
      const words = fullText.split('');

      for (let i = 0; i < words.length; i++) {
        res.write(`data: ${JSON.stringify({ chunk: words[i] })}\n\n`);

        // Small delay to simulate typing (Vercel serverless functions handle this differently)
        // In production, we send chunks in batches for efficiency
        if (i % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      }

      // Send completion signal
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();

    } catch (parseError) {
      console.error('Parse error:', parseError);
      res.write(`data: ${JSON.stringify({ error: 'Failed to parse prayer response' })}\n\n`);
      res.end();
    }
  } catch (error) {
    console.error('Error generating prayer:', error);
    res.write(`data: ${JSON.stringify({ error: 'Internal server error during prayer generation' })}\n\n`);
    res.end();
  }
}
