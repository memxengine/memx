/**
 * F153 — One end-to-end backup pass.
 *
 * Takes a fresh VACUUM-INTO snapshot of the running DB (via a DISTINCT
 * libSQL client — see the "Gotcha discovered in Phase 1" note in the
 * plan-doc), uploads the gzipped result to the configured provider, and
 * records the whole lifecycle in the manifest.
 *
 * Used from both:
 *   - `POST /api/admin/backups` (trigger='manual')
 *   - the scheduler (Phase 3, trigger='scheduled')
 *
 * Phase 2 scope: snapshot + upload + manifest. Retention pruning lands
 * with the scheduler.
 */

import { createClient } from '@libsql/client';
import { snapshotDb, type SnapshotResult } from '@trail/db';
import { createReadStream, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupProvider } from './providers/types.js';
import { appendSnapshot, updateSnapshot, type BackupSnapshot } from './manifest.js';

export interface BackupPassInput {
  /** Path to the engine's SQLite file (e.g. `trail.path`). */
  dbPath: string;
  /** Root data directory — the manifest lives under `<dataDir>/backups/`. */
  dataDir: string;
  /** Where to stage the .db.gz before upload. */
  stagingDir: string;
  /** Where the final on-disk copy lives after a successful upload. */
  localDir: string;
  provider: BackupProvider;
  trigger: 'manual' | 'scheduled';
}

export interface BackupPassResult {
  snapshot: BackupSnapshot;
  ok: boolean;
  error?: string;
}

/** Short stable id suitable for filenames + URLs. */
export function newSnapshotId(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const HH = String(now.getUTCHours()).padStart(2, '0');
  const MM = String(now.getUTCMinutes()).padStart(2, '0');
  const short = randomBytes(3).toString('hex');
  return `trail_${yyyy}-${mm}-${dd}_${HH}${MM}_${short}`;
}

export async function runBackupPass(input: BackupPassInput): Promise<BackupPassResult> {
  const { dbPath, dataDir, stagingDir, localDir, provider, trigger } = input;

  const id = newSnapshotId();
  const snappedAtIso = new Date().toISOString();
  const filename = `${id}.db.gz`;

  const snapshot: BackupSnapshot = {
    id,
    snappedAt: snappedAtIso,
    trigger,
    uncompressedBytes: 0,
    compressedBytes: 0,
    sha256: '',
    localPath: null,
    remoteUrl: null,
    status: 'snapping',
  };
  await appendSnapshot(dataDir, snapshot);

  // ── Snapshot ────────────────────────────────────────────────────
  // MUST use a distinct libSQL client — taking VACUUM INTO through the
  // engine's own connection hangs when there's concurrent write traffic.
  const backupClient = createClient({ url: `file:${dbPath}` });
  let snap: SnapshotResult;
  try {
    snap = await snapshotDb(backupClient, stagingDir, { basename: id });
  } catch (err) {
    const msg = stringifyErr(err);
    await updateSnapshot(dataDir, id, { status: 'failed', error: `snapshot: ${msg}` });
    return { snapshot: { ...snapshot, status: 'failed', error: `snapshot: ${msg}` }, ok: false, error: msg };
  } finally {
    backupClient.close();
  }

  await updateSnapshot(dataDir, id, {
    status: 'uploading',
    uncompressedBytes: snap.uncompressedBytes,
    compressedBytes: snap.compressedBytes,
    sha256: snap.sha256,
  });

  // ── Upload ──────────────────────────────────────────────────────
  let uploadKey: string;
  try {
    const stream = createReadStream(snap.path);
    const result = await provider.upload(filename, stream, snap.compressedBytes);
    uploadKey = result.key;
  } catch (err) {
    const msg = stringifyErr(err);
    // Leave the staged .db.gz on disk — the admin can retry manually.
    await updateSnapshot(dataDir, id, { status: 'failed', error: `upload: ${msg}` });
    return {
      snapshot: {
        ...snapshot,
        status: 'failed',
        error: `upload: ${msg}`,
        uncompressedBytes: snap.uncompressedBytes,
        compressedBytes: snap.compressedBytes,
        sha256: snap.sha256,
      },
      ok: false,
      error: msg,
    };
  }

  // ── Move staged -> local keep-dir ───────────────────────────────
  // The local copy is useful for quick restore (no re-download) and
  // survives until retention prunes it. Rename is O(1) on the same FS.
  const localPath = join(localDir, filename);
  try {
    await rename(snap.path, localPath);
  } catch (err) {
    // If rename fails (cross-device, permissions), keep the staging
    // path and let the manifest point to it.
    console.warn('[backup/pass] rename staging→local failed:', stringifyErr(err));
  }
  const finalLocalPath = statSyncSafe(localPath) ? localPath : snap.path;

  const final = await updateSnapshot(dataDir, id, {
    status: 'uploaded',
    localPath: finalLocalPath,
    remoteUrl: `r2://${bucketFromKey(provider, uploadKey)}`,
  });

  return { snapshot: final ?? snapshot, ok: true };
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statSyncSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Build a user-readable r2://bucket/key URL. We don't have the bucket
 * name on `BackupProvider`, so we reconstruct from the key (the provider
 * already prefixed it).
 */
function bucketFromKey(provider: BackupProvider, key: string): string {
  // Provider `name` is of the form "R2 (trail-backups)" — extract inside.
  const match = /\(([^)]+)\)/.exec(provider.name);
  const bucket = match?.[1] ?? 'unknown';
  return `${bucket}/${key}`;
}

/** Helper exported for tests + the /delete endpoint (Phase 3). */
export async function unlinkQuietly(path: string): Promise<void> {
  await unlink(path).catch(() => {});
}
