/**
 * F149 — Claude CLI backend.
 *
 * Wraps the existing `spawnClaude` invocation that ingest.ts used
 * directly before F149. Keeps current behaviour byte-identical:
 *   - `claude -p <prompt>` subprocess
 *   - --mcp-config points to the per-job config file
 *   - --allowedTools restricted to mcp__trail__*
 *   - --dangerously-skip-permissions (ingest runs in a server we trust)
 *   - --max-turns capped, --output-format json for parseable final message
 *   - Env forwarded through the subprocess
 *
 * Cost reporting: Max Plan runs emit no cost signal, so we report 0.
 * Anthropic API runs (when INGEST_ANTHROPIC_API=1 is set and the CLI
 * is billing against the API key not the Max account) emit a
 * `total_cost_usd` field in the final JSON message; parse that if
 * present.
 */

import type {
  IngestBackend,
  IngestBackendInput,
  IngestBackendResult,
} from './backend.js';
import { spawnClaude } from '../claude.js';

export class ClaudeCLIBackend implements IngestBackend {
  readonly id = 'claude-cli' as const;

  async run(input: IngestBackendInput): Promise<IngestBackendResult> {
    const args = [
      '-p',
      input.prompt,
      '--mcp-config',
      input.mcpConfigPath,
      '--allowedTools',
      input.tools.join(','),
      '--dangerously-skip-permissions',
      '--max-turns',
      String(input.maxTurns),
      '--output-format',
      'json',
      '--model',
      input.model,
    ];

    const t0 = Date.now();
    const output = await spawnClaude(args, {
      timeoutMs: input.timeoutMs,
      env: input.env,
    });
    const durationMs = Date.now() - t0;

    // `spawnClaude` returns a string. When --output-format json is set,
    // claude emits a single JSON blob at the end. Parse defensively —
    // older CLI versions may not wrap everything in JSON and we don't
    // want a parse-error here to kill a successful ingest.
    const { turns, costCents } = parseClaudeFinalMessage(output);

    return {
      turns,
      durationMs,
      costCents,
      modelTrail: [{ turn: 1, model: input.model }],
    };
  }
}

/**
 * Extract turn-count + cost from claude CLI's `--output-format json`
 * final message. Returns best-effort values; missing fields default
 * to 0/1 rather than throwing, because the ingest itself succeeded
 * even if the CLI's telemetry shape changed.
 */
function parseClaudeFinalMessage(raw: string): { turns: number; costCents: number } {
  // Claude CLI with --output-format json emits one JSON object per
  // event, newline-separated. The final event is typically of type
  // 'result' with num_turns + sometimes total_cost_usd.
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  let turns = 1;
  let costCents = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as {
        num_turns?: number;
        total_cost_usd?: number;
        type?: string;
      };
      if (typeof obj.num_turns === 'number') turns = obj.num_turns;
      if (typeof obj.total_cost_usd === 'number') {
        // USD → cents, rounded. Max Plan returns undefined or 0.
        costCents = Math.round(obj.total_cost_usd * 100);
      }
      // We only need the last JSON object; stop at first successful parse.
      if (obj.type === 'result' || obj.num_turns !== undefined) break;
    } catch {
      // Non-JSON line (shouldn't happen with --output-format json but
      // belt-and-braces). Continue scanning upward.
    }
  }

  return { turns, costCents };
}
