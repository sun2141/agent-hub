import fetch from 'node-fetch';

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text } = req.body;

    // Validate text
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Text is required' });
    }

    if (text.length > 5000) {
      return res.status(400).json({ error: 'Text is too long (max 5000 characters)' });
    }

    // Use Google Cloud Text-to-Speech API
    const apiKey = process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      console.error('Google API key not configured');
      return res.status(500).json({ error: 'TTS service not configured' });
    }

    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode: 'ko-KR',
            name: 'ko-KR-Standard-A', // Female voice
            ssmlGender: 'FEMALE',
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: 0.95, // Slightly slower for better clarity
            pitch: 0.0,
            volumeGainDb: 0.0,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Google TTS API error:', errorData);
      return res.status(500).json({
        error: 'TTS generation failed',
        details: errorData.error?.message || 'Unknown error'
      });
    }

    const data = await response.json();

    if (!data.audioContent) {
      return res.status(500).json({ error: 'No audio content received' });
    }

    // Convert base64 to buffer
    const audioBuffer = Buffer.from(data.audioContent, 'base64');

    // Set appropriate headers
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

    // Send audio
    return res.status(200).send(audioBuffer);
  } catch (error) {
    console.error('TTS generation error:', error);
    return res.status(500).json({
      error: 'TTS generation failed',
      details: error.message
    });
  }
}
