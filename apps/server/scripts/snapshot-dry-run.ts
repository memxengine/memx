/**
 * F153 Phase 1 — dry-run probe for the `snapshotDb` primitive.
 *
 * Creates a throwaway libSQL DB in /tmp, seeds it with 125 rows across two
 * tables, runs `snapshotDb()`, and proves:
 *
 *   1. The primitive produces a `.db.gz` on disk.
 *   2. The reported SHA-256 matches a fresh re-hash of the file on disk.
 *   3. Gunzipping the `.db.gz` and opening it as a libSQL DB passes
 *      `PRAGMA integrity_check = 'ok'`.
 *   4. Row counts in the snapshot match the source exactly.
 *   5. A second snapshot of the same source content is logically
 *      equivalent to the first (identical row counts + identical content
 *      hash computed from SELECT * ordered by id). VACUUM INTO's byte
 *      output is NOT deterministic — SQLite updates the file header's
 *      `change_counter` and `version-valid-for` fields on every write,
 *      so two sequential snapshots produce different .db bytes even with
 *      identical logical content. The sha256-on-upload invariant the
 *      scheduler relies on is about R2 round-trip (upload-download), not
 *      about two snapshots being identical.
 *
 * Deliberately NOT in this Phase 1 probe: concurrent-write soundness.
 * VACUUM INTO on the SAME libSQL connection that is actively writing is
 * a live question — same-connection races need separate investigation
 * and most likely a dedicated reader connection in production. That
 * lands in Phase 3 alongside the scheduler, where the scheduler owns a
 * distinct libSQL client that opens the same file read-only for
 * snapshots while the engine's writer uses its own connection.
 *
 * Run:
 *   bun run apps/server/scripts/snapshot-dry-run.ts
 *
 * Exits 0 on success, non-zero with the failing assertion on the first
 * check that breaks. No network, no R2, no env vars required.
 */

import { createLibsqlDatabase, LibsqlTrailDatabase, snapshotDb } from '@trail/db';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const STAGING = join(tmpdir(), `trail-f153-dryrun-${Date.now()}`);
mkdirSync(STAGING, { recursive: true });

const SOURCE_DB = join(STAGING, 'source.db');
const OUT_DIR = join(STAGING, 'snapshots');

let hadFailure = false;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    hadFailure = true;
    console.error(`  ✘ ${msg}`);
    throw new Error(msg);
  }
  console.log(`  ✔ ${msg}`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function gunzipToFile(gzPath: string, outPath: string): Promise<void> {
  await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(outPath));
}

async function countRows(dbPath: string, table: string): Promise<number> {
  const db = await createLibsqlDatabase({ path: dbPath });
  try {
    const res = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(res.rows[0]?.n ?? -1);
  } finally {
    await db.close();
  }
}

async function integrityOk(dbPath: string): Promise<boolean> {
  const db = await createLibsqlDatabase({ path: dbPath });
  try {
    const res = await db.execute('PRAGMA integrity_check');
    const first = Object.values(res.rows[0] ?? {})[0];
    return first === 'ok';
  } finally {
    await db.close();
  }
}

/**
 * Hash the *logical* contents of a DB — every row from every user table,
 * ordered by PK, concatenated and SHA-256'd. Ignores SQLite header bytes
 * (change_counter, version-valid-for) that VACUUM INTO updates on every
 * run. Two DBs with identical logical content produce identical hashes.
 */
async function logicalContentHash(dbPath: string): Promise<string> {
  const db = await createLibsqlDatabase({ path: dbPath });
  const hash = createHash('sha256');
  try {
    const tables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    for (const t of tables.rows) {
      const name = String(Object.values(t)[0]);
      hash.update(`\n@${name}\n`);
      const rows = await db.execute(`SELECT * FROM ${name} ORDER BY rowid`);
      for (const r of rows.rows) {
        hash.update(JSON.stringify(r));
        hash.update('\n');
      }
    }
    return hash.digest('hex');
  } finally {
    await db.close();
  }
}

