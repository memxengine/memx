/**
 * Scripted end-to-end probe for F111.2 ingest_job_id attribution.
 *
 * What this proves (without burning any LLM tokens):
 *
 *   1. `writeIngestMcpConfig` produces a JSON config whose
 *      `mcpServers.trail.env.TRAIL_INGEST_JOB_ID` matches the value
 *      passed in. This is what claude CLI reads to set env on the MCP
 *      subprocess — if this is wrong, jobId never reaches the MCP.
 *
 *   2. A candidate whose metadata carries `ingestJobId` round-trips the
 *      value through `approveCreate` into `documents.ingest_job_id`.
 *      This is the write-side of wireSourceRefs's `WHERE ingest_job_id
 *      = :jobId` query. If the column isn't populated here, the whole
 *      attribution chain fails regardless of what the MCP does.
 *
 *   3. `wireSourceRefs`-style query (`SELECT … WHERE ingest_job_id = ?
 *      AND kind='wiki'`) finds the row we just stamped, confirming the
 *      column+index are usable from the same code path that runs at
 *      end-of-ingest.
 *
 * What this does NOT prove:
 *
 *   - That claude CLI actually picks up the config's `env` block and
 *     forwards it to the MCP subprocess. That's standard MCP spec
 *     behaviour; if it were broken, every env-carrying MCP config in
 *     the world would be broken.
 *   - That the LLM emits reasonable content. Not our concern here.
 *
 * Run with: `cd apps/server && bun run scripts/verify-ingest-job-id.ts`
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { createLibsqlDatabase, documents, knowledgeBases, users, tenants, queueCandidates } from '@trail/db';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Explicit repo-root DB path — apps/server/data/trail.db is a stale
// per-app copy from earlier bootstrapping; the live engine reads
// <repo-root>/data/trail.db. Probe MUST hit the same DB the engine uses
// or it's verifying the wrong schema.
const REPO_ROOT_DB = join(homedir(), 'Apps/broberg/trail/data/trail.db');
import { eq, and } from 'drizzle-orm';
import { writeIngestMcpConfig, cleanupIngestMcpConfig } from '../src/lib/mcp-config.ts';
import { resolveCandidate, createCandidate } from '@trail/core';

const PROBE_JOB_ID = `probe-${crypto.randomUUID().slice(0, 8)}`;
let failures = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

console.log(`\n=== F111.2 verification (probe job id: ${PROBE_JOB_ID}) ===\n`);

// ── 1. writeIngestMcpConfig bakes env into the file ─────────────────────────
console.log('[1] writeIngestMcpConfig writes env block');
const configPath = writeIngestMcpConfig({
  ingestJobId: PROBE_JOB_ID,
  tenantId: 't-probe',
  userId: 'u-probe',
  knowledgeBaseId: 'kb-probe',
  dataDir: '/tmp/trail-probe',
  connector: 'probe-connector',
});
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  mcpServers: { trail: { env?: Record<string, string> } };
};
const envBlock = config.mcpServers.trail.env ?? {};
assert(envBlock.TRAIL_INGEST_JOB_ID === PROBE_JOB_ID, `env.TRAIL_INGEST_JOB_ID === "${PROBE_JOB_ID}"`);
assert(envBlock.TRAIL_TENANT_ID === 't-probe', 'env.TRAIL_TENANT_ID round-trips');
assert(envBlock.TRAIL_CONNECTOR === 'probe-connector', 'env.TRAIL_CONNECTOR round-trips');
cleanupIngestMcpConfig(PROBE_JOB_ID);

// ── 2. Candidate metadata.ingestJobId → documents.ingest_job_id ─────────────
console.log('\n[2] approveCreate stamps ingest_job_id on documents row');

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });

// Pick any real KB + user to attach the test candidate to.
const kb = await trail.db.select().from(knowledgeBases).limit(1).get();
const tenant = await trail.db.select().from(tenants).limit(1).get();
const user = await trail.db
  .select()
  .from(users)
  .where(eq(users.tenantId, tenant!.id))
  .limit(1)
  .get();

if (!kb || !tenant || !user) {
  console.log('  ✗ No KB/tenant/user available — cannot run probe');
  process.exit(1);
}

const probeFilename = `probe-${PROBE_JOB_ID}.md`;
const createResult = await createCandidate(
  trail,
  tenant.id,
  {
    knowledgeBaseId: kb.id,
    kind: 'ingest-summary',
    title: `probe ${PROBE_JOB_ID}`,
    content: `Probe body for ${PROBE_JOB_ID}.`,
    metadata: JSON.stringify({
      op: 'create',
      filename: probeFilename,
      path: '/neurons/_probe/',
      connector: 'probe',
      ingestJobId: PROBE_JOB_ID,
    }),
    confidence: 1,
  },
  { id: user.id, kind: 'user' },
);
const cand = createResult.candidate;

// Auto-approval may already have fired for ingest-summary kind — use
// the returned approval if present, otherwise resolve manually.
const resolution =
  createResult.approval ??
  (await resolveCandidate(
    trail,
    tenant.id,
    cand.id,
    { id: user.id, kind: 'user' },
    { actionId: 'approve' },
  ));

assert(resolution.effect === 'approve', 'candidate approved');
assert(resolution.documentId !== null, 'approveCreate produced a documentId');

const doc = await trail.db
  .select({ id: documents.id, ingestJobId: documents.ingestJobId, kind: documents.kind })
  .from(documents)
  .where(eq(documents.id, resolution.documentId!))
  .get();
assert(doc?.ingestJobId === PROBE_JOB_ID, `documents.ingest_job_id === "${PROBE_JOB_ID}"`);
assert(doc?.kind === 'wiki', 'documents.kind === "wiki"');

// ── 3. wireSourceRefs-style query reaches the row ───────────────────────────
console.log('\n[3] wireSourceRefs query finds the stamped doc');
const found = await trail.db
  .select({ id: documents.id })
  .from(documents)
  .where(and(eq(documents.ingestJobId, PROBE_JOB_ID), eq(documents.kind, 'wiki')))
  .all();
assert(found.length === 1, 'one wiki doc matches WHERE ingest_job_id = ?');
assert(found[0]?.id === resolution.documentId, 'matched doc id equals approved candidate output');

// ── Cleanup — archive instead of delete to avoid wiki_events FK conflicts.
// The probe artifacts are clearly marked (path=/neurons/_probe/) so they're
// easy to sweep later if anyone cares; leaving them around is cheaper than
// rewriting cascade semantics to appease the FK check.
console.log('\n[cleanup] archiving probe document + candidate');
if (resolution.documentId) {
  await trail.db
    .update(documents)
    .set({ archived: true, status: 'archived' })
    .where(eq(documents.id, resolution.documentId))
    .run();
}

// ── Result ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '✓ ALL PROBES PASSED' : `✗ ${failures} probe(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
