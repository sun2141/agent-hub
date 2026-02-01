import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { exec } from 'child_process';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());

// Mock data for background activity simulation
const backgroundActivities = [
    "누군가의 '가족의 건강'을 위한 기도가 진행 중입니다.",
    "방금 '취업 준비'로 힘들어하는 분의 마음이 전달되었습니다.",
    "어느 성도님의 '감사 기도'가 하늘에 닿았습니다.",
    "한 아이의 '깜찍한 소망'이 기도문으로 작성되었습니다.",
    "지금 '병상에 계신 분'을 위한 위로의 기도가 시작됩니다.",
    "익명의 사용자가 '평안한 밤'을 위해 기도하고 있습니다."
];

// API endpoint for prayer generation
app.post('/api/generate-prayer', (req, res) => {
    const { topic } = req.body;

    if (!topic) {
        return res.status(400).json({ error: 'Prayer topic is required' });
    }

    // Execute the Python script (Layer 3)
    // Use venv Python - going up two levels from projects/prayer-agent to root
    const rootDir = path.resolve(__dirname, '..', '..');
    const pythonPath = path.join(rootDir, 'venv', 'bin', 'python');
    const scriptPath = path.join(__dirname, 'execution', 'generate_prayer.py');

    const command = `"${pythonPath}" "${scriptPath}" "${topic}"`;
    console.log(`Executing: ${command}`);

    exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
        if (stderr) {
            console.error(`Script stderr: ${stderr}`);
        }

        if (error) {
            console.error(`Error executing script: ${error.message}`);
            console.error(`Exit code: ${error.code}`);
            return res.status(500).json({ error: 'Internal server error during prayer generation' });
        }

        console.log(`Script stdout: ${stdout}`);

        try {
            const result = JSON.parse(stdout);
            res.json(result);
        } catch (parseError) {
            console.error(`Error parsing script output: ${parseError.message}`);
            console.error(`Raw output: ${stdout}`);
            res.status(500).json({ error: 'Failed to parse prayer output' });
        }
    });
});

// API endpoint for background activities
app.get('/api/background-activities', (req, res) => {
    // Return a random activity to simulate real-time notification
    const randomActivity = backgroundActivities[Math.floor(Math.random() * backgroundActivities.length)];
    res.json({ message: randomActivity });
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
