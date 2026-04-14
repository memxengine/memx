import { spawn } from 'node:child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const PROJECT_ROOT = process.env.MEMX_PROJECT_ROOT ?? process.cwd();

export interface SpawnOptions {
  timeoutMs: number;
  env?: Record<string, string>;
}

export function spawnClaude(args: string[], opts: SpawnOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.end();

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude timed out after ${opts.timeoutMs / 1000}s`));
    }, opts.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

export function extractAssistantText(raw: string): string {
  try {
    const body = JSON.parse(raw) as {
      result?: unknown;
      content?: unknown;
    };
    if (typeof body.result === 'string') return body.result;
    if (Array.isArray(body.content)) {
      return body.content
        .filter((c): c is { type: string; text: string } =>
          typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text',
        )
        .map((c) => c.text)
        .join('\n');
    }
    if (Array.isArray(body)) {
      const messages = body as Array<{ role?: string; content?: unknown }>;
      const last = messages.filter((m) => m.role === 'assistant').pop();
      if (last?.content) {
        if (typeof last.content === 'string') return last.content;
        if (Array.isArray(last.content)) {
          return last.content
            .filter(
              (c): c is { type: string; text: string } =>
                typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text',
            )
            .map((c) => c.text)
            .join('\n');
        }
      }
    }
    return raw;
  } catch {
    return raw;
  }
}
