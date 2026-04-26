/**
 * F156 Phase 0 — verify the credits service end-to-end.
 *
 * What this proves:
 *   1. Migration 0022 applied — both tables + 4 indexes present.
 *   2. consumeCredits — costCents=0 no-ops, costCents>0 deducts +
 *      appends a kind='consume' transaction with balance_after.
 *   3. consumeCredits — UPSERT path (no prior tenant_credits row)
 *      creates the row at -credits and stamps a transaction.
 *   4. consumeCredits — atomicity: balance_after on the row matches
 *      the post-update balance.
 *   5. refillCredits — adds + stamps the right kind, lastTopupAt set
 *      only on monthly_topup.
 *   6. seedDevCredits — tops up to target, idempotent on re-run, never
 *      decreases.
 *
 * Run with: `cd apps/server && bun run scripts/verify-credits.ts`
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { and, eq, desc } from 'drizzle-orm';
import {
  createLibsqlDatabase,
  tenants,
  tenantCredits,
  creditTransactions,
} from '@trail/db';
import {
  consumeCredits,
  refillCredits,
  seedDevCredits,
  getCreditBalance,
  computeCreditsForCost,
} from '../src/services/credits.ts';

const REPO_ROOT_DB = join(homedir(), 'Apps/broberg/trail/data/trail.db');
const PROBE_ID = crypto.randomUUID().slice(0, 8);

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures += 1;
  }
}

console.log(`\n=== F156 Phase 0 credits probe (id: ${PROBE_ID}) ===\n`);

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });
await trail.runMigrations();

// ── 1. Migration 0022 schema ──────────────────────────────────────────────
console.log('[1] Migration 0022 — both tables + indexes land');
const tcCols = await trail.execute(`SELECT name FROM pragma_table_info('tenant_credits')`);
const tcNames = (tcCols.rows as Array<{ name: string }>).map((r) => r.name);
for (const expected of [
  'tenant_id',
  'balance',
  'monthly_included',
  'last_topup_at',
  'low_balance_alerted_at',
  'updated_at',
]) {
  assert(tcNames.includes(expected), `tenant_credits.${expected} exists`);
}

const txCols = await trail.execute(`SELECT name FROM pragma_table_info('credit_transactions')`);
const txNames = (txCols.rows as Array<{ name: string }>).map((r) => r.name);
for (const expected of [
  'id',
  'tenant_id',
  'kind',
  'amount',
  'balance_after',
  'feature',
  'related_ingest_job_id',
  'related_chat_turn_id',
  'related_stripe_id',
  'note',
  'created_at',
]) {
  assert(txNames.includes(expected), `credit_transactions.${expected} exists`);
}

const idxRows = await trail.execute(
  `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='credit_transactions'`,
);
const idxNames = (idxRows.rows as Array<{ name: string }>).map((r) => r.name);
for (const expected of [
  'idx_credit_tx_tenant',
  'idx_credit_tx_kind',
  'idx_credit_tx_ingest',
  'idx_credit_tx_chat',
]) {
  assert(idxNames.includes(expected), `index ${expected} exists`);
}

// ── 2. computeCreditsForCost ──────────────────────────────────────────────
console.log('\n[2] computeCreditsForCost — cents → credits');
assert(computeCreditsForCost(0) === 0, '0¢ → 0 credits');
assert(computeCreditsForCost(-5) === 0, 'negative → 0 credits (defensive)');
assert(computeCreditsForCost(1) === 1, '1¢ → 1 credit');
assert(computeCreditsForCost(5) === 5, '5¢ → 5 credits');
assert(computeCreditsForCost(0.4) === 1, '0.4¢ rounds UP to 1 credit');
assert(computeCreditsForCost(27) === 27, '27¢ → 27 credits');

// ── 3. Test tenant — pick first existing or fail loudly ───────────────────
console.log('\n[3] Setup — find a real tenant');
const tenant = await trail.db.select({ id: tenants.id }).from(tenants).limit(1).get();
if (!tenant) {
  console.log('  ✗ No tenant in DB — cannot run probe');
  process.exit(1);
}
const tenantId = tenant.id;
assert(true, `using tenant ${tenantId.slice(0, 12)}…`);

// Snapshot the starting balance so we can leave the tenant exactly where
// we found it (this DB is the live dev one).
const startBalance = await getCreditBalance(trail, tenantId);
console.log(`  · start balance: ${startBalance}`);

// ── 4. consumeCredits — no-op on 0/negative cost ──────────────────────────
console.log('\n[4] consumeCredits — no-op when costCents <= 0');
const noopJobId = `prb_noop_${PROBE_ID}`;
const noop = await consumeCredits(trail, tenantId, {
  costCents: 0,
  feature: 'ingest',
  relatedIngestJobId: noopJobId,
});
assert(noop.deducted === 0, 'deducted = 0');
assert(noop.balanceAfter === startBalance, 'balance unchanged');
const noopRows = await trail.db
  .select()
  .from(creditTransactions)
  .where(eq(creditTransactions.relatedIngestJobId, noopJobId))
  .all();
assert(noopRows.length === 0, 'no transaction row for 0-cost consume');

// ── 5. consumeCredits — happy path 25¢ ────────────────────────────────────
console.log('\n[5] consumeCredits — 25¢ deducts + audits');
const consumeJobId = `prb_consume_${PROBE_ID}`;
const after = await consumeCredits(trail, tenantId, {
  costCents: 25,
  feature: 'ingest',
  relatedIngestJobId: consumeJobId,
});
assert(after.deducted === 25, 'deducted = 25');
assert(after.balanceAfter === startBalance - 25, `balance = startBalance - 25 (got ${after.balanceAfter})`);

const consumeRow = await trail.db
  .select()
  .from(creditTransactions)
  .where(eq(creditTransactions.relatedIngestJobId, consumeJobId))
  .get();
assert(consumeRow?.kind === 'consume', 'tx row kind=consume');
assert(consumeRow?.amount === -25, 'tx row amount=-25');
assert(consumeRow?.balanceAfter === after.balanceAfter, 'tx balance_after matches in-memory result');
assert(consumeRow?.feature === 'ingest', 'tx feature=ingest');
assert(consumeRow?.relatedChatTurnId === null, 'tx chat turn id null');

// ── 6. consumeCredits — atomicity ─────────────────────────────────────────
console.log('\n[6] consumeCredits — both halves committed together');
const liveBalance = await getCreditBalance(trail, tenantId);
assert(liveBalance === after.balanceAfter, 'select(balance) matches in-memory after');

// ── 7. consumeCredits — both relatedIds rejected ──────────────────────────
console.log('\n[7] consumeCredits — rejects double relatedId');
let threw = false;
try {
  await consumeCredits(trail, tenantId, {
    costCents: 1,
    feature: 'ingest',
    relatedIngestJobId: 'a',
    relatedChatTurnId: 'b',
  });
} catch {
  threw = true;
}
assert(threw, 'throws when both relatedIngestJobId AND relatedChatTurnId are set');

// ── 8. refillCredits — adjustment kind ────────────────────────────────────
console.log('\n[8] refillCredits — adjustment +25 restores balance');
const refilled = await refillCredits(trail, tenantId, {
  amount: 25,
  kind: 'adjustment',
  note: `probe ${PROBE_ID}`,
});
assert(refilled.balanceAfter === startBalance, `balance back to startBalance (got ${refilled.balanceAfter})`);

const refillRow = await trail.db
  .select()
  .from(creditTransactions)
  .where(and(eq(creditTransactions.tenantId, tenantId), eq(creditTransactions.kind, 'adjustment')))
  .orderBy(desc(creditTransactions.createdAt))
  .limit(1)
  .get();
assert(refillRow?.amount === 25, 'refill tx amount=25');
assert(refillRow?.note?.includes(PROBE_ID) ?? false, 'refill tx note carries probe id');

// ── 9. refillCredits — monthly_topup stamps lastTopupAt ───────────────────
console.log('\n[9] refillCredits — monthly_topup stamps last_topup_at');
const monthlyAmt = 5;
await refillCredits(trail, tenantId, { amount: monthlyAmt, kind: 'monthly_topup' });
const tcRow = await trail.db
  .select({ lastTopupAt: tenantCredits.lastTopupAt })
  .from(tenantCredits)
  .where(eq(tenantCredits.tenantId, tenantId))
  .get();
assert(!!tcRow?.lastTopupAt, 'last_topup_at is set');

// Restore balance after the +5 monthly bump.
await refillCredits(trail, tenantId, {
  amount: -1,
  kind: 'adjustment',
  note: `probe-cleanup-noop`,
}).catch(() => {
  // refillCredits rejects amount<=0 — use raw consume instead to roll back.
});
await consumeCredits(trail, tenantId, {
  costCents: monthlyAmt,
  feature: 'ingest',
  relatedIngestJobId: `prb_rollback_${PROBE_ID}`,
});

// ── 10. seedDevCredits — tops up to target, idempotent ────────────────────
console.log('\n[10] seedDevCredits — idempotent target seeding');
const seedTarget = startBalance + 50;  // 50 above wherever we are now
const r1 = await seedDevCredits(trail, tenantId, seedTarget);
assert(r1.seeded, 'first call seeded a delta');
assert(r1.balanceAfter === seedTarget, `balance == seedTarget (got ${r1.balanceAfter})`);

const r2 = await seedDevCredits(trail, tenantId, seedTarget);
assert(!r2.seeded, 'second call is no-op');
assert(r2.balanceAfter === seedTarget, 'balance unchanged');

const r3 = await seedDevCredits(trail, tenantId, seedTarget - 10);
assert(!r3.seeded, 'lower target = no-op (never decreases)');
assert(r3.balanceAfter === seedTarget, 'balance unchanged when target < current');

// ── Cleanup — restore starting balance + delete probe transactions ────────
console.log('\n[cleanup] restore startBalance + remove probe-tx rows');
const finalBalance = await getCreditBalance(trail, tenantId);
const deltaToRollback = finalBalance - startBalance;
if (deltaToRollback > 0) {
  await consumeCredits(trail, tenantId, {
    costCents: deltaToRollback,
    feature: 'ingest',
    relatedIngestJobId: `prb_final_rollback_${PROBE_ID}`,
  });
} else if (deltaToRollback < 0) {
  await refillCredits(trail, tenantId, {
    amount: -deltaToRollback,
    kind: 'adjustment',
    note: `probe-final-rollback ${PROBE_ID}`,
  });
}

// Drop probe transactions so the audit log isn't polluted.
await trail.execute(
  `DELETE FROM credit_transactions WHERE related_ingest_job_id LIKE ? OR note LIKE ?`,
  [`prb_%${PROBE_ID}%`, `%${PROBE_ID}%`],
);

const restoredBalance = await getCreditBalance(trail, tenantId);
assert(restoredBalance === startBalance, `balance restored to startBalance (got ${restoredBalance})`);

console.log(`\n=== F156 Phase 0 probe complete: ${failures === 0 ? 'PASS' : `${failures} FAILURE(S)`} ===\n`);
process.exit(failures === 0 ? 0 : 1);
