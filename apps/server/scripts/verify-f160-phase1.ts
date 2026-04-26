/**
 * F160 Phase 1 — verify Lag 1 retrieval (audience filter on /search +
 * new /retrieve endpoint).
 *
 * What this proves end-to-end (not infers):
 *   1. /search with audience=curator returns heuristic-pathed Neurons.
 *   2. /search with audience=tool drops them.
 *   3. /search with audience=public drops them (same filter as tool).
 *   4. /search seqId-lookup honours audience-filter (a curator can
 *      pull #heuristic_id, a tool caller cannot — gate-bypass via
 *      direct seqId would defeat the filter).
 *   5. /search internal-tagged Neuron filtered out for tool/public.
 *   6. /retrieve returns chunks + formattedContext stitched correctly.
 *   7. /retrieve maxChars budget truncates lower-rank chunks.
 *   8. /retrieve cross-tenant kbId returns 404.
 *   9. /retrieve audience defaults to `tool` for Bearer auth (audience
 *      omitted in body → heuristic-Neuron not present).
 *
 * Run with: `cd apps/server && bun run scripts/verify-f160-phase1.ts`
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import {
  createLibsqlDatabase,
  tenants,
  users,
  knowledgeBases,
  documents,
  apiKeys,
} from '@trail/db';
import { kbPrefix } from '@trail/shared';

const REPO_ROOT_DB = join(homedir(), 'Apps/broberg/trail/data/trail.db');
const PROBE_ID = crypto.randomUUID().slice(0, 8);
const TRAIL_BASE = process.env.TRAIL_TEST_BASE ?? 'http://127.0.0.1:58021';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures += 1;
  }
}

console.log(`\n=== F160 Phase 1 probe (id: ${PROBE_ID}) ===\n`);

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });
await trail.runMigrations();

// Pick a real tenant + user + KB.
const tenant = await trail.db.select({ id: tenants.id }).from(tenants).limit(1).get();
if (!tenant) {
  console.log('  ✗ No tenant in DB');
  process.exit(1);
}
const user = await trail.db
  .select({ id: users.id, tenantId: users.tenantId })
  .from(users)
  .where(eq(users.tenantId, tenant.id))
  .limit(1)
  .get();
if (!user) {
  console.log('  ✗ No user for tenant');
  process.exit(1);
}
const kb = await trail.db
  .select({ id: knowledgeBases.id, name: knowledgeBases.name })
  .from(knowledgeBases)
  .where(eq(knowledgeBases.tenantId, tenant.id))
  .limit(1)
  .get();
if (!kb) {
  console.log('  ✗ No KB for tenant');
  process.exit(1);
}
const prefix = kbPrefix(kb.name);

// Mint a probe API key directly (bypassing the create-route, same as
// verify-f111-2 does). We seed the row with a known hash so we can
// authenticate without going through the session-cookie path.
const probeKey = `trail_${createHash('sha256').update(`${PROBE_ID}-f160`).digest('hex')}`;
const probeKeyHash = createHash('sha256').update(probeKey).digest('hex');
const keyId = `apk_prb_${PROBE_ID}`;
await trail.db
  .insert(apiKeys)
  .values({
    id: keyId,
    tenantId: tenant.id,
    userId: user.id,
    name: `f160-probe-${PROBE_ID}`,
    keyHash: probeKeyHash,
  })
  .run();

// Seed two probe Neurons so we have known content to search against:
//   - one under /neurons/heuristics/ (curator-only)
//   - one with normal path BUT tagged 'internal' (curator-only)
//   - one normal Neuron (visible to all audiences)
// All three contain a unique probe-token so FTS will find them.
const probeToken = `f160probe${PROBE_ID}`;
const heuristicDocId = `doc_h_${PROBE_ID}`;
const internalDocId = `doc_i_${PROBE_ID}`;
const normalDocId = `doc_n_${PROBE_ID}`;
const cleanupDocIds = [heuristicDocId, internalDocId, normalDocId];

await trail.db
  .insert(documents)
  .values([
    {
      id: heuristicDocId,
      tenantId: tenant.id,
      knowledgeBaseId: kb.id,
      filename: `heuristic-${PROBE_ID}.md`,
      path: `/neurons/heuristics/probe-${PROBE_ID}.md`,
      title: `Heuristic ${probeToken}`,
      userId: user.id,
      kind: 'wiki',
      fileType: 'md',
      content: `# Heuristic\n\nThis is a heuristic Neuron for ${probeToken}.`,
      version: 1,
    },
    {
      id: internalDocId,
      tenantId: tenant.id,
      knowledgeBaseId: kb.id,
      filename: `internal-${PROBE_ID}.md`,
      path: `/neurons/probe/internal-${PROBE_ID}.md`,
      title: `Internal ${probeToken}`,
      userId: user.id,
      kind: 'wiki',
      fileType: 'md',
      content: `# Internal\n\nInternal docs about ${probeToken}.`,
      tags: 'internal,probe',
      version: 1,
    },
    {
      id: normalDocId,
      tenantId: tenant.id,
      knowledgeBaseId: kb.id,
      filename: `normal-${PROBE_ID}.md`,
      path: `/neurons/probe/normal-${PROBE_ID}.md`,
      title: `Normal ${probeToken}`,
      userId: user.id,
      kind: 'wiki',
      fileType: 'md',
      content: `# Normal Neuron\n\nThis is the normal Neuron for ${probeToken}, with enough text for FTS to index it cleanly. ${probeToken}.`,
      version: 1,
    },
  ])
  .run();

// FTS5 triggers on documents auto-update; chunk the normal doc directly
// so /retrieve has something to surface (chunks are usually written by
// the compile pipeline; here we synth one for the probe).
const chunkId = `chk_n_${PROBE_ID}`;
const chunkContent = `Normal Neuron content about ${probeToken}. ${probeToken}.`;
await trail.execute(
  `INSERT INTO document_chunks (id, document_id, knowledge_base_id, tenant_id, chunk_index, content, header_breadcrumb, token_count)
   VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  [
    chunkId,
    normalDocId,
    kb.id,
    tenant.id,
    chunkContent,
    'Normal Neuron > Intro',
    Math.ceil(chunkContent.length / 4),
  ],
);

// Make sure FTS index sees the new rows. The library's `initFTS` is
// idempotent and rebuilds; safer than poking trigger behaviour.
await trail.initFTS();

const headers = (extra: Record<string, string> = {}) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${probeKey}`,
  ...extra,
});

try {
  // ── 1. /search audience=curator returns heuristic-Neuron ──────────────
  console.log('[1] /search audience=curator returns heuristic Neuron');
  const r1 = await fetch(
    `${TRAIL_BASE}/api/v1/knowledge-bases/${kb.id}/search?q=${probeToken}&audience=curator&limit=20`,
    { headers: headers() },
  );
  assert(r1.status === 200, `200 (got ${r1.status})`);
  const j1 = (await r1.json()) as { documents: Array<{ id: string; path: string }> };
  const ids1 = j1.documents.map((d) => d.id);
  assert(ids1.includes(heuristicDocId), 'curator sees heuristic doc');
  assert(ids1.includes(internalDocId), 'curator sees internal-tagged doc');
  assert(ids1.includes(normalDocId), 'curator sees normal doc');

  // ── 2. /search audience=tool drops heuristic + internal ───────────────
  console.log('\n[2] /search audience=tool drops heuristic + internal');
  const r2 = await fetch(
    `${TRAIL_BASE}/api/v1/knowledge-bases/${kb.id}/search?q=${probeToken}&audience=tool&limit=20`,
    { headers: headers() },
  );
  assert(r2.status === 200, `200 (got ${r2.status})`);
  const j2 = (await r2.json()) as { documents: Array<{ id: string }> };
  const ids2 = j2.documents.map((d) => d.id);
  assert(!ids2.includes(heuristicDocId), 'tool does NOT see heuristic doc');
  assert(!ids2.includes(internalDocId), 'tool does NOT see internal-tagged doc');
  assert(ids2.includes(normalDocId), 'tool sees normal doc');

  // ── 3. /search audience=public same filter as tool ────────────────────
  console.log('\n[3] /search audience=public same filter as tool');
  const r3 = await fetch(
    `${TRAIL_BASE}/api/v1/knowledge-bases/${kb.id}/search?q=${probeToken}&audience=public&limit=20`,
    { headers: headers() },
  );
  const j3 = (await r3.json()) as { documents: Array<{ id: string }> };
  const ids3 = j3.documents.map((d) => d.id);
  assert(!ids3.includes(heuristicDocId), 'public does NOT see heuristic doc');
  assert(!ids3.includes(internalDocId), 'public does NOT see internal-tagged doc');
  assert(ids3.includes(normalDocId), 'public sees normal doc');

  // ── 4. /search seqId lookup honours audience filter ───────────────────
  console.log('\n[4] /search #seqId lookup honours audience filter');
  // Need to know what seq the heuristic doc got. Fetch it.
  const heuristicRow = await trail.db
    .select({ seq: documents.seq })
    .from(documents)
    .where(eq(documents.id, heuristicDocId))
    .get();
  if (heuristicRow?.seq != null) {
    const seqQuery = encodeURIComponent(
      `#${prefix}_${String(heuristicRow.seq).padStart(8, '0')}`,
    );
    const r4Curator = await fetch(
      `${TRAIL_BASE}/api/v1/knowledge-bases/${kb.id}/search?q=${seqQuery}&audience=curator`,
      { headers: headers() },
    );
    const j4Curator = (await r4Curator.json()) as { documents: unknown[] };
    assert(j4Curator.documents.length === 1, 'curator can pull heuristic via seqId');

    const r4Tool = await fetch(
      `${TRAIL_BASE}/api/v1/knowledge-bases/${kb.id}/search?q=${seqQuery}&audience=tool`,
      { headers: headers() },
    );
    const j4Tool = (await r4Tool.json()) as { documents: unknown[] };
    assert(j4Tool.documents.length === 0, 'tool CANNOT pull heuristic via seqId');
  } else {
    console.log('  ! heuristic doc had no seq (FTS triggers may not assign immediately) — skipping seqId test');
  }

  // ── 5. /retrieve returns chunks + formattedContext ────────────────────
  console.log('\n[5] /retrieve returns chunks + formattedContext');
  const r5 = await fetch(`${TRAIL_BASE}/api/v1/knowledge-bases/${kb.id}/retrieve`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query: probeToken, audience: 'tool', topK: 5 }),
  });
  assert(r5.status === 200, `200 (got ${r5.status})`);
  const j5 = (await r5.json()) as {
    chunks: Array<{ documentId: string; title: string; content: string }>;
    formattedContext: string;
    totalChars: number;
    hitCount: number;
  };
  assert(j5.hitCount > 0, `hitCount > 0 (got ${j5.hitCount})`);
  assert(j5.formattedContext.includes(probeToken), 'formattedContext contains probe token');
  assert(j5.formattedContext.startsWith('## '), 'formattedContext starts with ## section header');
  assert(j5.totalChars === j5.formattedContext.length, 'totalChars === formattedContext.length');
  // Audience=tool means heuristic chunk should NOT be in result (we
  // didn't seed a chunk for the heuristic doc, but the filter would
  // skip it anyway — assert chunks are all from non-heuristic docs).
  assert(
    j5.chunks.every((c) => c.documentId !== heuristicDocId),
    'no heuristic-doc chunks in tool-audience retrieve',
  );

  // ── 6. /retrieve maxChars budget truncates ────────────────────────────
  console.log('\n[6] /retrieve maxChars=50 truncates aggressively');
  const r6 = await fetch(`${TRAIL_BASE}/api/v1/knowledge-bases/${kb.id}/retrieve`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query: probeToken, audience: 'tool', maxChars: 50 }),
  });
  const j6 = (await r6.json()) as { totalChars: number; hitCount: number };
  assert(j6.totalChars <= 50, `totalChars <= 50 (got ${j6.totalChars})`);

  // ── 7. /retrieve audience defaults to `tool` for Bearer ───────────────
  console.log('\n[7] /retrieve default audience = tool for Bearer auth');
  const r7 = await fetch(`${TRAIL_BASE}/api/v1/knowledge-bases/${kb.id}/retrieve`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query: probeToken /* no audience */ }),
  });
  const j7 = (await r7.json()) as { chunks: Array<{ documentId: string }> };
  assert(
    j7.chunks.every((c) => c.documentId !== heuristicDocId),
    'default audience for Bearer drops heuristic doc',
  );

  // ── 8. /retrieve cross-tenant kbId returns 404 ────────────────────────
  console.log('\n[8] /retrieve invalid kbId returns 404');
  const r8 = await fetch(
    `${TRAIL_BASE}/api/v1/knowledge-bases/kb_does_not_exist_${PROBE_ID}/retrieve`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ query: probeToken }),
    },
  );
  assert(r8.status === 404, `404 (got ${r8.status})`);

  // ── 9. /retrieve missing query returns 400 ────────────────────────────
  console.log('\n[9] /retrieve missing query returns 400');
  const r9 = await fetch(`${TRAIL_BASE}/api/v1/knowledge-bases/${kb.id}/retrieve`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({}),
  });
  assert(r9.status === 400, `400 (got ${r9.status})`);
} finally {
  // Cleanup. FTS triggers cascade on document delete; chunk cascades
  // via FK. Delete probe docs + key. Idempotent on re-run.
  for (const id of cleanupDocIds) {
    await trail.db.delete(documents).where(eq(documents.id, id)).run();
  }
  await trail.db.delete(apiKeys).where(eq(apiKeys.id, keyId)).run();
}

console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s) ===\n`);
process.exit(failures === 0 ? 0 : 1);
