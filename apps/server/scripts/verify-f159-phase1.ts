/**
 * F159 Phase 1 — verify the new chat-backend seam works.
 *
 * Pure-logic probe: chain resolution + prompt construction. Does NOT
 * spawn claude CLI (would require the binary to be present, and Phase 1
 * is just the structural lift — same bytes go to claude either way).
 * Phase 2 adds an end-to-end probe that hits OpenRouter for real.
 *
 * Run:
 *   bun run apps/server/scripts/verify-f159-phase1.ts
 */

import {
  resolveChatChain,
  buildSystemPrompt,
  buildCliPrompt,
  createChatBackend,
  DEFAULT_CHAT_MODEL,
} from '../src/services/chat/index.js';

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
  console.log('\nF159 Phase 1 — chat-backend seam probe\n');

  // ── chain resolution ───────────────────────────────────────────
  console.log('1. resolveChatChain — defaults');
  const def = resolveChatChain();
  assert(def.length === 1, `Phase 1 chain is single-step (got ${def.length})`);
  assert(def[0]!.backend === 'claude-cli', `default backend = claude-cli (got ${def[0]!.backend})`);
  assert(def[0]!.model === DEFAULT_CHAT_MODEL, `default model = ${DEFAULT_CHAT_MODEL}`);

  console.log('\n2. resolveChatChain — env override');
  const overridden = resolveChatChain({
    env: { CHAT_BACKEND: 'openrouter', CHAT_MODEL: 'google/gemini-2.5-flash' } as any,
  });
  assert(overridden[0]!.backend === 'openrouter', 'CHAT_BACKEND env honoured');
  assert(overridden[0]!.model === 'google/gemini-2.5-flash', 'CHAT_MODEL env honoured');

  // ── system prompt construction ────────────────────────────────
  console.log('\n3. buildSystemPrompt — all variants');
  const sp1 = buildSystemPrompt({ currentTrailName: 'Sanne', context: 'some wiki context' });
  assert(sp1.includes('Sanne'), 'system prompt names current trail');
  assert(sp1.includes('Wiki Context'), 'system prompt includes context block when present');
  assert(sp1.includes('count_neurons'), 'system prompt lists tools');

  const sp2 = buildSystemPrompt({ currentTrailName: null, context: '' });
  assert(!sp2.includes('Current Trail'), 'no current-trail block when null');
  assert(!sp2.includes('Wiki Context'), 'no context block when empty');

  // ── CLI prompt construction ────────────────────────────────────
  console.log('\n4. buildCliPrompt — with + without history');
  const pNoHistory = buildCliPrompt('SYS', [], 'hej');
  assert(pNoHistory.includes('## User Question'), 'cold-start has User Question header');
  assert(!pNoHistory.includes('## Prior Conversation'), 'cold-start has NO Prior Conversation');

  const pWithHistory = buildCliPrompt('SYS', [
    { role: 'user', content: 'Hvad er trail?' },
    { role: 'assistant', content: 'En vidensbase.' },
  ], 'Ja det vil jeg gerne');
  assert(pWithHistory.includes('## Prior Conversation'), 'history has Prior Conversation header');
  assert(pWithHistory.includes('User: Hvad er trail?'), 'history transcript includes user line');
  assert(pWithHistory.includes('Assistant: En vidensbase.'), 'history transcript includes assistant line');
  assert(pWithHistory.includes('## User Question (current turn)'), 'current-turn header present');

  // ── factory dispatch ───────────────────────────────────────────
  console.log('\n5. createChatBackend — factory dispatch');
  const cli = await createChatBackend('claude-cli');
  assert(cli.id === 'claude-cli', `factory returns claude-cli backend (id=${cli.id})`);

  let openrouterRejected = false;
  try {
    await createChatBackend('openrouter');
  } catch (err) {
    openrouterRejected = err instanceof Error && err.message.includes('Phase 2');
  }
  assert(openrouterRejected, 'openrouter backend not yet available — throws Phase 2 error');

  let claudeApiRejected = false;
  try {
    await createChatBackend('claude-api');
  } catch (err) {
    claudeApiRejected = err instanceof Error && err.message.includes('Phase 2');
  }
  assert(claudeApiRejected, 'claude-api backend not yet available — throws Phase 2 error');

  console.log('\nALL GOOD ✅');
}

main()
  .catch((err) => {
    console.error('\nFAIL:', err instanceof Error ? err.message : err);
    hadFailure = true;
  })
  .finally(() => {
    process.exit(hadFailure ? 1 : 0);
  });
