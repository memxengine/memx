/**
 * F153 Phase 2 — end-to-end verification against the REAL R2 bucket.
 *
 * Reads TRAIL_BACKUP_R2_* from the process env (load with `bun --env-file`
 * or via the top-level `.env`), then exercises the whole pass:
 *
 *   1. Seed a throwaway libSQL DB under /tmp with two tables + 150 rows.
 *   2. Run `runBackupPass` against it using the real R2 provider, with
 *      a `_verify/` key prefix so we don't pollute real snapshots.
 *   3. Assert the manifest row landed with status='uploaded'.
 *   4. Call provider.list() and assert our key is present with size
 *      matching the manifest entry.
 *   5. Call provider.download() and assert the SHA-256 of the downloaded
 *      stream matches the manifest's sha256 (byte-perfect round trip).
 *   6. Call provider.delete() to clean up. Assert provider.list() no
 *      longer lists our key.
 *
 * Exits 0 on success, 1 on first failing assertion. Leaves the staging
 * dir on disk for post-mortem if anything fails.
 *
 * Run:
 *   bun run --env-file=.env apps/server/scripts/verify-f153-backup.ts
 */

import { createLibsqlDatabase, LibsqlTrailDatabase } from '@trail/db';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import {
  createBackupProvider,
  readBackupConfigFromEnv,
} from '../src/services/backup/providers/index.js';
import { runBackupPass } from '../src/services/backup/pass.js';
import { readManifest } from '../src/services/backup/manifest.js';

const STAGING = join(tmpdir(), `trail-f153-phase2-${Date.now()}`);
const DATA_DIR = join(STAGING, 'data');
const STAGING_DIR = join(DATA_DIR, 'backups', 'staging');
const LOCAL_DIR = join(DATA_DIR, 'backups', 'local');
const SOURCE_DB = join(STAGING, 'source.db');

for (const d of [STAGING, DATA_DIR, STAGING_DIR, LOCAL_DIR]) {
  mkdirSync(d, { recursive: true });
}

let hadFailure = false;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    hadFailure = true;
    console.error(`  ✘ ${msg}`);
    throw new Error(msg);
  }
  console.log(`  ✔ ${msg}`);
}

