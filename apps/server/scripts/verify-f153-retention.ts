/**
 * F153 Phase 3 — end-to-end retention probe against the real R2 bucket.
 *
 * Exercises `runBackupPass` + `pruneRetention` across 5 simulated
 * backup runs, each with its manifest timestamp shifted into the past,
 * then verifies that pruneRetention removes the right mix of local
 * files and remote objects given tight retention caps.
 *
 * Uses a `_retention-verify/` prefix in R2 so we don't touch real
 * snapshots. Cleans up at the end regardless of pass/fail.
 *
 * Run:
 *   bun run --env-file=.env apps/server/scripts/verify-f153-retention.ts
 */

import { createLibsqlDatabase } from '@trail/db';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBackupProvider,
  readBackupConfigFromEnv,
} from '../src/services/backup/providers/index.js';
import { runBackupPass } from '../src/services/backup/pass.js';
import { pruneRetention } from '../src/services/backup/retention.js';
import { readManifest, updateSnapshot } from '../src/services/backup/manifest.js';

const STAGING = join(tmpdir(), `trail-f153-phase3-${Date.now()}`);
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

async function main() {
  console.log('\nF153 Phase 3 retention probe (real R2)');
  console.log(`staging: ${STAGING}\n`);

  const baseConfig = readBackupConfigFromEnv();
  assert(baseConfig.type === 'r2', 'R2 config present');
  if (baseConfig.type !== 'r2' || !baseConfig.r2) throw new Error('unreachable');
  const verifyConfig = {
    type: 'r2' as const,
    r2: { ...baseConfig.r2, prefix: '_retention-verify/' },
  };
  const provider = await createBackupProvider(verifyConfig);
  console.log(`provider: ${provider.name}, prefix=_retention-verify/\n`);

  // ── Seed DB ─────────────────────────────────────────────────────
  console.log('1. seed 50-row source DB');
  const source = await createLibsqlDatabase({ path: SOURCE_DB });
  await source.execute('CREATE TABLE neurons (id INTEGER PRIMARY KEY, title TEXT)');
  for (let i = 1; i <= 50; i++) {
    await source.execute('INSERT INTO neurons (id, title) VALUES (?, ?)', [i, `n${i}`]);
  }
  const sourcePath = source.path;
  await source.close();

  // ── Take 5 backups, re-date the first 2 into the past ───────────
  console.log('\n2. run 5 backup passes back-to-back');
  const results = [];
  for (let i = 0; i < 5; i++) {
    const r = await runBackupPass({
      dbPath: sourcePath,
      dataDir: DATA_DIR,
      stagingDir: STAGING_DIR,
      localDir: LOCAL_DIR,
      provider,
      trigger: 'scheduled',
    });
    assert(r.ok, `pass ${i + 1} ok`);
    results.push(r.snapshot.id);
  }

  // Forge ages for the two oldest: snap 1 → 40d ago, snap 2 → 35d ago.
  // snaps 3-5 stay "now" (within the 30d window).
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const shifts: Record<string, number> = {
    [results[0]!]: now - 40 * day,
    [results[1]!]: now - 35 * day,
    // 2,3,4 untouched = now
  };
  for (const [id, t] of Object.entries(shifts)) {
    await updateSnapshot(DATA_DIR, id, { snappedAt: new Date(t).toISOString() });
  }
  console.log(`   snapshot ages: ${results[0]!.slice(-6)}=40d, ${results[1]!.slice(-6)}=35d, rest=now`);

  // ── Assert pre-prune state ──────────────────────────────────────
  console.log('\n3. pre-prune state');
  const manifestBefore = await readManifest(DATA_DIR);
  const uploadedBefore = manifestBefore.snapshots.filter((s) => s.status === 'uploaded');
  assert(uploadedBefore.length === 5, `5 uploaded snapshots in manifest (got ${uploadedBefore.length})`);
  const localFilesBefore = uploadedBefore.filter((s) => s.localPath && existsSync(s.localPath));
  assert(localFilesBefore.length === 5, `5 local .db.gz files on disk (got ${localFilesBefore.length})`);
  const remoteBefore = await provider.list();
  assert(remoteBefore.length === 5, `5 R2 objects under _retention-verify/ (got ${remoteBefore.length})`);

  // ── Prune: localKeep=2, retainDays=30 ──────────────────────────
  console.log('\n4. pruneRetention(localKeep=2, retainDays=30)');
  const pruned = await pruneRetention({
    dataDir: DATA_DIR,
    provider,
    localKeep: 2,
    retainDays: 30,
  });
  console.log(
    `     pruned: remote=${pruned.prunedRemoteObjects}  local=${pruned.prunedLocalFiles}  errors=${pruned.errors.length}`,
  );
  assert(pruned.errors.length === 0, `no errors during prune`);
  assert(pruned.prunedRemoteObjects === 2, `2 remote objects pruned (>30d old)`);
  // Local: 5 uploaded − 2 pruned-remote (which also drops local) = 3 candidates;
  // keep the newest 2 → prune 1 local.
  assert(pruned.prunedLocalFiles === 1, `1 local file pruned (beyond localKeep=2)`);

  // ── Post-prune state ────────────────────────────────────────────
  console.log('\n5. post-prune state');
  const manifestAfter = await readManifest(DATA_DIR);
  const uploadedAfter = manifestAfter.snapshots.filter((s) => s.status === 'uploaded');
  const prunedRemoteAfter = manifestAfter.snapshots.filter((s) => s.status === 'pruned-remote');
  assert(uploadedAfter.length === 3, `3 uploaded rows remain (got ${uploadedAfter.length})`);
  assert(prunedRemoteAfter.length === 2, `2 pruned-remote rows (got ${prunedRemoteAfter.length})`);

  const localStillOnDisk = uploadedAfter.filter((s) => s.localPath && existsSync(s.localPath));
  assert(localStillOnDisk.length === 2, `2 local files remain (got ${localStillOnDisk.length})`);

  const remoteAfter = await provider.list();
  assert(remoteAfter.length === 3, `3 R2 objects remain (got ${remoteAfter.length})`);
  for (const id of [results[0]!, results[1]!]) {
    const missing = !remoteAfter.some((o) => o.filename === `${id}.db.gz`);
    assert(missing, `aged-out snapshot ${id.slice(-6)} is gone from R2`);
  }

  // ── Idempotence: re-run prune, nothing should change ────────────
  console.log('\n6. idempotence check — second pruneRetention is a no-op');
  const again = await pruneRetention({
    dataDir: DATA_DIR,
    provider,
    localKeep: 2,
    retainDays: 30,
  });
  assert(again.prunedRemoteObjects === 0, 'no remote prunes on second run');
  assert(again.prunedLocalFiles === 0, 'no local prunes on second run');

  // ── Cleanup remaining R2 objects ────────────────────────────────
  console.log('\n7. cleanup remaining R2 objects');
  const leftover = await provider.list();
  for (const obj of leftover) {
    await provider.delete(obj.filename);
  }
  const finalList = await provider.list();
  assert(finalList.length === 0, 'bucket prefix empty after cleanup');

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
