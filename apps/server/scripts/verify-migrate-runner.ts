/**
 * Verify the hash-based migration runner against:
 *
 *   (1) Live dev DB — should be a no-op (every journal entry's hash is
 *       in __drizzle_migrations after the backfill).
 *   (2) Fresh DB — every journal migration applies cleanly, including
 *       0022 which has NO `--> statement-breakpoint` markers (proves the
 *       `;`-fallback split works).
 *
 * Run with: `cd apps/server && bun run scripts/verify-migrate-runner.ts`
 */

import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { runMigrationsByHash } from '@trail/db';

const REPO_ROOT_DB = join(homedir(), 'Apps/broberg/trail/data/trail.db');
const MIGRATIONS_FOLDER = join(homedir(), 'Apps/broberg/trail/packages/db/drizzle');

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures += 1;
  }
}

console.log(`\n=== migrate-runner probe ===\n`);

// ── 1. Live DB — should be no-op ──────────────────────────────────────────
console.log('[1] Live DB — runner is no-op on already-migrated tree');
const liveClient = createClient({ url: `file:${REPO_ROOT_DB}` });
const liveSizeBefore = statSync(REPO_ROOT_DB).size;
const beforeCount = (
  (await liveClient.execute(`SELECT COUNT(*) AS c FROM __drizzle_migrations`)).rows[0] as
    | { c: number }
    | undefined
)?.c ?? 0;
await runMigrationsByHash(liveClient, MIGRATIONS_FOLDER);
const afterCount = (
  (await liveClient.execute(`SELECT COUNT(*) AS c FROM __drizzle_migrations`)).rows[0] as
    | { c: number }
    | undefined
)?.c ?? 0;
const liveSizeAfter = statSync(REPO_ROOT_DB).size;
assert(beforeCount === afterCount, `__drizzle_migrations count unchanged (${beforeCount})`);
// File size will fluctuate due to WAL checkpoints, just sanity-check it
// didn't explode by more than a sector.
assert(Math.abs(liveSizeAfter - liveSizeBefore) < 8192, 'DB size effectively unchanged');
liveClient.close();

// ── 2. Fresh in-memory DB — every migration applies cleanly ───────────────
console.log('\n[2] Fresh DB — apply every migration including 0022 (no breakpoints)');
const tmp = mkdtempSync(join(tmpdir(), 'trail-migrate-test-'));
const freshDbPath = join(tmp, 'fresh.db');
const freshClient = createClient({ url: `file:${freshDbPath}` });
try {
  await runMigrationsByHash(freshClient, MIGRATIONS_FOLDER);

  // Probe a smattering of tables that should exist after a full apply.
  for (const table of [
    'tenants',
    'documents',
    'queue_candidates',
    'broken_links',
    'tenant_credits',
    'credit_transactions',
  ]) {
    const r = await freshClient.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      args: [table],
    });
    assert(r.rows.length === 1, `table "${table}" exists in fresh DB`);
  }

  // 0022 has 6 statements (2 CREATE TABLE + 4 CREATE INDEX) and no
  // breakpoint markers — verify the indexes landed too. Stock drizzle
  // would have stopped after the first CREATE TABLE.
  for (const idx of [
    'idx_credit_tx_tenant',
    'idx_credit_tx_kind',
    'idx_credit_tx_ingest',
    'idx_credit_tx_chat',
  ]) {
    const r = await freshClient.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
      args: [idx],
    });
    assert(r.rows.length === 1, `index "${idx}" landed despite 0022 having no breakpoints`);
  }

  // Idempotent re-run.
  const c1 = (
    (await freshClient.execute(`SELECT COUNT(*) AS c FROM __drizzle_migrations`)).rows[0] as
      | { c: number }
      | undefined
  )?.c ?? 0;
  await runMigrationsByHash(freshClient, MIGRATIONS_FOLDER);
  const c2 = (
    (await freshClient.execute(`SELECT COUNT(*) AS c FROM __drizzle_migrations`)).rows[0] as
      | { c: number }
      | undefined
  )?.c ?? 0;
  assert(c1 === c2, `re-run is no-op (count stays ${c1})`);
} finally {
  freshClient.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== migrate-runner probe complete: ${failures === 0 ? 'PASS' : `${failures} FAILURE(S)`} ===\n`);
process.exit(failures === 0 ? 0 : 1);
