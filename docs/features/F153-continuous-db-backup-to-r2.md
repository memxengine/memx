# F153 — Continuous online backup of `trail.db` to Cloudflare R2

> Scheduled, WAL-safe online snapshots of the master Trail SQLite DB, compressed and uploaded to our own Cloudflare R2 bucket (`trail-backups`) while the server stays running. Reuses the S3-compatible backup pattern from `@webhouse/cms` (F27 + F95). Tier: all. Effort: Small (1.5–2 days). Status: Planned.

## Problem

`data/trail.db` is the single source of truth for every tenant-aware table in the Trail engine — KBs, documents, Neurons, queue candidates, chat sessions, backlinks, access telemetry, broken_links, work-layer rows, the lot. A lost or corrupted file is an unrecoverable loss of the entire knowledge graph for every brain on the instance.

Today there is **no backup**. `cp data/trail.db backup.db` is not safe while the server runs:

- libSQL opens the client in WAL journal mode (`PRAGMA journal_mode = WAL` in `packages/db/src/libsql-adapter.ts:118`). Uncommitted writes live in `trail.db-wal` and are only merged into the main file at checkpoint time — a naive `cp` of just `trail.db` misses the most recent writes.
- Copying all three files (`trail.db`, `trail.db-wal`, `trail.db-shm`) while the engine is actively writing can tear: the `-wal` file can grow or be truncated mid-copy, producing an inconsistent snapshot that fails to open.
- Even if we got a clean cold snapshot, we have no **off-site** copy. A failed disk on the Fly.io volume (when F33 ships) or an `rm -rf data/` typo on the dev machine wipes Christian's entire Trail corpus.

When Sanne (F37) and FysioDK (F52) onboard, running Trail without a verified off-site backup is an unacceptable risk.

## Secondary Pain Points

- `apps/server/data/trail.db` is a second copy of the same schema in some checkouts — confusion about which is canonical has bitten us before when scripts read one while the server wrote the other. A backup workflow forces us to be explicit about the master path.
- The lint-scheduler, action-recommender, and queue-backfill all keep growing the DB file (access telemetry, recommendations, chat history). A scheduled snapshot gives us a size trend line we can chart.
- On-disk-only state is brittle for single-tenant multi-device use: if Christian wants to clone his local brain to a new Mac, a tarball of `data/` while the server runs is unsafe. A recent uploaded snapshot is a reproducible restore point.
- F33 (Fly.io deploy) and F40 (multi-tenant libSQL) will both want this machinery; shipping it now while the surface area is small means F33 just gets it for free.

## Solution

A small new service `backup-scheduler` wakes on a configurable interval (default **6h**), calls SQLite's `VACUUM INTO '…'` against the running DB to produce a consistent single-file snapshot (the SQLite-canonical online-backup primitive — safe while writers are active, no WAL companion file emitted), gzips it, streams the compressed file to a Cloudflare R2 bucket via `@aws-sdk/client-s3`, records the snapshot in a small manifest, and prunes old local + remote snapshots by retention policy. Manual trigger + listing + download lives behind admin-only HTTP routes and a settings panel. Restore is **manual** via a documented CLI script (see Non-Goals).

We reuse the `BackupProvider` interface shape from `@webhouse/cms/packages/cms-admin/src/lib/backup/providers/types.ts` so a future pCloud/WebDAV/S3 adapter is a drop-in.

## Non-Goals

- **Automated point-in-time restore into a running server.** Restore requires the server to stop (to release the libSQL write lock) and atomically swap the DB file. We ship a CLI script (`scripts/restore-backup.ts`) that operates on a stopped engine. One-click restore from the admin UI is out of scope; too easy to click by accident, too dangerous without a confirmation flow we don't have yet.
- **Per-tenant backups.** F40.1 is one DB per process. When F40.2 lands (per-tenant libSQL files), F153 will loop over all tenant DBs — but that is an extension, not this feature. This feature backs up the single master DB.
- **Incremental / WAL-only backups.** Each snapshot is a full copy of the DB. The DB is small enough (O(10–100MB) today) that full snapshots at 6h cadence are cheap in R2 cost and much simpler to reason about than WAL-shipping.
- **Encryption at rest.** R2 encrypts at rest server-side. Client-side encryption of the snapshot before upload is an F81 (per-KB encryption) concern, not this feature.
- **Deleted-data recovery beyond the retention window.** 30-day default retention means a row deleted 40 days ago is unrecoverable. Users who need longer retention bump `BACKUP_RETAIN_DAYS`. No tiered cold storage.
- **Cross-region replication.** One bucket, one region (`arn` — Cloudflare auto-distributes R2 globally anyway for reads). No multi-bucket replication in this feature.
- **Backing up `packages/storage/local-uploads/` (source blobs / uploaded PDFs).** F42 (Pluggable Storage) is the pathway for that — object-storage blobs live in R2/Tigris already once F42 ships. F153 backs up the DB only.
- **Backing up the per-KB Obsidian-vault export under `/neurons/…`.** That's F100's domain; it's already reconstructible from the DB.

