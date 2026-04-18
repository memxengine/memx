import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, existsSync } from 'node:fs';
import { DATA_DIR } from '@trail/db';

/**
 * Writes a `.mcp.json` config file that claude CLI uses to spawn the trail MCP
 * server. The config is static (no per-request env) — we propagate tenant/user
 * context through the spawnClaude env, which claude CLI in turn inherits into
 * the MCP subprocess.
 *
 * Returns the absolute path to the config file. Idempotent: safe to call on
 * every boot; rewrites the file so path changes in the repo layout are picked up.
 */
export function ensureMcpConfig(): string {
  // Resolve the MCP entry relative to THIS file's location, not
  // process.cwd(). Earlier version used cwd which broke when scripts
  // (e.g. reprocess-source.ts) were launched from the repo root —
  // cwd-relative path then pointed at /apps/mcp/... instead of
  // /apps/server/../mcp/... Same pattern as chat.ts's MCP_SERVER_PATH.
  // TRAIL_MCP_ENTRY env still wins for overrides in unusual layouts.
  const THIS_DIR = dirname(fileURLToPath(import.meta.url));
  const mcpEntry = resolve(
    process.env.TRAIL_MCP_ENTRY ??
      join(THIS_DIR, '..', '..', '..', 'mcp', 'src', 'index.ts'),
  );

  if (!existsSync(mcpEntry)) {
    console.warn(
      `[mcp] MCP entry not found at ${mcpEntry} — ingest will fail. Set TRAIL_MCP_ENTRY to override.`,
    );
  }

  const bunBin = process.env.BUN_BIN ?? 'bun';
  const config = {
    mcpServers: {
      trail: {
        command: bunBin,
        args: ['run', mcpEntry],
      },
    },
  };

  const configPath = join(DATA_DIR, 'mcp.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