async function main() {
  console.log(`\nF153 Phase 1 dry-run`);
  console.log(`staging: ${STAGING}\n`);

  // ── Seed the source DB ──────────────────────────────────────────
  console.log('1. seed source DB with 125 rows across 2 tables');
  const source = await createLibsqlDatabase({ path: SOURCE_DB });
  await source.execute(
    'CREATE TABLE neurons (id INTEGER PRIMARY KEY, kb TEXT, title TEXT, content TEXT)',
  );
  await source.execute(
    'CREATE TABLE queue_candidates (id INTEGER PRIMARY KEY, kind TEXT, status TEXT)',
  );
  for (let i = 1; i <= 100; i++) {
    await source.execute('INSERT INTO neurons (id, kb, title, content) VALUES (?, ?, ?, ?)', [
      i,
      'dryrun',
      `neuron ${i}`,
      'x'.repeat(200 + (i % 50)),
    ]);
  }
  for (let i = 1; i <= 25; i++) {
    await source.execute('INSERT INTO queue_candidates (id, kind, status) VALUES (?, ?, ?)', [
      i,
      'orphan',
      'pending',
    ]);
  }
  assert((await countRows(SOURCE_DB, 'neurons')) === 100, 'source has 100 neurons rows');
  assert((await countRows(SOURCE_DB, 'queue_candidates')) === 25, 'source has 25 queue rows');

  // Narrow to LibsqlTrailDatabase so we can reach the raw client for the
  // snapshot primitive. Option B in the F153 plan: TrailDatabase interface
  // stays clean; snapshot-aware code explicitly opts into the concrete class.
  if (!(source instanceof LibsqlTrailDatabase)) {
    throw new Error('source is not a LibsqlTrailDatabase — cannot reach sqliteClient');
  }
  const sourceClient = source.sqliteClient;

  // ── Snapshot #1 ─────────────────────────────────────────────────
  console.log('\n2. snapshot #1 → .db.gz + verify hash/integrity/rows');
  const snap1 = await snapshotDb(sourceClient, OUT_DIR, { basename: 'snap1' });
  console.log(`     produced ${snap1.path}`);
  console.log(`     compressed=${snap1.compressedBytes}B  uncompressed=${snap1.uncompressedBytes}B`);
  console.log(`     sha256=${snap1.sha256}`);

  assert(
    statSync(snap1.path).size === snap1.compressedBytes,
    '.db.gz size on disk matches reported compressedBytes',
  );
  const rehash1 = await sha256File(snap1.path);
  assert(rehash1 === snap1.sha256, 'reported sha256 matches fresh re-hash');

  const unzipped1 = join(STAGING, 'snap1.db');
  await gunzipToFile(snap1.path, unzipped1);
  assert(
    statSync(unzipped1).size === snap1.uncompressedBytes,
    'gunzipped .db size matches uncompressedBytes',
  );
  assert(await integrityOk(unzipped1), 'post-gunzip integrity_check = ok');
  assert((await countRows(unzipped1, 'neurons')) === 100, 'snapshot contains 100 neurons');
  assert(
    (await countRows(unzipped1, 'queue_candidates')) === 25,
    'snapshot contains 25 queue_candidates',
  );

  // ── Snapshot #2 (same source content, logically equivalent) ────
  console.log('\n3. snapshot #2 of unchanged source → logically identical content');
  const snap2 = await snapshotDb(sourceClient, OUT_DIR, { basename: 'snap2' });
  const unzipped2 = join(STAGING, 'snap2.db');
  await gunzipToFile(snap2.path, unzipped2);

  // Logical-content hash: SELECT every row, ordered by PK, concat + hash.
  // Bypasses SQLite header bytes that change per VACUUM.
  const logical1 = await logicalContentHash(unzipped1);
  const logical2 = await logicalContentHash(unzipped2);
  assert(
    logical1 === logical2,
    `logical content identical across snapshots (${logical1.slice(0, 12)}… == ${logical2.slice(0, 12)}…)`,
  );

  // ── Sequential-write soundness ──────────────────────────────────
  console.log('\n4. mutate source then snapshot → snapshot reflects the mutation');
  await source.execute('DELETE FROM queue_candidates WHERE id > 10');
  assert((await countRows(SOURCE_DB, 'queue_candidates')) === 10, 'source now has 10 queue rows');

  const snap3 = await snapshotDb(sourceClient, OUT_DIR, { basename: 'snap3-after-delete' });
  const unzipped3 = join(STAGING, 'snap3.db');
  await gunzipToFile(snap3.path, unzipped3);
  assert(await integrityOk(unzipped3), 'post-delete snapshot integrity_check = ok');
  assert(
    (await countRows(unzipped3, 'queue_candidates')) === 10,
    'post-delete snapshot contains the updated 10-row state',
  );
  assert(
    (await countRows(unzipped3, 'neurons')) === 100,
    'neurons table unaffected by queue mutation',
  );

  await source.close();
  console.log('\nALL GOOD ✅');
}

main()
  .catch((err) => {
    console.error('\nFAIL:', err instanceof Error ? err.message : err);
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