## Technical Design

### Snapshot primitive — `packages/db/src/backup.ts` (new)

```typescript
import { Client as LibSqlClient } from '@libsql/client';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createClient } from '@libsql/client';

export interface SnapshotResult {
  /** Absolute path to the gzipped snapshot file. */
  path: string;
  /** Bytes on disk (after gzip). */
  compressedBytes: number;
  /** Bytes of the raw .db before gzip. */
  uncompressedBytes: number;
  /** SHA-256 of the .db.gz — used to verify upload round-trip. */
  sha256: string;
  /** Epoch ms at which the VACUUM INTO completed. */
  snappedAt: number;
}

/**
 * Produce a consistent, gzipped snapshot of the running libSQL DB.
 *
 *  1. VACUUM INTO '{tmpDir}/snapshot-{ts}.db' — SQLite's canonical online
 *     snapshot primitive. Takes a brief write lock; safe while other
 *     clients are reading/writing. Emits a single self-contained .db file
 *     (no -wal, no -shm) representing the DB at the moment VACUUM
 *     completes.
 *  2. PRAGMA integrity_check on the snapshot (opened via a fresh libSQL
 *     client). Abort if not "ok".
 *  3. Gzip .db → .db.gz streamed to disk. Delete the uncompressed .db.
 *  4. Return {path, sizes, sha256}.
 *
 * Caller owns the file lifecycle (upload + delete).
 */
export async function snapshotDb(
  source: LibSqlClient,
  outDir: string,
): Promise<SnapshotResult> {
  mkdirSync(outDir, { recursive: true });
  const ts = Date.now();
  const rawPath = join(outDir, `snapshot-${ts}.db`);
  const gzPath = `${rawPath}.gz`;

  // VACUUM INTO is the SQLite online-snapshot primitive. Documented:
  // https://sqlite.org/lang_vacuum.html#vacuuminto — "the output of
  // VACUUM INTO is a complete copy of the source database".
  await source.execute({ sql: `VACUUM INTO ?`, args: [rawPath] });

  // Open snapshot with a fresh client to run integrity_check. A libSQL
  // client pinned to a different file means we aren't racing the live
  // engine's write lock.
  const checkClient = createClient({ url: `file:${rawPath}` });
  try {
    const integrity = await checkClient.execute('PRAGMA integrity_check');
    const first = integrity.rows[0]?.[Object.keys(integrity.rows[0] ?? {})[0]];
    if (first !== 'ok') {
      throw new Error(`snapshot integrity_check failed: ${JSON.stringify(integrity.rows)}`);
    }
  } finally {
    checkClient.close();
  }

  const uncompressedBytes = statSync(rawPath).size;

  // Stream .db → gzip → .db.gz. Avoids pulling a multi-MB DB into memory.
  await pipeline(createReadStream(rawPath), createGzip({ level: 6 }), createWriteStream(gzPath));
  await unlink(rawPath);

  const compressedBytes = statSync(gzPath).size;
  const sha256 = await hashFile(gzPath);

  return { path: gzPath, compressedBytes, uncompressedBytes, sha256, snappedAt: ts };
}

async function hashFile(path: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
```

### R2 provider — `apps/server/src/services/backup/providers/r2.ts` (new)

Direct lift from `@webhouse/cms/packages/cms-admin/src/lib/backup/providers/s3.ts` with the preset `{ region: 'auto' }` for R2. Multipart upload via `@aws-sdk/lib-storage` because snapshots can exceed the 5 MB PutObject cap once the DB grows:

