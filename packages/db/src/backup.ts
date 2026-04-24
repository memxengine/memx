/**
 * F153 — DB snapshot primitive.
 *
 * Produces a consistent, gzipped snapshot of a running libSQL database via
 * SQLite's `VACUUM INTO`. The pipeline is:
 *
 *   1. `VACUUM INTO '<path>'` — SQLite's canonical online-snapshot primitive.
 *      Safe while other clients read/write. Emits a single self-contained
 *      `.db` file (no `-wal`, no `-shm`). Briefly holds a write lock at the
 *      end; normal writers queue via `PRAGMA busy_timeout`.
 *      https://sqlite.org/lang_vacuum.html#vacuuminto
 *   2. Open the snapshot with a fresh libSQL client (different file = no
 *      contention with the live engine) and assert `PRAGMA integrity_check
 *      = 'ok'`. Abort + cleanup on failure.
 *   3. Stream the `.db` through `zlib.createGzip` to `.db.gz` on disk, then
 *      unlink the uncompressed file. SHA-256 of the gzip is computed from
 *      the written file so callers can verify upload round-trips.
 *
 * Deliberately not on the `TrailDatabase` interface: `VACUUM INTO` is
 * SQLite-specific, and a future Postgres adapter (F40.2 land) would need a
 * fundamentally different mechanism (`pg_dump`, etc.). The free-function +
 * typed client accessor pair keeps the abstraction honest.
 */

import { createClient, type Client as LibSqlClient } from '@libsql/client';
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export interface SnapshotResult {
  /** Absolute path to the gzipped snapshot file on disk. */
  path: string;
  /** Byte size of the `.db.gz` file. */
  compressedBytes: number;
  /** Byte size of the uncompressed `.db` before gzip. */
  uncompressedBytes: number;
  /** SHA-256 hex of the `.db.gz` — for round-trip verification on upload. */
  sha256: string;
  /** `Date.now()` captured just before `VACUUM INTO` ran. */
  snappedAt: number;
}

export interface SnapshotOptions {
  /** gzip compression level 1–9. Default 6 (CMS convention). */
  gzipLevel?: number;
  /** Custom filename (without extension). Default: `snapshot-<ts>`. */
  basename?: string;
}

/**
 * Snapshot a live libSQL DB to `<outDir>/<basename>.db.gz`.
 *
 * @param source — the live libSQL client (e.g. `LibsqlTrailDatabase.sqliteClient`).
 * @param outDir — staging directory. Created recursively if missing.
 * @param opts — optional gzip level + custom basename.
 */
export async function snapshotDb(
  source: LibSqlClient,
  outDir: string,
  opts: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const absOutDir = isAbsolute(outDir) ? outDir : resolve(outDir);
  mkdirSync(absOutDir, { recursive: true });

  const snappedAt = Date.now();
  const basename = opts.basename ?? `snapshot-${snappedAt}`;
  const rawPath = join(absOutDir, `${basename}.db`);
  const gzPath = `${rawPath}.gz`;

  // Escape single quotes so pathological outDir characters can't break the
  // SQL literal. Parameter binding on VACUUM INTO works in modern SQLite
  // but we avoid it to keep the code identical across libSQL minor versions.
  const escaped = rawPath.replace(/'/g, "''");
  await source.execute(`VACUUM INTO '${escaped}'`);

  let uncompressedBytes: number;
  try {
    uncompressedBytes = statSync(rawPath).size;
  } catch (err) {
    throw new Error(`VACUUM INTO did not produce ${rawPath}: ${stringifyErr(err)}`);
  }

  // Integrity check via a fresh client. Different URL = different handle,
  // so there's no write-lock contention with the source engine.
  const checkClient = createClient({ url: `file:${rawPath}` });
  try {
    const result = await checkClient.execute('PRAGMA integrity_check');
    const firstRow = result.rows[0];
    const firstCol = firstRow ? Object.values(firstRow)[0] : undefined;
    if (firstCol !== 'ok') {
      throw new Error(
        `snapshot integrity_check != 'ok' for ${rawPath}: ${JSON.stringify(result.rows)}`,
      );
    }
  } finally {
    checkClient.close();
  }

  // Stream .db -> gzip -> .db.gz. Never buffers the whole DB in memory.
  try {
    await pipeline(
      createReadStream(rawPath),
      createGzip({ level: opts.gzipLevel ?? 6 }),
      createWriteStream(gzPath),
    );
  } finally {
    // Always unlink the uncompressed copy, success or failure.
    await unlink(rawPath).catch(() => {});
  }

  const compressedBytes = statSync(gzPath).size;
  const sha256 = await sha256File(gzPath);

  return { path: gzPath, compressedBytes, uncompressedBytes, sha256, snappedAt };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
