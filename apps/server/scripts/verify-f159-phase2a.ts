/**
 * F159 Phase 2a — end-to-end probe of OpenRouterChatBackend.
 *
 * Tests against REAL OpenRouter (uses OPENROUTER_API_KEY from .env)
 * + an in-memory throwaway DB seeded with a Trail + 3 Neurons.
 *
 * Three checks:
 *   1. mcpToolsToFunctionSpecs produces 8 valid OpenAI tool-specs.
 *   2. invokeTrailMcpTool dispatches a known tool against the seeded
 *      DB and returns a sensible text result.
 *   3. End-to-end: ask Gemini Flash "how many Neurons in Test Trail?"
 *      → backend should call mcp__trail__count_neurons → return "3".
 *      Asserts costCents > 0 and the answer mentions "3".
 *
 * Run:
 *   bun run --env-file=.env apps/server/scripts/verify-f159-phase2a.ts
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibsqlDatabase, knowledgeBases, tenants, documents, users } from '@trail/db';
import {
  invokeTrailMcpTool,
  mcpToolsToFunctionSpecs,
  type ToolContext,
} from '../src/services/chat/mcp-router.js';
import { OpenRouterChatBackend } from '../src/services/chat/openrouter-backend.js';

const STAGING = join(tmpdir(), `trail-f159-p2a-${Date.now()}`);
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
  console.log('\nF159 Phase 2a — OpenRouter chat backend probe\n');

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY env var required');
  }

  // ── seed throwaway DB ──────────────────────────────────────────
  console.log('1. seed throwaway Trail with 3 Neurons');
  const trail = await createLibsqlDatabase({ path: DB_PATH });
  await trail.runMigrations();
  await trail.initFTS();

  const tenantId = 'tnt_verify';
  const kbId = 'kb_verify';
  const userId = 'usr_verify';

  await trail.db.insert(tenants).values({
    id: tenantId,
    slug: 'verify',
    name: 'Verify Tenant',
    plan: 'pro',
  }).run();

  await trail.db.insert(users).values({
    id: userId,
    tenantId,
    email: 'verify@example.com',
    role: 'owner',
  }).run();

  await trail.db.insert(knowledgeBases).values({
    id: kbId,
    tenantId,
    createdBy: userId,
    name: 'Test Trail',
    slug: 'test-trail',
    language: 'en',
    description: 'Throwaway KB for F159 verify',
  }).run();

  for (let i = 1; i <= 3; i++) {
    await trail.db.insert(documents).values({
      id: `doc_${i}`,
      tenantId,
      knowledgeBaseId: kbId,
      userId,
      kind: 'wiki',
      filename: `neuron-${i}.md`,
      path: '/neurons/',
      title: `Neuron ${i}`,
      fileType: 'md',
      status: 'ready',
      content: `Body ${i}`,
      version: 1,
    }).run();
  }
  console.log(`   db at ${DB_PATH}`);

  const ctx: ToolContext = {
    trail,
    tenantId,
    defaultKbId: kbId,
    tenantName: 'Verify Tenant',
  };

  // ── 2. tool-spec generation ────────────────────────────────────
  console.log('\n2. mcpToolsToFunctionSpecs — shape check');
  const specs = mcpToolsToFunctionSpecs();
  assert(specs.length === 8, `8 tools registered (got ${specs.length})`);
  assert(
    specs.every((s) => s.type === 'function' && typeof s.function.name === 'string'),
    'every spec is type=function with a name',
  );
  assert(
    specs.every((s) => s.function.name.startsWith('mcp__trail__')),
    'every name has mcp__trail__ prefix',
  );
  const countNeuronsSpec = specs.find((s) => s.function.name === 'mcp__trail__count_neurons');
  assert(!!countNeuronsSpec, 'count_neurons spec present');
  const params = countNeuronsSpec!.function.parameters as { type: string; properties: Record<string, unknown> };
  assert(params.type === 'object', 'count_neurons params is JSON-Schema object');
  assert('knowledge_base' in params.properties, 'count_neurons params.properties includes knowledge_base');

  // ── 3. direct dispatch ──────────────────────────────────────────
  console.log('\n3. invokeTrailMcpTool — direct dispatch');
  const direct = await invokeTrailMcpTool('mcp__trail__count_neurons', {}, ctx);
  const directText = direct.content.map((c) => c.text).join('');
  assert(directText.includes('3 Neuron'), `direct call returned correct count (${directText})`);

  const trailStats = await invokeTrailMcpTool('mcp__trail__trail_stats', {}, ctx);
  const statsText = trailStats.content.map((c) => c.text).join('');
  assert(statsText.includes('Neurons: **3**'), 'trail_stats returns Neurons: 3');

  // ── 4. end-to-end against real OpenRouter ──────────────────────
  console.log('\n4. end-to-end: Gemini Flash + tool-use');
  const backend = new OpenRouterChatBackend();
  const t0 = Date.now();
  const result = await backend.run({
    trail,
    systemPrompt: 'You answer questions about a knowledge base. Use the trail tools when the user asks about counts/stats. Always call tools without a knowledge_base argument so you default to the user\'s current Trail.',
    userMessage: 'How many Neurons are in this Trail?',
    history: [],
    model: 'google/gemini-2.5-flash',
    maxTurns: 5,
    timeoutMs: 45_000,
    tenantId,
    knowledgeBaseId: kbId,
    userId,
    mcpServerPath: '', // unused for OpenRouter backend
    toolNames: [
      'mcp__trail__count_neurons',
      'mcp__trail__count_sources',
      'mcp__trail__trail_stats',
    ],
  });
  const elapsed = Date.now() - t0;
  console.log(`   elapsed=${elapsed}ms  cost=${result.costCents}¢  model=${result.modelUsed}`);
  console.log(`   answer: "${result.answer.replace(/\n/g, ' ').slice(0, 200)}"`);

  assert(result.backendUsed === 'openrouter', 'backendUsed is openrouter');
  assert(result.modelUsed === 'google/gemini-2.5-flash', 'modelUsed echoes input');
  assert(result.answer.length > 0, 'answer is non-empty');
  assert(/3/.test(result.answer), 'answer mentions "3"');
  assert(result.costCents !== null && result.costCents >= 0, `cost stamped (${result.costCents}¢)`);

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