```typescript
import type { BackupProvider, CloudBackupFile, R2ProviderConfig } from './types.js';

export class R2BackupProvider implements BackupProvider {
  readonly id = 'r2';
  readonly name: string;
  private readonly prefix: string;

  constructor(private readonly config: R2ProviderConfig) {
    this.prefix = (config.prefix ?? 'trail-db/').replace(/\/?$/, '/');
    this.name = `R2 (${config.bucket})`;
  }

  async upload(filename: string, body: ReadableStream | Buffer, contentLength: number) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const { Upload } = await import('@aws-sdk/lib-storage');
    const client = new S3Client({
      endpoint: this.config.endpoint, // https://<account>.r2.cloudflarestorage.com
      region: 'auto',
      credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
      forcePathStyle: true,
    });
    const key = `${this.prefix}${filename}`;
    await new Upload({
      client,
      params: { Bucket: this.config.bucket, Key: key, Body: body, ContentType: 'application/gzip' },
      queueSize: 4,
      partSize: 8 * 1024 * 1024, // 8 MB parts
    }).done();
    return { url: `r2://${this.config.bucket}/${key}`, size: contentLength };
  }

  async list(): Promise<CloudBackupFile[]> { /* ListObjectsV2, filter .db.gz */ }
  async download(filename: string): Promise<ReadableStream> { /* GetObject */ }
  async delete(filename: string): Promise<void> { /* DeleteObject */ }
  async test(): Promise<{ ok: boolean; message: string }> { /* HeadBucket */ }
}
```

Interface (`types.ts`) mirrors the CMS pattern exactly so other S3-compatible backends drop in without touching the scheduler.

### Scheduler — `apps/server/src/services/backup-scheduler.ts` (new)

Pattern mirrors `startLintScheduler` (see `apps/server/src/services/lint-scheduler.ts:85-172`). Returns a `stop()` function. Bootstraps in `apps/server/src/index.ts` next to the other scheduled services.

**Gotcha discovered in Phase 1 verification:** `VACUUM INTO` on the *same* libSQL connection that the engine is actively writing to **hangs indefinitely**. The scheduler therefore MUST open a distinct libSQL client pointed at the same DB file for each backup pass, take the snapshot through that client, and close it. `trail.sqliteClient` (the engine's writer connection) is off-limits for snapshots. The extra client is cheap — libSQL handles per-file concurrency via WAL — but the snapshot path is physically separate from the engine's write path:

```typescript
import { createClient } from '@libsql/client';
// inside runBackupPass:
const backupClient = createClient({ url: `file:${trail.path}` });
try {
  const snap = await snapshotDb(backupClient, stagingDir);
  // …upload snap.path to R2, update manifest, prune…
} finally {
  backupClient.close();
}
```

This means `LibsqlTrailDatabase.sqliteClient` is kept as an accessor for completeness but **unused by the scheduler itself**. It remains useful for future in-process operations that don't race with writers (e.g. ad-hoc diagnostics).

```typescript
export function startBackupScheduler(trail: TrailDatabase): () => void {
  const hours = Number(process.env.TRAIL_BACKUP_INTERVAL_HOURS ?? '6');
  if (hours <= 0 || !r2Configured()) {
    console.log('  backup-scheduler: disabled (TRAIL_BACKUP_INTERVAL_HOURS=0 or R2 not configured)');
    return () => {};
  }
  // Jittered first run: 30–60 s after boot so migrations and FTS init
  // don't share the VACUUM write lock with the first snapshot.
  const firstRun = 30_000 + Math.random() * 30_000;
  let timeout = setTimeout(runPass, firstRun);
  let stopped = false;
  async function runPass() {
    if (stopped) return;
    try { await runBackupPass(trail); }
    catch (err) { console.error('[backup-scheduler] pass failed:', err); }
    if (!stopped) timeout = setTimeout(runPass, hours * 60 * 60 * 1000);
  }
  return () => { stopped = true; clearTimeout(timeout); };
}
```

`runBackupPass()`:

1. `snapshotDb(trail.client, BACKUP_STAGING_DIR)` → gzipped file on disk.
2. Append a `BackupSnapshot` row to `data/backups/manifest.json` with `status: 'uploading'`.
3. `provider.upload(filename, createReadStream(path), compressedBytes)`.
4. Flip status → `'uploaded'`, record `remoteUrl`, `sha256`, `snappedAt`.
5. Local prune: keep the newest `BACKUP_LOCAL_KEEP` (default 3), delete the rest on disk (keep manifest row — it still has `remoteUrl`).
6. Remote prune: delete snapshots older than `BACKUP_RETAIN_DAYS` (default 30) from both manifest and R2.
7. On any failure: `status: 'failed'`, `error: message`. Next pass retries independently; we don't block the scheduler on a failed upload.

### Manifest — `data/backups/manifest.json`

```typescript
interface BackupSnapshot {
  id: string;              // trail_<YYYY-MM-DD>_<HHmm>_<6-char>
  snappedAt: string;       // ISO
  trigger: 'manual' | 'scheduled';
  uncompressedBytes: number;
  compressedBytes: number;
  sha256: string;
  localPath: string | null;    // null once pruned locally
  remoteUrl: string | null;    // r2://bucket/prefix/<id>.db.gz
  status: 'snapping' | 'uploading' | 'uploaded' | 'failed' | 'pruned-remote';
  error?: string;
}
interface BackupManifest { snapshots: BackupSnapshot[]; }
```

Written atomically (`write → rename`). One row prepended per pass. Newest-first.

### HTTP routes — `apps/server/src/routes/backups.ts` (new)

Admin-only (same auth guard as `routes/queue.ts`). Mounted at `/api/admin/backups` in `app.ts`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/backups` | Return manifest + computed totals (count, total remote bytes, last success). |
| POST | `/api/admin/backups` | Trigger a manual snapshot + upload. Returns snapshot row. |
| GET | `/api/admin/backups/:id/download` | Stream the snapshot back to the browser (local if present; else proxy from R2). For ad-hoc download. |
| DELETE | `/api/admin/backups/:id` | Remove one snapshot (local + remote). Returns 200 once the R2 delete succeeds. |
| POST | `/api/admin/backups/test` | Call `provider.test()` — for the Settings UI "test connection" button. |