async function hashStream(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    stream,
    new Writable({
      write(chunk, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
  return hash.digest('hex');
}

async function main() {
  console.log('\nF153 Phase 2 end-to-end probe (real R2)');
  console.log(`staging: ${STAGING}\n`);

  // Config with an isolated prefix so we don't pollute live snapshots.
  const baseConfig = readBackupConfigFromEnv();
  assert(baseConfig.type === 'r2', 'R2 config present (TRAIL_BACKUP_R2_* populated)');
  if (baseConfig.type !== 'r2' || !baseConfig.r2) {
    throw new Error('unreachable');
  }
  const verifyConfig = {
    type: 'r2' as const,
    r2: { ...baseConfig.r2, prefix: '_verify/' },
  };
  const provider = await createBackupProvider(verifyConfig);
  console.log(`provider: ${provider.name}, prefix=_verify/\n`);

  // ── 1. connectivity ─────────────────────────────────────────────
  console.log('1. provider.test() → connectivity + perms');
  const test = await provider.test();
  assert(test.ok, `provider.test ok: ${test.message}`);

  // ── 2. seed source DB ───────────────────────────────────────────
  console.log('\n2. seed source DB (150 rows across 2 tables)');
  const source = await createLibsqlDatabase({ path: SOURCE_DB });
  await source.execute(
    'CREATE TABLE neurons (id INTEGER PRIMARY KEY, kb TEXT, title TEXT, content TEXT)',
  );
  await source.execute(
    'CREATE TABLE queue_candidates (id INTEGER PRIMARY KEY, kind TEXT, status TEXT)',
  );
  for (let i = 1; i <= 120; i++) {
    await source.execute(
      'INSERT INTO neurons (id, kb, title, content) VALUES (?, ?, ?, ?)',
      [i, 'verify', `neuron ${i}`, 'x'.repeat(400 + (i % 80))],
    );
  }
  for (let i = 1; i <= 30; i++) {
    await source.execute(
      'INSERT INTO queue_candidates (id, kind, status) VALUES (?, ?, ?)',
      [i, 'orphan', 'pending'],
    );
  }
  assert(source instanceof LibsqlTrailDatabase, 'source is LibsqlTrailDatabase');
  const sourcePath = source.path;
  await source.close();
  console.log(`   source at ${sourcePath}`);

  // ── 3. runBackupPass ────────────────────────────────────────────
  console.log('\n3. runBackupPass(trigger=manual) → snapshot + upload');
  const t0 = Date.now();
  const result = await runBackupPass({
    dbPath: sourcePath,
    dataDir: DATA_DIR,
    stagingDir: STAGING_DIR,
    localDir: LOCAL_DIR,
    provider,
    trigger: 'manual',
  });
  const elapsedMs = Date.now() - t0;
  console.log(`   elapsed=${elapsedMs}ms`);
  assert(result.ok, `runBackupPass ok: ${result.error ?? ''}`);
  assert(result.snapshot.status === 'uploaded', `status=uploaded (got ${result.snapshot.status})`);
  assert(result.snapshot.sha256.length === 64, 'sha256 is 64 hex chars');
  assert(result.snapshot.compressedBytes > 0, `compressedBytes>0 (${result.snapshot.compressedBytes}B)`);
  assert(result.snapshot.uncompressedBytes > result.snapshot.compressedBytes, 'gzip reduced size');
  console.log(
    `   snapshot id=${result.snapshot.id}  compressed=${result.snapshot.compressedBytes}B  uncompressed=${result.snapshot.uncompressedBytes}B`,
  );
  console.log(`   remoteUrl=${result.snapshot.remoteUrl}`);

  // ── 4. manifest ─────────────────────────────────────────────────
  console.log('\n4. manifest.json persisted the uploaded row');
  const manifest = await readManifest(DATA_DIR);
  const row = manifest.snapshots.find((s) => s.id === result.snapshot.id);
  assert(!!row, 'manifest contains our snapshot id');
  assert(row!.status === 'uploaded', `manifest row status=uploaded`);
  assert(
    row!.sha256 === result.snapshot.sha256,
    'manifest sha256 matches runBackupPass result',
  );

  // ── 5. provider.list() ──────────────────────────────────────────
  console.log('\n5. provider.list() lists our key');
  const listed = await provider.list();
  const match = listed.find((f) => f.filename === `${result.snapshot.id}.db.gz`);
  assert(!!match, `list() includes ${result.snapshot.id}.db.gz`);
  assert(
    match!.size === result.snapshot.compressedBytes,
    `list() size matches compressedBytes (${match!.size} == ${result.snapshot.compressedBytes})`,
  );

  // ── 6. round-trip sha256 ────────────────────────────────────────
  console.log('\n6. provider.download() → sha256 matches');
  const downloadStream = await provider.download(`${result.snapshot.id}.db.gz`);
  const downloadSha = await hashStream(downloadStream);
  assert(
    downloadSha === result.snapshot.sha256,
    `round-trip sha256 matches (${downloadSha.slice(0, 16)}… == ${result.snapshot.sha256.slice(0, 16)}…)`,
  );

  // ── 7. cleanup ──────────────────────────────────────────────────
  console.log('\n7. provider.delete() cleans up');
  await provider.delete(`${result.snapshot.id}.db.gz`);
  const listedAfter = await provider.list();
  const stillThere = listedAfter.find((f) => f.filename === `${result.snapshot.id}.db.gz`);
  assert(!stillThere, 'delete removed the key');

  console.log('\nALL GOOD ✅');
}

main()
  .catch((err) => {
    console.error('\nFAIL:', err instanceof Error ? err.stack ?? err.message : err);
    hadFailure = true;
  })
  .finally(() => {
    if (!hadFailure) {
      rmSync(STAGING, { recursive: true, force: true });
      process.exit(0);
    } else {
      console.error(`(leaving ${STAGING} on disk for post-mortem)`);
      process.exit(1);
    }
  });
