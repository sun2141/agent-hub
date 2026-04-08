      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        console.error(`[CLI stderr] ${text.trim()}`); // 임시 디버깅
        if (!rejected && (text.includes('rate limit') || text.includes('429'))) {
          rejected = true;
          reject(new Error('RATE_LIMIT'));
        }
        logQueries.append({ task_id: taskId, phase, round, level: 'error', content: text.substring(0, 500) });
      });