### Admin UI — `apps/admin/src/panels/settings-backups.tsx` (new)

A new tab under Settings (same shell as `settings-trail.tsx`):

- Connection status card (green/red dot, "last successful backup X ago", total R2 bytes used, snapshot count).
- Manual "Create backup now" button (calls `POST /api/admin/backups`, disabled while in-flight, shows progress from SSE if the pass emits events — otherwise polls the manifest every 2s until `status` leaves `snapping|uploading`).
- Table of past snapshots: timestamp, size (compressed + uncompressed), trigger, status, download/delete actions.
- Config panel: displays the effective env-var values (masked secrets), links to the Fly secrets docs for rotation.

### Restore CLI — `apps/server/scripts/restore-backup.ts` (new)

```bash
bun run apps/server/scripts/restore-backup.ts <snapshot-id> [--confirm]
```

1. Refuse to run if `apps/server` is still serving on `$PORT` (probe `/api/health`).
2. If local copy exists, use it. Else download from R2 via the R2 provider.
3. Verify sha256 matches manifest.
4. `gunzip` to a staging path.
5. Rename existing `data/trail.db` → `data/trail.db.pre-restore-<ts>` (don't delete — insurance).
6. Move staged snapshot into `data/trail.db`.
7. Print instructions to restart the server.

Strictly interactive (needs `--confirm`). Scope of `rm`/rename restricted to `data/`.

## Interface

Public HTTP surface (admin-only, same session-cookie guard as the rest of `apps/admin`):

```
GET    /api/admin/backups                 → { snapshots, totals }
POST   /api/admin/backups                 → BackupSnapshot
GET    /api/admin/backups/:id/download    → application/gzip stream
DELETE /api/admin/backups/:id             → { ok: true }
POST   /api/admin/backups/test            → { ok, message }
```

Env surface (new keys, all optional — feature disables cleanly when unset):

```
# Cadence
TRAIL_BACKUP_INTERVAL_HOURS=6      # 0 disables the scheduler
TRAIL_BACKUP_RETAIN_DAYS=30        # Remote retention
TRAIL_BACKUP_LOCAL_KEEP=3          # Number of recent snapshots to keep on disk

# R2 destination
TRAIL_BACKUP_R2_BUCKET=trail-backups
TRAIL_BACKUP_R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
TRAIL_BACKUP_R2_ACCESS_KEY_ID=...
TRAIL_BACKUP_R2_SECRET_ACCESS_KEY=...
TRAIL_BACKUP_R2_PREFIX=trail-db/
```

Internal API — exported from `@trail/db`:

```typescript
export function snapshotDb(source: LibSqlClient, outDir: string): Promise<SnapshotResult>;
```

## Rollout

**Phase 1 (half-day) — ✅ LANDED** — Snapshot primitive (`packages/db/src/backup.ts`) + `LibsqlTrailDatabase.sqliteClient` typed accessor + `apps/server/scripts/snapshot-dry-run.ts` that asserts end-to-end integrity. 13 assertions pass: file-size match, sha256 reproducible, gunzip + `integrity_check = ok`, row counts preserved, logical content stable across repeat snapshots, mutation correctly reflected in a subsequent snapshot. Feature is otherwise invisible (no env-var side effects, no routes, no scheduler). Caught the "same-connection VACUUM INTO hangs" gotcha above.

**Phase 2 (half-day)** — Wire the R2 provider + manual `POST /api/admin/backups` route. No scheduler yet. Christian provisions the R2 bucket and API tokens, drops them in `.env`, clicks the admin button, verifies the upload lands.

**Phase 3 (half-day)** — Scheduler + retention pruning + manifest. Default interval 6h. Verified via a 10-minute shortened test interval on dev.

**Phase 4 (half-day)** — Settings UI panel + restore CLI + docs page.

Each phase independently verifiable, each reversible (delete the scheduler file, remove the env vars — Trail functions exactly as today). No DB migration required (manifest is a JSON file, not a table).

## Success Criteria

1. A scripted verification run (`scripts/verify-f153-backup.ts`) completes in < 30 s on a freshly-seeded DB and proves: snapshot opens + passes `integrity_check`, gzip round-trips to R2, sha256 matches on download, upload key lists in the bucket.
2. Concurrent-write soundness: during a `bun run scripts/hammer-writes.ts` that does 1000 INSERTs into `queue_candidates` over 20s, invoking the snapshot primitive mid-stream produces a snapshot whose row count ≥ the count at VACUUM-start — and the live DB's row count continues to climb normally. No `SQLITE_BUSY`, no WAL growth beyond the default checkpoint cap.
3. A 30 MB production-sized DB snapshots-compresses-uploads in < 15s on the dev Mac (first-pass wall-clock budget; if we blow past 60s we reconsider cadence).
4. Manual `POST /api/admin/backups` after a fresh boot produces a row in the manifest with `status='uploaded'` within 30s. The `/api/admin/backups/:id/download` endpoint streams back bytes that hash-match the manifest's `sha256`.
5. Restore drill: on a throwaway checkout, delete `data/trail.db`, run `scripts/restore-backup.ts`, restart server, `SELECT COUNT(*) FROM knowledge_bases` matches pre-deletion count.
6. Failure drill: with bogus R2 credentials, the scheduler logs `status: 'failed'` on the manifest and continues running — the next pass with good creds succeeds without residue.

## Impact Analysis

### Files created (new)

- `packages/db/src/backup.ts` — `snapshotDb()` primitive + `SnapshotResult` type. Exported from `packages/db/src/index.ts`.
- `apps/server/src/services/backup-scheduler.ts` — scheduler loop, manifest I/O, retention pruning, `startBackupScheduler(trail)` / `runBackupPass(trail)`.
- `apps/server/src/services/backup/providers/types.ts` — `BackupProvider`, `R2ProviderConfig`, `CloudBackupFile`.
- `apps/server/src/services/backup/providers/r2.ts` — `R2BackupProvider` (S3-compatible, uses `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`).
- `apps/server/src/services/backup/providers/index.ts` — factory `createBackupProvider(envConfig)`.
- `apps/server/src/services/backup/manifest.ts` — typed read/write + atomic rename of `data/backups/manifest.json`.
- `apps/server/src/routes/backups.ts` — 5 admin HTTP endpoints.
- `apps/admin/src/panels/settings-backups.tsx` — Settings UI tab.
- `apps/admin/src/lib/backups-api.ts` — thin client for the 5 routes.
- `apps/server/scripts/verify-f153-backup.ts` — end-to-end verification script required by CLAUDE.md.
- `apps/server/scripts/snapshot-dry-run.ts` — local-only snapshot primitive test (Phase 1).
- `apps/server/scripts/restore-backup.ts` — stopped-server restore CLI.
- `docs/guides/backup-and-restore.md` — ops runbook covering R2 setup, retention, restore procedure.

### Files modified

- `apps/server/src/index.ts` — add `startBackupScheduler(trail)` to boot sequence and include its `stop()` in the SIGTERM shutdown handler, mirroring `stopLintScheduler`.
- `apps/server/src/app.ts` — mount the `/api/admin/backups` route group.
- `apps/admin/src/app.tsx` (or the settings-shell file equivalent) — register the new `settings-backups.tsx` panel in the Settings tab list.
- `packages/db/src/index.ts` — re-export `snapshotDb` + `SnapshotResult` from the new `backup.ts`.
- `packages/db/src/interface.ts` — expose the underlying `LibSqlClient` on `TrailDatabase` (via a typed accessor) OR add a `snapshot(outDir)` method on the interface. Deciding which way in Open Questions below.
- `packages/db/src/libsql-adapter.ts` — implement whichever surface is chosen (accessor or method).
- `apps/server/package.json` — add `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` deps.
- `.env.example` — add the 5 `TRAIL_BACKUP_*` keys with comments.
- `docs/FEATURES.md` — index row + description section.
- `docs/ROADMAP.md` — entry under Phase 1 Quality + UX.

### Downstream dependents

- **`apps/server/src/app.ts`** — 61 files across the repo import from `@trail/db`, including many that touch `app.ts` indirectly. Direct importers of `app.ts` itself: only `apps/server/src/index.ts` (1 ref) — mounts the app. Unaffected by adding a route group.
- **`apps/server/src/index.ts`** — No downstream dependents (entrypoint, imported by `bun run` not by source).
- **`packages/db/src/index.ts`** — re-exports consumed by 61 TS/TSX files. New exports are strictly additive; no existing export renamed or removed. All 61 importers unaffected.
- **`packages/db/src/interface.ts`** — the `TrailDatabase` type is consumed across the engine. If we add a new `snapshot()` method here, every implementer must add it. Today there is exactly one implementer (`LibsqlTrailDatabase` in `libsql-adapter.ts`). No test doubles in the codebase implement `TrailDatabase` directly; confirmed via `rg "implements TrailDatabase"` returning 1 match. Additive change is safe.
- **`packages/db/src/libsql-adapter.ts`** — imported only by `packages/db/src/index.ts` (1 ref). No external consumers.
- **`apps/server/package.json`** — dep add is additive; Bun's lock is regenerated.

### Blast radius

- **Live write lock contention during VACUUM INTO.** SQLite takes an exclusive lock briefly at the end of VACUUM to finalise the file. On a small DB this is milliseconds; on a 100 MB DB it can be hundreds of ms. Writers that hit this will block up to `PRAGMA busy_timeout=5000` (see `libsql-adapter.ts:120`) — well within tolerance. No risk of dropped writes; risk is user-visible latency spike on the unlucky write. Mitigation: schedule the first pass 30–60 s after boot so the scheduler doesn't race with the boot-time extractors (`backfillReferences`, `backfillBacklinks`, `backfillLinkCheck`) which all bulk-write.
- **Disk space on the staging volume.** A 100 MB DB + gzip step peaks at ~100 MB on disk before the uncompressed copy is unlinked. Fly.io volumes in arn typically have ≥ 3 GB free. Guard with a pre-flight `statvfs` check that aborts if free space < 2× DB size.
- **R2 API-cost runaway.** One snapshot every 6h × 30 retention × ~10MB compressed = ~40 MB stored and ~4 PUT/month — R2's 10 GB/1M-ops free tier absorbs this by two orders of magnitude.
- **Secret leakage via the Settings UI.** The `/api/admin/backups/test` endpoint returns a message that mentions the bucket name but NEVER the access keys. The UI displays masked values only. Precedent: CMS's `backup-service.ts` does the same.
- **Manifest corruption.** Atomic rename pattern protects against partial writes. Corruption scenarios (disk full mid-rename) leave the old manifest intact; scheduler re-reads it and continues. A missing manifest is treated as "no prior snapshots" — scheduler recovers on the next pass without operator intervention.
- **DB upgrade / migration interactions.** A snapshot taken just after `runMigrations()` but before `initFTS()` would contain valid schema but not the FTS5 virtual tables — restoring it would then trigger `initFTS()` on boot and re-create them. No data loss, but a one-off FTS re-index cost. Documented in the restore runbook.

### Breaking changes

**None** — all changes are additive. No env-var renames, no schema changes, no handler signatures changed. The feature is fully inert when `TRAIL_BACKUP_R2_*` secrets are absent (scheduler logs "disabled" and returns a no-op `stop()`).

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit (`packages/db`): `snapshotDb()` against a 100-row fixture DB produces a .db.gz whose SHA-256 is stable across two runs (given identical input) and whose uncompressed content opens + passes `PRAGMA integrity_check`.
- [ ] Unit (`packages/db`): `snapshotDb()` run concurrently with a 500-row INSERT loop produces a snapshot whose row count is a prefix of the final row count (monotonic) and never a corrupt file.
- [ ] Unit (`services/backup/providers/r2.ts`): mock `@aws-sdk/client-s3` with `aws-sdk-client-mock` and assert `upload` issues a `PutObject`/multipart sequence with `Bucket`, `Key`, `ContentType: 'application/gzip'` as expected.
- [ ] Integration (`scripts/verify-f153-backup.ts`): against a live R2 test bucket, full snapshot → upload → list → download → hash-compare → delete round-trip in < 30s.
- [ ] Integration: start server with `TRAIL_BACKUP_INTERVAL_HOURS=0.01` (36s), observe two passes in the manifest with 36s ± 5s spacing, both `status='uploaded'`.
- [ ] Integration: start server with invalid `TRAIL_BACKUP_R2_SECRET_ACCESS_KEY`, observe manifest row with `status='failed'`, scheduler continues running, fix creds, next pass succeeds without residue.
- [ ] Integration: restore drill — with the engine stopped, run `scripts/restore-backup.ts <id>`, restart, verify `SELECT COUNT(*)` from `knowledge_bases`, `documents`, `queue_candidates` match pre-drill values exactly.
- [ ] Manual: admin UI — navigate to Settings → Backups, click "Create backup now", watch status transitions in under 15s on a small dev DB, download the resulting snapshot, `sqlite3 downloaded.db .tables` lists the expected tables.
- [ ] Manual: `curl -H 'X-Admin-Key: …' -X POST localhost:3031/api/admin/backups/test` returns `{ ok: true, message: 'Connected to trail-backups — N snapshots stored' }` against real creds.
- [ ] Regression: F148 `startLinkChecker(trail)` subscriber continues firing on `candidate_approved` events during and after a backup pass (no event drops).
- [ ] Regression: F143 persistent ingest-queue — confirm an ingest job enqueued during a VACUUM INTO completes without SQLITE_BUSY bubbling up to the user (only internal retry via busy_timeout).
- [ ] Regression: F141 access telemetry — the `document_accesses` insert path is uninterrupted across a backup pass (spot-check 10 reads during VACUUM; all rows land).
- [ ] Regression: `pnpm --filter @trail/server typecheck` and `pnpm --filter @trail/admin typecheck` both green.

## Implementation Steps

1. **Add the snapshot primitive** — `packages/db/src/backup.ts` with `snapshotDb()`, `SnapshotResult`, re-exports from `index.ts`. Write `apps/server/scripts/snapshot-dry-run.ts` that runs it against a temp DB seeded with 100 rows and asserts integrity_check + sha256 stability. This is the Phase 1 shippable unit — no external deps yet.
2. **Decide + implement the interface surface** — either add `snapshot(outDir)` to `TrailDatabase` (clean abstraction) OR expose `client` as a typed accessor on `LibsqlTrailDatabase` only (smaller blast radius). Locked in Open Questions below. Update the dry-run script to exercise whichever shape wins.
3. **Write the R2 provider + factory** — `services/backup/providers/{types,r2,index}.ts`. Add `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` to `apps/server/package.json`. Write a unit test with `aws-sdk-client-mock` asserting the PutObject / multipart parameters.
4. **Wire the end-to-end verification script** — `apps/server/scripts/verify-f153-backup.ts`. Reads R2 creds from `.env.test`, snapshots a temp DB, uploads, lists, downloads, hash-compares, deletes. Must pass before moving on.
5. **Build the manifest module + scheduler** — `services/backup/manifest.ts` (atomic write-and-rename) + `services/backup-scheduler.ts` (`startBackupScheduler`, `runBackupPass`, retention prune). Pattern-match `services/lint-scheduler.ts`.
6. **Add admin routes + auth guard** — `routes/backups.ts` with the 5 endpoints, mounted in `app.ts`. Reuse the admin-auth pattern from `routes/queue.ts`. Manual smoke via `curl`.
7. **Bootstrap integration** — add `startBackupScheduler(trail)` to `index.ts` between `startActionRecommender` and the `setTimeout` backfill. Extend the shutdown handler with `stopBackupScheduler()`.
8. **Ship the admin UI panel** — `settings-backups.tsx` with the connection card, manual-trigger button, snapshot table, per-row download/delete. Matches `settings-trail.tsx` styling.
9. **Write the restore CLI + docs** — `scripts/restore-backup.ts`, `docs/guides/backup-and-restore.md` covering bucket provisioning, token rotation, cadence tuning, restore procedure. Include the exact R2 dashboard click-path to create a scoped token so Christian can reproduce it.
10. **Run the regression + restore drill** — execute every item under Test Plan against a freshly-booted dev instance. Document results in the verification script output.
11. **`.env.example` + FEATURES.md / ROADMAP.md** finalised with the bucket and prefix defaults.

## Dependencies

- **None blocking.** Works on the current F40.1 one-DB-per-process model. Will extend (not depend on) F40.2 for per-tenant backups.
- **External**: Cloudflare R2 bucket `trail-backups` + scoped API token with `Object Read & Write` on that one bucket. **Christian must provision these before Phase 2 merges** (see Open Questions).

## Open Questions

1. **Interface surface** — add `snapshot(outDir): Promise<SnapshotResult>` to the `TrailDatabase` interface (clean), or keep the primitive as a free function that reaches into the concrete `LibsqlTrailDatabase` (smaller blast radius, avoids touching the interface)? **Proposed default: free function + typed `client` accessor on `LibsqlTrailDatabase` only.** A future Postgres/libSQL-remote adapter would need a different snapshot mechanism anyway (`pg_dump`, HTTP /dump endpoint) — locking the interface prematurely is speculative. Reconsider if F40.2 brings a second implementer.
2. **R2 bucket naming and token scope** — Christian needs to create:
   - Bucket: `trail-backups` in the Cloudflare account serving `broberg.ai`.
   - Token: scoped to `trail-backups` only, `Object Read & Write` permissions.
   - Capture `Account ID`, `Access Key ID`, `Secret Access Key`, endpoint URL.
   Am I clear to request these via a follow-up message, or does the bucket already exist under a different name?
3. **Retention defaults** — 30 days × 6h cadence = 120 snapshots stored. At 10 MB each, that's ~1.2 GB — well under R2's free tier. Comfortable defaults, or do we want 14 days × 12h (28 snapshots, ~280 MB) for MVP?
4. **Staging directory** — default to `${TRAIL_DATA_DIR}/backups/staging/` or `/tmp/trail-backups/`? `data/` is on the Fly volume (durable); `/tmp/` is ephemeral but free disk. Proposal: `${TRAIL_DATA_DIR}/backups/staging/` so we're consistent with `data/backups/manifest.json`.
5. **Admin UI auth** — `apps/admin` currently uses the session cookie from `apps/server/src/routes/auth.ts`. No separate admin role — every authenticated user sees the admin. Acceptable for single-tenant F40.1; for F40.2 multi-tenant we'll need a "tenant owner" check. Flag as a follow-up for F40.2 rather than gating F153 on it.
6. **Compression level** — gzip level 6 is the sweet spot for .db files (SQLite data is already page-aligned and compresses well). Revisit if snapshots grow > 500 MB.

## Related Features

- **F27 Pluggable Vision Adapter** / F42 Pluggable Storage — same "adapter interface" pattern, different domain (LLM vision / blob storage). F153 defines a third instance of the same pattern for the backup destination.
- **F33 Fly.io Arn Deploy** — strongly synergistic: once the engine is on a Fly volume, off-site R2 is the only line of defence against a disk failure or region incident. F33 will depend on F153 being live before Christian trusts it with Sanne's data.
- **F40.2 Per-Tenant libSQL** — future extension: loop the backup scheduler over all tenant DBs instead of the single master.
- **F81 Per-KB Encryption at Rest** — future overlap: client-side encryption of the snapshot before upload lives there, not here. F153 relies on R2's server-side encryption only.
- **F95 (`@webhouse/cms`) Cloud Backup Providers** — direct provenance. The R2 provider and the `BackupProvider` interface are near-identical lifts from `packages/cms-admin/src/lib/backup/providers/s3.ts` and `types.ts`. Cross-repo pattern reuse is deliberate.
- **F117 Git Versioning Export** — orthogonal backup layer (Neuron content as markdown in a git repo), not a substitute. F117 covers per-KB semantic diffs; F153 covers "the entire DB is gone" recovery.

## Effort Estimate

**Small** — ~1.5–2 days.

- Day 0.5 — Phase 1: snapshot primitive, dry-run script, integrity proof.
- Day 0.5 — Phase 2: R2 provider, manual trigger route, end-to-end verification script.
- Day 0.5 — Phase 3: scheduler, manifest, retention pruning, integration tests.
- Day 0.5 — Phase 4: admin UI panel, restore CLI, docs, regression drill.
