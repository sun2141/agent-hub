  // ── Claude Code CLI 실행 ──────────────────────────────────
  // --setting-sources user 제거: CLAUDE_CONFIG_DIR(인증된 harness 설정)을 직접 사용

  _claudeRun({ taskId, phase, round, cwd, prompt }) {
    return new Promise((resolve, reject) => {
      if (this._deleted.has(taskId)) { resolve(''); return; }

      const entry = this._running.get(taskId) || { process: null, phase, round };
      entry.phase = phase;
      entry.round = round;
      this._running.set(taskId, entry);

      const args = [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--model', CLAUDE_MODEL,
        '--dangerously-skip-permissions',
        // --setting-sources user 제거: CLAUDE_CONFIG_DIR의 harness 설정 우선 사용
        prompt,
      ];

      // CLAUDE_CONFIG_DIR을 명시적으로 포함한 env 생성
      const spawnEnv = {
        ...process.env,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      };

      console.log(`[CLI spawn:${phase}] round=${round} CLAUDE_CONFIG_DIR=${spawnEnv.CLAUDE_CONFIG_DIR}`);

      const proc = spawn(CLAUDE_CLI, args, {
        cwd,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.process = proc;

      let finalResult    = null;
      let assistantTexts = [];
      let buffer         = '';
      let rateLimit      = false;

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._handleStreamMsg(taskId, phase, round, msg,
              (t) => assistantTexts.push(t),
              (r) => { finalResult = r; }
            );
          } catch { /* 무시 */ }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        console.error(`[CLI stderr:${phase}] ${text.trim()}`);
        if (!rateLimit && (text.includes('rate limit') || text.includes('429') || text.includes('usage limit'))) {
          rateLimit = true;
          reject(new Error('RATE_LIMIT'));
        }
        logQueries.append({ task_id: taskId, phase, round, level: 'error', content: text.slice(0, 500) });
      });

      proc.on('close', (code) => {
        const output = (finalResult?.trim()) ? finalResult : assistantTexts.join('\n').trim();
        console.log(`[CLI close:${phase}] code=${code} outputLen=${output.length}`);
        if (rateLimit) return;
        if (this._deleted.has(taskId)) { resolve(output); return; }
        if (code !== 0 && !output) reject(new Error(`Claude CLI 종료 code=${code}`));
        else resolve(output);
      });

      proc.on('error', (err) => reject(new Error(`Claude CLI 실행 실패: ${err.message}`)));
    });
  }