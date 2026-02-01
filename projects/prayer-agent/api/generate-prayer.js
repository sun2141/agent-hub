import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    // Execute Python script using Vercel's Python runtime
    const scriptPath = path.join(__dirname, 'generate-prayer.py');
    const command = `python3 "${scriptPath}" "${topic.replace(/"/g, '\\"')}"`;

    const { stdout, stderr } = await execAsync(command, {
      env: {
        ...process.env,
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY
      }
    });

    if (stderr) {
      console.error(`Script stderr: ${stderr}`);
    }

    const result = JSON.parse(stdout);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error executing script:', error);
    return res.status(500).json({
      error: 'Internal server error during prayer generation',
      details: error.message
    });
  }
}
