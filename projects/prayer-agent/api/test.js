export default function handler(req, res) {
  res.status(200).json({
    message: 'API is working!',
    env: {
      hasApiKey: !!process.env.GOOGLE_API_KEY,
      nodeVersion: process.version
    }
  });
}
