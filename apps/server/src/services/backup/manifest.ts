/**
 * F153 — Backup manifest (data/backups/manifest.json).
 *
 * Newest-first list of every snapshot we've ever taken. Written
 * atomically via write-to-tmp + rename so a crash mid-write leaves the
 * old manifest intact. A missing file is treated as "no snapshots yet".
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface BackupSnapshot {
  /** trail_<YYYY-MM-DD>_<HHmm>_<6hex> */
  id: string;
  /** ISO 8601 UTC */
  snappedAt: string;
  trigger: 'manual' | 'scheduled';
  uncompressedBytes: number;
  compressedBytes: number;
  sha256: string;
  /** Absolute path to the local `.db.gz` (null once pruned locally). */
  localPath: string | null;
  /** r2://bucket/prefix/<id>.db.gz — null if upload never succeeded. */
  remoteUrl: string | null;
  status: 'snapping' | 'uploading' | 'uploaded' | 'failed' | 'pruned-remote';
  error?: string;
}

export interface BackupManifest {
  /** Newest first. */
  snapshots: BackupSnapshot[];
}

export function manifestPath(dataDir: string): string {
  return join(dataDir, 'backups', 'manifest.json');
}

export async function readManifest(dataDir: string): Promise<BackupManifest> {
  const p = manifestPath(dataDir);
  if (!existsSync(p)) return { snapshots: [] };
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as BackupManifest;
    if (!Array.isArray(parsed.snapshots)) return { snapshots: [] };
    return parsed;
  } catch (err) {
    // Corrupt manifest shouldn't brick the scheduler. Log + start fresh.
    console.error('[backup/manifest] failed to parse manifest, starting fresh:', err);
    return { snapshots: [] };
  }
}

/**
 * Atomic write: dump JSON to a `.tmp` sibling, then `rename` over the
 * real path. A crash before the rename leaves the old manifest intact;
 * a crash after leaves the new one fully-written. Never a torn JSON.
 */
export async function writeManifest(
  dataDir: string,
  manifest: BackupManifest,
): Promise<void> {
  const p = manifestPath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2));
  await rename(tmp, p);
}

export async function appendSnapshot(
  dataDir: string,
  snapshot: BackupSnapshot,
): Promise<void> {
  const manifest = await readManifest(dataDir);
  manifest.snapshots.unshift(snapshot);
  await writeManifest(dataDir, manifest);
}

export async function updateSnapshot(
  dataDir: string,
  id: string,
  patch: Partial<BackupSnapshot>,
): Promise<BackupSnapshot | null> {
  const manifest = await readManifest(dataDir);
  const idx = manifest.snapshots.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const current = manifest.snapshots[idx];
  if (!current) return null;
  const next: BackupSnapshot = { ...current, ...patch };
  manifest.snapshots[idx] = next;
  await writeManifest(dataDir, manifest);
  return next;
}
