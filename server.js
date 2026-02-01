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

// API endpoint for prayer generation
app.post('/api/generate-prayer', (req, res) => {
    const { topic } = req.body;

    if (!topic) {
        return res.status(400).json({ error: 'Prayer topic is required' });
    }

    // Execute the Python script (Layer 3)
    const pythonPath = 'python3'; // Or the path to your python executable
    const scriptPath = path.join(__dirname, 'execution', 'generate_prayer.py');

    exec(`${pythonPath} "${scriptPath}" "${topic}"`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error executing script: ${error}`);
            return res.status(500).json({ error: 'Internal server error during prayer generation' });
        }

        try {
            const result = JSON.parse(stdout);
            res.json(result);
        } catch (parseError) {
            console.error(`Error parsing script output: ${parseError}`);
            res.status(500).json({ error: 'Failed to parse prayer output' });
        }
    });
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
