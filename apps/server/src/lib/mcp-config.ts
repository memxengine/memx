import { join, resolve } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { DATA_DIR } from '@memx/db';

/**
 * Writes a `.mcp.json` config file that claude CLI uses to spawn the memx MCP
 * server. The config is static (no per-request env) — we propagate tenant/user
 * context through the spawnClaude env, which claude CLI in turn inherits into
 * the MCP subprocess.
 *
 * Returns the absolute path to the config file. Idempotent: safe to call on
 * every boot; rewrites the file so path changes in the repo layout are picked up.
 */
export function ensureMcpConfig(): string {
  const mcpEntry = resolve(
    process.env.MEMX_MCP_ENTRY ??
      join(process.cwd(), '..', 'mcp', 'src', 'index.ts'),
  );

  if (!existsSync(mcpEntry)) {
    console.warn(
      `[mcp] MCP entry not found at ${mcpEntry} — ingest will fail. Set MEMX_MCP_ENTRY to override.`,
    );
  }

  const bunBin = process.env.BUN_BIN ?? 'bun';
  const config = {
    mcpServers: {
      memx: {
        command: bunBin,
        args: ['run', mcpEntry],
      },
    },
  };

  const configPath = join(DATA_DIR, 'mcp.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
