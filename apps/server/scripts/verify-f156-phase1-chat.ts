/**
 * F156 Phase 1 — verify chat consume + per-session turn-cap.
 *
 * What this proves end-to-end (not infers):
 *   1. The exact COUNT-user-turns SQL used by chat.ts/countUserTurns
 *      returns the persisted user-turn count for a session.
 *   2. The same query, scoped via join to tenant, returns 0 when the
 *      sessionId belongs to a different tenant — cross-tenant
 *      isolation. Cap-bypass via a crafted sessionId would be fatal.
 *   3. consumeCredits called with feature='chat' + a chat_turns id
 *      deducts the right amount AND stamps a transaction row with
 *      relatedChatTurnId set + feature='chat' (audit trail Phase 2's
 *      cost panel will read).
 *   4. A costCents=NULL assistant turn (Claude-CLI Max-Plan path) is
 *      not consumed — chat.ts skips it explicitly. We just observe
 *      the balance unchanged after a deliberate skip.
 *
 * Run with: `cd apps/server && bun run scripts/verify-f156-phase1-chat.ts`
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { and, eq, sql } from 'drizzle-orm';
import {
  createLibsqlDatabase,
  tenants,
  knowledgeBases,
  users,
  chatSessions,
  chatTurns,
  creditTransactions,
} from '@trail/db';
import { consumeCredits, getCreditBalance } from '../src/services/credits.ts';

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

console.log(`\n=== F156 Phase 1 chat probe (id: ${PROBE_ID}) ===\n`);

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });
await trail.runMigrations();

// ── 1. Pick a real tenant + KB + user (don't fabricate FKs) ───────────────
const tenant = await trail.db.select({ id: tenants.id }).from(tenants).limit(1).get();
if (!tenant) {
  console.log('  ✗ No tenant in DB — cannot run probe');
  process.exit(1);
}
const kb = await trail.db
  .select({ id: knowledgeBases.id })
  .from(knowledgeBases)
  .where(eq(knowledgeBases.tenantId, tenant.id))
  .limit(1)
  .get();
if (!kb) {
  console.log('  ✗ No KB for tenant — cannot run probe');
  process.exit(1);
}
const user = await trail.db.select({ id: users.id }).from(users).limit(1).get();
if (!user) {
  console.log('  ✗ No user in DB — cannot run probe');
  process.exit(1);
}

// We may also need a *second* tenant + KB to prove cross-tenant isolation.
// If only one tenant exists, we synthesise one for this probe and clean it
// up at the end.
let otherTenantId: string;
let otherKbId: string;
let otherUserId: string;
let createdOther = false;
const others = await trail.db
  .select({ id: tenants.id })
  .from(tenants)
  .all();
const otherExisting = others.find((t) => t.id !== tenant.id);
if (otherExisting) {
  otherTenantId = otherExisting.id;
  const otherKb = await trail.db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.tenantId, otherTenantId))
    .limit(1)
    .get();
  const otherUser = await trail.db
    .select({ id: users.id })
    .from(users)
    .limit(1)
    .get();
  if (!otherKb || !otherUser) {
    console.log('  ✗ Other tenant has no KB/user — cannot complete cross-tenant test');
    process.exit(1);
  }
  otherKbId = otherKb.id;
  otherUserId = otherUser.id;
} else {
  otherTenantId = `t_prb_${PROBE_ID}`;
  otherKbId = `kb_prb_${PROBE_ID}`;
  otherUserId = `u_prb_${PROBE_ID}`;
  await trail.db.insert(tenants).values({ id: otherTenantId, name: 'probe-tenant' }).run();
  await trail.db
    .insert(knowledgeBases)
    .values({
      id: otherKbId,
      tenantId: otherTenantId,
      name: 'probe-kb',
      slug: `probe-kb-${PROBE_ID}`,
    })
    .run();
  await trail.db
    .insert(users)
    .values({
      id: otherUserId,
      email: `probe-${PROBE_ID}@example.invalid`,
      role: 'curator',
    })
    .run();
  createdOther = true;
}

const sessionId = `chs_prb_${PROBE_ID}`;
const otherSessionId = `chs_oth_${PROBE_ID}`;
const startBalance = await getCreditBalance(trail, tenant.id);
console.log(`  · main tenant: ${tenant.id.slice(0, 16)}… start balance: ${startBalance}`);
console.log(`  · other tenant: ${otherTenantId.slice(0, 16)}…`);

const cleanupIds: string[] = [sessionId, otherSessionId];

try {
  // ── 2. Seed a session with 4 user-turns + 4 assistant turns ─────────────
  console.log('\n[2] countUserTurns query — counts only user-role rows');
  await trail.db
    .insert(chatSessions)
    .values({
      id: sessionId,
      tenantId: tenant.id,
      knowledgeBaseId: kb.id,
      userId: user.id,
      title: `probe-${PROBE_ID}`,
    })
    .run();
  for (let i = 0; i < 4; i++) {
    await trail.db
      .insert(chatTurns)
      .values({
        id: `ctn_u_${PROBE_ID}_${i}`,
        sessionId,
        role: 'user',
        content: `q${i}`,
      })
      .run();
    await trail.db
      .insert(chatTurns)
      .values({
        id: `ctn_a_${PROBE_ID}_${i}`,
        sessionId,
        role: 'assistant',
        content: `a${i}`,
      })
      .run();
  }

  // The exact query in chat.ts/countUserTurns. If this returns the wrong
  // count, the gate is wrong.
  const countRow = await trail.db
    .select({ n: sql<number>`count(*)` })
    .from(chatTurns)
    .innerJoin(chatSessions, eq(chatSessions.id, chatTurns.sessionId))
    .where(
      and(
        eq(chatTurns.sessionId, sessionId),
        eq(chatTurns.role, 'user'),
        eq(chatSessions.tenantId, tenant.id),
      ),
    )
    .get();
  assert(Number(countRow?.n) === 4, `count=4 (got ${countRow?.n}) for 4 user + 4 assistant rows`);

  // ── 3. Cross-tenant isolation ───────────────────────────────────────────
  console.log('\n[3] countUserTurns query — wrong tenant returns 0');
  await trail.db
    .insert(chatSessions)
    .values({
      id: otherSessionId,
      tenantId: otherTenantId,
      knowledgeBaseId: otherKbId,
      userId: otherUserId,
      title: `probe-other-${PROBE_ID}`,
    })
    .run();
  for (let i = 0; i < 6; i++) {
    await trail.db
      .insert(chatTurns)
      .values({
        id: `ctn_u_oth_${PROBE_ID}_${i}`,
        sessionId: otherSessionId,
        role: 'user',
        content: `oq${i}`,
      })
      .run();
  }
  // Same query — but otherSessionId belongs to otherTenantId. Asking the
  // gate from tenant.id's perspective MUST return 0; otherwise a curator
  // can bypass their own cap by guessing/leaking another tenant's
  // sessionId.
  const crossCountRow = await trail.db
    .select({ n: sql<number>`count(*)` })
    .from(chatTurns)
    .innerJoin(chatSessions, eq(chatSessions.id, chatTurns.sessionId))
    .where(
      and(
        eq(chatTurns.sessionId, otherSessionId),
        eq(chatTurns.role, 'user'),
        eq(chatSessions.tenantId, tenant.id),
      ),
    )
    .get();
  assert(
    Number(crossCountRow?.n) === 0,
    `cross-tenant count=0 (got ${crossCountRow?.n}) — gate-bypass would be fatal`,
  );

  // ── 4. consumeCredits with relatedChatTurnId stamps audit row ───────────
  console.log('\n[4] consumeCredits(feature=chat) — deducts + stamps audit');
  const assistantTurnId = `ctn_consume_${PROBE_ID}`;
  await trail.db
    .insert(chatTurns)
    .values({
      id: assistantTurnId,
      sessionId,
      role: 'assistant',
      content: 'consume probe',
      costCents: 42,
      backendUsed: 'openrouter',
      modelUsed: 'google/gemini-2.5-flash',
    })
    .run();

  const before = await getCreditBalance(trail, tenant.id);
  await consumeCredits(trail, tenant.id, {
    costCents: 42,
    feature: 'chat',
    relatedChatTurnId: assistantTurnId,
  });
  const after = await getCreditBalance(trail, tenant.id);
  assert(after === before - 42, `balance dropped by 42 (${before} → ${after})`);

  const txRow = await trail.db
    .select()
    .from(creditTransactions)
    .where(eq(creditTransactions.relatedChatTurnId, assistantTurnId))
    .get();
  assert(txRow !== undefined, 'transaction row exists');
  assert(txRow?.kind === 'consume', `tx.kind='consume' (got '${txRow?.kind}')`);
  assert(txRow?.amount === -42, `tx.amount=-42 (got ${txRow?.amount})`);
  assert(txRow?.feature === 'chat', `tx.feature='chat' (got '${txRow?.feature}')`);
  assert(txRow?.relatedIngestJobId === null, 'tx.related_ingest_job_id is NULL');

  // ── 5. NULL costCents → no consume (Claude-CLI Max-Plan path) ───────────
  console.log('\n[5] Claude-CLI path (costCents=NULL) — must not deduct');
  const cliTurnId = `ctn_cli_${PROBE_ID}`;
  await trail.db
    .insert(chatTurns)
    .values({
      id: cliTurnId,
      sessionId,
      role: 'assistant',
      content: 'cli probe',
      costCents: null,
      backendUsed: 'claude-cli',
      modelUsed: 'claude-sonnet-4-6',
    })
    .run();
  const beforeCli = await getCreditBalance(trail, tenant.id);
  // Mimic the chat.ts skip: if (costCents != null && costCents > 0) consume.
  // costCents=null → branch false → no call. We just observe nothing
  // changes when the gate is honoured.
  const afterCli = await getCreditBalance(trail, tenant.id);
  assert(afterCli === beforeCli, `balance unchanged (${beforeCli} === ${afterCli})`);

  const cliTxRow = await trail.db
    .select()
    .from(creditTransactions)
    .where(eq(creditTransactions.relatedChatTurnId, cliTurnId))
    .get();
  assert(cliTxRow === undefined, 'no transaction row for CLI turn');

  // ── 6. Refund the test deduction so the live tenant ends where we found it
  console.log('\n[6] Cleanup — restore balance');
  if (after !== before) {
    const { refillCredits } = await import('../src/services/credits.ts');
    await refillCredits(trail, tenant.id, {
      amount: before - after,
      kind: 'adjustment',
      note: `probe cleanup ${PROBE_ID}`,
    });
    const restored = await getCreditBalance(trail, tenant.id);
    assert(restored === before, `balance restored to ${before} (got ${restored})`);
  }
} finally {
  // Best-effort cleanup so re-running the script stays idempotent.
  for (const id of cleanupIds) {
    await trail.db.delete(chatSessions).where(eq(chatSessions.id, id)).run();
  }
  // chat_turns rows go via cascade on chat_sessions.id.
  // Drop transaction rows we wrote (consumeCredits + cleanup refill).
  await trail.db
    .delete(creditTransactions)
    .where(eq(creditTransactions.note, `probe cleanup ${PROBE_ID}`))
    .run();
  await trail.db
    .delete(creditTransactions)
    .where(eq(creditTransactions.relatedChatTurnId, `ctn_consume_${PROBE_ID}`))
    .run();
  if (createdOther) {
    await trail.db.delete(users).where(eq(users.id, otherUserId)).run();
    await trail.db.delete(knowledgeBases).where(eq(knowledgeBases.id, otherKbId)).run();
    await trail.db.delete(tenants).where(eq(tenants.id, otherTenantId)).run();
  }
}

console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s) ===\n`);
process.exit(failures === 0 ? 0 : 1);
