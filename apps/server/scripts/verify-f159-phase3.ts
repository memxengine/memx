/**
 * F159 Phase 3 — schema migration + per-KB chain config + cost stamping.
 *
 * Probes:
 *   1. Migration 0021 applies cleanly: 6 new columns visible
 *      (3 on knowledge_bases, 3 on chat_turns).
 *   2. resolveChatChain honours per-KB chatBackend + chatModel single-step.
 *   3. resolveChatChain honours per-KB chatFallbackChain JSON over both
 *      env and single-step (precedence #1).
 *   4. resolveChatChain falls back to env when KB has no overrides.
 *   5. Malformed chatFallbackChain JSON falls through with a warning.
 *   6. cost stamping: chat_turns row inserts with non-NULL cost_cents
 *      + backend_used + model_used columns.
 *
 * Run:
 *   bun run apps/server/scripts/verify-f159-phase3.ts
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibsqlDatabase, knowledgeBases, tenants, users, chatSessions, chatTurns } from '@trail/db';
import { eq } from 'drizzle-orm';
import { resolveChatChain } from '../src/services/chat/index.js';

const STAGING = join(tmpdir(), `trail-f159-p3-${Date.now()}`);
mkdirSync(STAGING, { recursive: true });
const DB_PATH = join(STAGING, 'verify.db');

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
  console.log('\nF159 Phase 3 — schema + per-KB chain + cost-stamp probe\n');

  const trail = await createLibsqlDatabase({ path: DB_PATH });
  await trail.runMigrations();

  // ── 1. migration 0021 columns landed ───────────────────────────
  console.log('1. migration 0021 — new columns visible');
  const kbCols = await trail.execute("PRAGMA table_info('knowledge_bases')");
  const kbColNames = kbCols.rows.map((r) => String((r as Record<string, unknown>).name));
  for (const col of ['chat_backend', 'chat_model', 'chat_fallback_chain']) {
    assert(kbColNames.includes(col), `knowledge_bases.${col}`);
  }
  const turnCols = await trail.execute("PRAGMA table_info('chat_turns')");
  const turnColNames = turnCols.rows.map((r) => String((r as Record<string, unknown>).name));
  for (const col of ['cost_cents', 'backend_used', 'model_used']) {
    assert(turnColNames.includes(col), `chat_turns.${col}`);
  }

  // Seed minimal row set so we can attach chat_turns.
  const tenantId = 'tnt_p3';
  const userId = 'usr_p3';
  const kbId = 'kb_p3';
  await trail.db.insert(tenants).values({ id: tenantId, slug: 'p3', name: 'Phase 3 Tenant', plan: 'pro' }).run();
  await trail.db.insert(users).values({ id: userId, tenantId, email: 'p3@example.com', role: 'owner' }).run();
  await trail.db.insert(knowledgeBases).values({
    id: kbId, tenantId, createdBy: userId, name: 'P3 Trail', slug: 'p3', language: 'en',
  }).run();

  // ── 2. resolveChatChain — per-KB single-step ───────────────────
  console.log('\n2. resolveChatChain — per-KB single-step override');
  const singleStep = resolveChatChain({
    kb: { chatBackend: 'openrouter', chatModel: 'google/gemini-2.5-flash', chatFallbackChain: null },
    env: {} as NodeJS.ProcessEnv,
  });
  assert(singleStep.length === 1, '1 step from per-KB single-step');
  assert(singleStep[0]!.backend === 'openrouter', 'backend = openrouter');
  assert(singleStep[0]!.model === 'google/gemini-2.5-flash', 'model = gemini-2.5-flash');

  // ── 3. resolveChatChain — per-KB chain JSON wins over env ──────
  console.log('\n3. resolveChatChain — per-KB chatFallbackChain takes precedence');
  const multiStep = resolveChatChain({
    kb: {
      chatBackend: 'claude-cli',  // Should be IGNORED — chain wins.
      chatModel: 'claude-haiku-4-5-20251001',
      chatFallbackChain: JSON.stringify([
        { backend: 'openrouter', model: 'google/gemini-2.5-flash' },
        { backend: 'openrouter', model: 'anthropic/claude-sonnet-4-6' },
      ]),
    },
    env: { CHAT_BACKEND: 'claude-cli' } as NodeJS.ProcessEnv,
  });
  assert(multiStep.length === 2, `2-step chain (got ${multiStep.length})`);
  assert(multiStep[0]!.backend === 'openrouter' && multiStep[0]!.model === 'google/gemini-2.5-flash',
    'step 1 = openrouter:gemini-flash');
  assert(multiStep[1]!.backend === 'openrouter' && multiStep[1]!.model === 'anthropic/claude-sonnet-4-6',
    'step 2 = openrouter:claude-sonnet');

  // ── 4. resolveChatChain — env fallback when KB has no overrides ─
  console.log('\n4. resolveChatChain — env fallback');
  const envChain = resolveChatChain({
    env: { CHAT_BACKEND: 'openrouter', CHAT_MODEL: 'google/gemini-2.5-flash' } as NodeJS.ProcessEnv,
  });
  assert(envChain[0]!.backend === 'openrouter', 'env CHAT_BACKEND honoured');

  // ── 5. malformed chatFallbackChain falls through ───────────────
  console.log('\n5. resolveChatChain — malformed JSON falls through');
  const fallthrough = resolveChatChain({
    kb: { chatBackend: 'openrouter', chatModel: null, chatFallbackChain: 'this is not JSON' },
    env: {} as NodeJS.ProcessEnv,
  });
  assert(fallthrough[0]!.backend === 'openrouter', 'fell through to per-KB single-step');

  // Empty array also falls through (need at least 1 step).
  const emptyArrayFall = resolveChatChain({
    kb: { chatBackend: null, chatModel: null, chatFallbackChain: '[]' },
    env: { CHAT_BACKEND: 'openrouter' } as NodeJS.ProcessEnv,
  });
  assert(emptyArrayFall[0]!.backend === 'openrouter', 'empty-array chain fell through to env');

  // ── 6. cost stamping persists ──────────────────────────────────
  console.log('\n6. chat_turns cost/backend/model columns persist');
  const sessionId = 'chs_p3';
  await trail.db.insert(chatSessions).values({
    id: sessionId, tenantId, knowledgeBaseId: kbId, userId, title: 'p3',
  }).run();
  await trail.db.insert(chatTurns).values({
    id: 'ctn_p3a', sessionId, role: 'user', content: 'Q?',
  }).run();
  await trail.db.insert(chatTurns).values({
    id: 'ctn_p3b', sessionId, role: 'assistant', content: 'A.',
    costCents: 7,
    backendUsed: 'openrouter',
    modelUsed: 'google/gemini-2.5-flash',
    latencyMs: 1234,
  }).run();
  const turn = await trail.db.select({
    cost: chatTurns.costCents,
    backend: chatTurns.backendUsed,
    model: chatTurns.modelUsed,
  }).from(chatTurns).where(eq(chatTurns.id, 'ctn_p3b')).get();
  assert(turn?.cost === 7, `cost_cents = 7 (got ${turn?.cost})`);
  assert(turn?.backend === 'openrouter', `backend_used = openrouter`);
  assert(turn?.model === 'google/gemini-2.5-flash', `model_used = gemini-flash`);

  // Claude-CLI rows persist with NULL cost (Max-Plan flat fee).
  await trail.db.insert(chatTurns).values({
    id: 'ctn_p3c', sessionId, role: 'assistant', content: 'CLI A.',
    costCents: null,
    backendUsed: 'claude-cli',
    modelUsed: 'claude-haiku-4-5-20251001',
  }).run();
  const cliTurn = await trail.db.select({
    cost: chatTurns.costCents,
    backend: chatTurns.backendUsed,
  }).from(chatTurns).where(eq(chatTurns.id, 'ctn_p3c')).get();
  assert(cliTurn?.cost === null, 'Claude-CLI turn has NULL cost (Max-Plan flat fee)');
  assert(cliTurn?.backend === 'claude-cli', 'Claude-CLI turn stamps backend_used');

  await trail.close();
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
      console.error(`(leaving ${STAGING} on disk)`);
      process.exit(1);
    }
  });
