/**
 * F153 — Backup provider factory + env-driven config reader.
 *
 * A provider is built only when the env vars that identify its
 * destination are all populated. Missing config returns `{ type: 'off' }`
 * so callers can cleanly disable the whole feature on startup without
 * branching through a cascade of `if (!x)`.
 */

import type { BackupProvider, BackupProviderConfig } from './types.js';

export type {
  BackupProvider,
  BackupProviderConfig,
  CloudBackupFile,
  R2ProviderConfig,
} from './types.js';

/**
 * Build the concrete provider. Dynamic-imports the adapter so the AWS
 * SDK stays off the cold-boot path when backups are disabled.
 */
export async function createBackupProvider(
  config: BackupProviderConfig,
): Promise<BackupProvider> {
  switch (config.type) {
    case 'r2': {
      if (!config.r2) throw new Error('R2 config missing');
      const { R2BackupProvider } = await import('./r2.js');
      return new R2BackupProvider(config.r2);
    }
    default:
      throw new Error(`Unknown backup provider: ${config.type}`);
  }
}

/**
 * Read the TRAIL_BACKUP_* env vars into a BackupProviderConfig. Returns
 * `{ type: 'off' }` unless every R2 field is set.
 */
export function readBackupConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BackupProviderConfig {
  const endpoint = env.TRAIL_BACKUP_R2_ENDPOINT;
  const bucket = env.TRAIL_BACKUP_R2_BUCKET;
  const accessKeyId = env.TRAIL_BACKUP_R2_ACCESS_KEY_ID;
  const secretAccessKey = env.TRAIL_BACKUP_R2_SECRET_ACCESS_KEY;
  const prefix = env.TRAIL_BACKUP_R2_PREFIX;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return { type: 'off' };
  }

  return {
    type: 'r2',
    r2: {
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      prefix: prefix || undefined,
    },
  };
}
