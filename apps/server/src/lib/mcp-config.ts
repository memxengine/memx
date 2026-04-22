import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { DATA_DIR } from '@trail/db';

/**
 * Writes a `.mcp.json` config file that claude CLI uses to spawn the trail MCP
 * server.
 *
 * Claude CLI's MCP-spawn does NOT inherit env from the parent claude process
 * — it only reads the mcp-config file's explicit `env` block. That means any
 * dynamic context (TRAIL_INGEST_JOB_ID, job-specific connector, etc.) MUST be
 * baked into the config file before spawnClaude sees it. The default file
 * (ensureMcpConfig) is static for chat + generic uses; writeIngestMcpConfig
 * is the per-ingest variant that bakes the jobId in.
 *
 * Returns the absolute path to the config file.
 */
export function ensureMcpConfig(): string {
  return writeMcpConfig('mcp.json', {});
}

/**
 * Per-ingest variant — bakes job-specific env (jobId, connector, tenant/kb
 * context) into the config's `env` block so the MCP subprocess sees them.
 * Uses a unique filename per job so concurrent ingests (different KBs) don't
 * race on a shared config file. Caller owns cleanup via
 * `cleanupIngestMcpConfig(jobId)` when the ingest finishes.
 */
export function writeIngestMcpConfig(opts: {
  ingestJobId: string;
  tenantId: string;
  userId: string;
  knowledgeBaseId: string;
  dataDir: string;
  connector?: string;
}): string {
  return writeMcpConfig(`mcp-${opts.ingestJobId}.json`, {
    TRAIL_TENANT_ID: opts.tenantId,
    TRAIL_USER_ID: opts.userId,
    TRAIL_KNOWLEDGE_BASE_ID: opts.knowledgeBaseId,
    TRAIL_DATA_DIR: opts.dataDir,
    TRAIL_CONNECTOR: opts.connector ?? 'upload',
    TRAIL_INGEST_JOB_ID: opts.ingestJobId,
  });
}

/** Best-effort delete of the per-job config. Missing file is not an error. */
export function cleanupIngestMcpConfig(ingestJobId: string): void {
  const path = join(DATA_DIR, `mcp-${ingestJobId}.json`);
  try {
    unlinkSync(path);
  } catch {
    // File already gone, or never written — harmless either way.
  }
}

function writeMcpConfig(filename: string, env: Record<string, string>): string {
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
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    },
  };

  const configPath = join(DATA_DIR, filename);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
