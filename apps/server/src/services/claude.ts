import { spawn } from 'node:child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const PROJECT_ROOT = process.env.TRAIL_PROJECT_ROOT ?? process.cwd();
// Grace period between SIGTERM (polite) and SIGKILL (forceful). A
// hung MCP subprocess that ignores SIGTERM would otherwise linger
// after the promise rejects — leaked FDs, leaked memory, and another
// claude process waiting on it via fs lock. 3 seconds is enough for
// a well-behaved child to flush + exit, short enough that a wedged
// one doesn't overstay.
const SIGKILL_GRACE_MS = 3000;
// Hard cap on captured stdout/stderr per spawn. A pathological child
// streaming multi-MB of output would otherwise pin memory until the
// promise resolves. 10MB is hundreds of times any legitimate Claude
// JSON response; past that we truncate + flag. Raise via env if some
// future pipeline needs it.
const MAX_BYTES = Number(process.env.TRAIL_CLAUDE_MAX_BYTES ?? 10 * 1024 * 1024);

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
    let truncated = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    // Every kill-path (timeout OR byte-cap) goes through this helper so
    // the SIGTERM-then-SIGKILL escalation is uniform. Calling it twice
    // (rare: byte-cap fires, then timeout fires right after) is safe —
    // sigkillTimer stays set from the first call and is cleared in
    // `close`. Both paths need the escalation: a child that ignores
    // SIGTERM after either signal would otherwise leak FDs + memory
    // forever.
    const killWithEscalation = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      if (sigkillTimer) return; // escalation already scheduled
      sigkillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, SIGKILL_GRACE_MS);
    };

    const append = (target: 'stdout' | 'stderr', data: Buffer): void => {
      if (truncated) return;
      const current = target === 'stdout' ? stdout : stderr;
      const remaining = MAX_BYTES - current.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const chunk = data.length > remaining ? data.subarray(0, remaining).toString() : data.toString();
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (data.length > remaining) {
        truncated = true;
        killWithEscalation();
      }
    };

    child.stdout.on('data', (data: Buffer) => append('stdout', data));
    child.stderr.on('data', (data: Buffer) => append('stderr', data));

    const timer = setTimeout(() => {
      killWithEscalation();
      reject(new Error(`claude timed out after ${opts.timeoutMs / 1000}s`));
    }, opts.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (truncated) {
        reject(
          new Error(
            `claude output exceeded ${Math.round(MAX_BYTES / 1024 / 1024)}MB cap and was terminated`,
          ),
        );
        return;
      }
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
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
