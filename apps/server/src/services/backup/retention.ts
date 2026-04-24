/**
 * F153 — Retention pruning.
 *
 * Two independent axes:
 *   - local: keep the newest `localKeep` uploaded snapshots on disk,
 *     delete the rest. Manifest rows stay (with `localPath=null`) so
 *     the remote copy is still reachable.
 *   - remote: delete R2 objects older than `retainDays`. Mark those
 *     manifest rows as `status='pruned-remote'` with both `localPath`
 *     and `remoteUrl` cleared.
 *
 * Both axes ignore rows whose status is `snapping | uploading | failed`
 * — those represent in-flight or broken work and are not eligible for
 * retention prune. `failed` rows are kept so a human can diagnose; the
 * scheduler re-creates fresh snapshots each pass.
 *
 * Pure-ish: takes an optional `now` so tests can inject a fixed clock.
 */

import { unlink } from 'node:fs/promises';
import type { BackupProvider } from './providers/types.js';
import {
  readManifest,
  updateSnapshot,
  writeManifest,
  type BackupSnapshot,
} from './manifest.js';

export interface PruneInput {
  dataDir: string;
  provider: BackupProvider;
  /** Keep at most N uploaded snapshots on local disk. Default 3. */
  localKeep: number;
  /** Delete remote objects older than N days. Default 30. */
  retainDays: number;
  /** Injectable clock for tests. Defaults to Date.now(). */
  now?: number;
}

export interface PruneResult {
  prunedLocalFiles: number;
  prunedRemoteObjects: number;
  errors: string[];
}

export async function pruneRetention(input: PruneInput): Promise<PruneResult> {
  const now = input.now ?? Date.now();
  const errors: string[] = [];
  let prunedLocalFiles = 0;
  let prunedRemoteObjects = 0;

  const manifest = await readManifest(input.dataDir);

  // ── Remote retention (operates first; modifies status) ──────────
  const cutoff = now - input.retainDays * 24 * 60 * 60 * 1000;
  for (const snap of manifest.snapshots) {
    if (snap.status !== 'uploaded') continue;
    const snappedMs = Date.parse(snap.snappedAt);
    if (!Number.isFinite(snappedMs)) continue;
    if (snappedMs >= cutoff) continue; // still within retention window

    const filename = `${snap.id}.db.gz`;
    try {
      await input.provider.delete(filename);
    } catch (err) {
      errors.push(`remote delete ${filename}: ${stringifyErr(err)}`);
      continue; // leave status='uploaded'; next pass will retry
    }

    // Also unlink the local copy if still present.
    if (snap.localPath) {
      await unlink(snap.localPath).catch(() => {});
    }
    await updateSnapshot(input.dataDir, snap.id, {
      status: 'pruned-remote',
      localPath: null,
      remoteUrl: null,
    });
    prunedRemoteObjects++;
  }

  // ── Local retention (operates on a fresh read so we see the
  // updates above). Keep newest-N by snappedAt among uploaded rows. ─
  const fresh = await readManifest(input.dataDir);
  const uploadedNewestFirst = fresh.snapshots
    .filter((s) => s.status === 'uploaded' && s.localPath !== null)
    .sort((a, b) => (a.snappedAt < b.snappedAt ? 1 : -1));

  const toDelete = uploadedNewestFirst.slice(Math.max(0, input.localKeep));
  for (const snap of toDelete) {
    if (!snap.localPath) continue;
    try {
      await unlink(snap.localPath);
      prunedLocalFiles++;
      await updateSnapshot(input.dataDir, snap.id, { localPath: null });
    } catch (err) {
      errors.push(`local unlink ${snap.localPath}: ${stringifyErr(err)}`);
    }
  }

  return { prunedLocalFiles, prunedRemoteObjects, errors };
}

/**
 * Smaller helper: sort uploaded snapshots by snappedAt desc. Exported
 * for tests / UI code that wants to show "newest successful backup".
 */
export function sortUploadedDesc(snapshots: BackupSnapshot[]): BackupSnapshot[] {
  return [...snapshots]
    .filter((s) => s.status === 'uploaded')
    .sort((a, b) => (a.snappedAt < b.snappedAt ? 1 : -1));
}

/** Exported so lint-scheduler's logging can use the same function. */
export async function rewriteManifest(
  dataDir: string,
  transform: (m: { snapshots: BackupSnapshot[] }) => { snapshots: BackupSnapshot[] },
): Promise<void> {
  const m = await readManifest(dataDir);
  await writeManifest(dataDir, transform(m));
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
