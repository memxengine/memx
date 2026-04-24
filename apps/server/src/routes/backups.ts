/**
 * F153 — Admin backup routes.
 *
 * Phase 2 scope: manual trigger + list + test-connection. Download,
 * delete, and the scheduler itself land in Phase 3/4.
 *
 * Auth: `requireAuth` (session or API key), then reject non-owners. In
 * F40.1 single-tenant Christian is always owner so this is effectively
 * owner-only already; the explicit role guard is belt-and-suspenders
 * for F40.2 multi-tenant and for any curator-role tokens that might get
 * created via F111 API keys.
 */

import { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getTrail, getUser, requireAuth } from '../middleware/auth.js';
import { createBackupProvider, readBackupConfigFromEnv } from '../services/backup/providers/index.js';
import { readManifest } from '../services/backup/manifest.js';
import { runBackupPass } from '../services/backup/pass.js';

export const backupRoutes = new Hono();

backupRoutes.use('*', requireAuth);

backupRoutes.use('*', async (c, next) => {
  const user = getUser(c);
  if (user.role !== 'owner') {
    return c.json({ error: 'forbidden', message: 'backup admin requires owner role' }, 403);
  }
  await next();
});

/**
 * GET /admin/backups — return the manifest + a few derived totals so the
 * Settings panel can render without a second round-trip.
 */
backupRoutes.get('/admin/backups', async (c) => {
  const dataDir = resolveDataDir();
  const manifest = await readManifest(dataDir);
  const uploaded = manifest.snapshots.filter((s) => s.status === 'uploaded');
  const lastSuccess = uploaded[0]?.snappedAt ?? null;
  const totalRemoteBytes = uploaded.reduce((n, s) => n + s.compressedBytes, 0);
  const config = readBackupConfigFromEnv();
  return c.json({
    configured: config.type !== 'off',
    providerType: config.type,
    snapshots: manifest.snapshots,
    totals: {
      count: uploaded.length,
      totalRemoteBytes,
      lastSuccess,
    },
  });
});

/**
 * POST /admin/backups — run a manual snapshot + upload end-to-end. Blocks
 * until the upload finishes. 60s is an aggressive timeout for a small DB;
 * real deployments may want this backgrounded with SSE, but synchronous
 * is fine for MVP single-tenant.
 */
backupRoutes.post('/admin/backups', async (c) => {
  const config = readBackupConfigFromEnv();
  if (config.type === 'off') {
    return c.json(
      { error: 'not_configured', message: 'TRAIL_BACKUP_R2_* env vars are not populated' },
      503,
    );
  }

  const trail = getTrail(c);
  const dataDir = resolveDataDir();
  const { stagingDir, localDir } = ensureBackupDirs(dataDir);
  const provider = await createBackupProvider(config);

  const result = await runBackupPass({
    dbPath: trail.path,
    dataDir,
    stagingDir,
    localDir,
    provider,
    trigger: 'manual',
  });

  if (!result.ok) {
    return c.json({ error: 'backup_failed', snapshot: result.snapshot, message: result.error }, 500);
  }
  return c.json({ snapshot: result.snapshot });
});

/**
 * POST /admin/backups/test — verify R2 connectivity + permissions. No
 * side effects. Used by the Settings panel.
 */
backupRoutes.post('/admin/backups/test', async (c) => {
  const config = readBackupConfigFromEnv();
  if (config.type === 'off') {
    return c.json({ ok: false, message: 'TRAIL_BACKUP_R2_* env vars are not populated' });
  }
  const provider = await createBackupProvider(config);
  const result = await provider.test();
  return c.json(result);
});

function resolveDataDir(): string {
  return process.env.TRAIL_DATA_DIR ?? join(process.cwd(), 'data');
}

function ensureBackupDirs(dataDir: string): { stagingDir: string; localDir: string } {
  const root = join(dataDir, 'backups');
  const stagingDir = join(root, 'staging');
  const localDir = join(root, 'local');
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(localDir, { recursive: true });
  // Also create the parent of manifest.json — readManifest tolerates
  // missing file but writeManifest needs the directory.
  mkdirSync(dirname(join(root, 'manifest.json')), { recursive: true });
  return { stagingDir, localDir };
}
