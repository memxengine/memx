/**
 * F149 Phase 2d smoke test — run a real OpenRouter-backed ingest of
 * ingest-reference.md into development-tester KB via Gemini Flash.
 *
 * This costs real money (estimated 2-15 cents per run per ground-truth).
 * Reads ingest-reference.md as the source, seeds it as a document,
 * configures the KB for openrouter+flash, triggers ingest, polls until
 * complete, asserts aggregates against ground-truth ranges.
 *
 * Clean-up: archives probe artifacts + resets KB's ingest config.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import {
  createLibsqlDatabase,
  documents,
  knowledgeBases,
  tenants,
  users,
  ingestJobs,
  wikiBacklinks,
  brokenLinks,
} from '@trail/db';
import { and, eq, sql } from 'drizzle-orm';
import { triggerIngest } from '../src/services/ingest.ts';

const FIXTURE_PATH = join(homedir(), 'Apps/broberg/trail/apps/server/test-fixtures/ingest-reference.md');
const GROUND_TRUTH_PATH = join(homedir(), 'Apps/broberg/trail/apps/server/test-fixtures/ingest-reference.ground-truth.json');
const REPO_ROOT_DB = join(homedir(), 'Apps/broberg/trail/data/trail.db');

const PROBE_ID = crypto.randomUUID().slice(0, 8);
const PROBE_FILENAME = `f149-smoke-${PROBE_ID}.md`;

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });

// Find development-tester KB
const kb = await trail.db
  .select()
  .from(knowledgeBases)
  .where(eq(knowledgeBases.slug, 'development-tester'))
  .get();
if (!kb) {
  console.error('✗ development-tester KB not found');
  process.exit(1);
}
console.log(`KB: ${kb.name} (${kb.slug}) — language=${kb.language}`);

const tenant = await trail.db.select().from(tenants).where(eq(tenants.id, kb.tenantId)).get();
const user = await trail.db
  .select()
  .from(users)
  .where(and(eq(users.tenantId, kb.tenantId), eq(users.role, 'owner')))
  .get();
if (!tenant || !user) {
  console.error('✗ tenant/user missing');
  process.exit(1);
}

// Save current KB ingest config so we can restore it after
const prevConfig = {
  ingestBackend: kb.ingestBackend,
  ingestModel: kb.ingestModel,
  ingestFallbackChain: kb.ingestFallbackChain,
};

// Configure KB for openrouter + gemini flash (single-step — no
// fallback so any error surfaces as failure, not masked by chain)
await trail.db
  .update(knowledgeBases)
  .set({
    ingestBackend: 'openrouter',
    ingestModel: 'google/gemini-2.5-flash',
    ingestFallbackChain: null,
  })
  .where(eq(knowledgeBases.id, kb.id))
  .run();
console.log(`✓ KB configured for openrouter + google/gemini-2.5-flash (single-step)`);

// Read fixture + insert as source
const fixtureContent = readFileSync(FIXTURE_PATH, 'utf8');
console.log(`✓ Fixture loaded (${fixtureContent.length} bytes)`);

const srcDocId = `doc_f149_${PROBE_ID}`;
const nowIso = new Date().toISOString();
await trail.db
  .insert(documents)
  .values({
    id: srcDocId,
    tenantId: kb.tenantId,
    knowledgeBaseId: kb.id,
    userId: user.id,
    kind: 'source',
    filename: PROBE_FILENAME,
    path: '/sources/',
    title: 'F149 Phase 2d smoke — Trail origin story',
    fileType: 'text/markdown',
    fileSize: fixtureContent.length,
    content: fixtureContent,
    status: 'pending',
    archived: false,
    version: 1,
    metadata: JSON.stringify({ connector: 'upload', probeId: PROBE_ID }),
    createdAt: nowIso,
    updatedAt: nowIso,
  })
  .run();
console.log(`✓ Source seeded: ${srcDocId}`);

// Trigger ingest + poll
console.log(`\n⏳ Triggering ingest via OpenRouter Gemini Flash...`);
const t0 = Date.now();
triggerIngest({ trail, docId: srcDocId, kbId: kb.id, tenantId: kb.tenantId, userId: user.id });

// Poll ingest_jobs for this doc
let job = null;
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 min
const POLL_INTERVAL_MS = 5000;
while (Date.now() - t0 < MAX_WAIT_MS) {
  job = await trail.db
    .select()
    .from(ingestJobs)
    .where(eq(ingestJobs.documentId, srcDocId))
    .get();
  if (job) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`  [${elapsed}s] status=${job.status} attempts=${job.attempts} cost=${job.costCents}¢ backend=${job.backend ?? '—'}`);
    if (job.status === 'done' || job.status === 'failed') break;
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

if (!job) {
  console.error('✗ No ingest_jobs row ever appeared');
  process.exit(1);
}

const elapsedMs = Date.now() - t0;
const elapsedSec = Math.round(elapsedMs / 1000);

console.log(`\n=== Ingest finished: ${job.status} (${elapsedSec}s, cost ${job.costCents}¢) ===\n`);
if (job.status === 'failed') {
  console.log(`Error: ${job.errorMessage}`);
}

// Query output
const producedDocs = await trail.db
  .select({ kind: documents.kind, path: documents.path, filename: documents.filename, title: documents.title })
  .from(documents)
  .where(eq(documents.ingestJobId, job.id))
  .all();

const byPath = producedDocs.reduce((acc, d) => {
  const bucket = d.path.startsWith('/neurons/concepts') ? 'concept'
    : d.path.startsWith('/neurons/entities') ? 'entity'
    : d.path.startsWith('/neurons/sources') ? 'source-summary'
    : 'other';
  acc[bucket] = (acc[bucket] ?? 0) + 1;
  return acc;
}, {} as Record<string, number>);

const backlinkCount = (await trail.execute(
  `SELECT COUNT(*) AS n FROM wiki_backlinks wb
     JOIN documents d ON d.id = wb.from_document_id
    WHERE d.ingest_job_id = ?`,
  [job.id],
)).rows[0] as { n: number };

const typedEdgeCount = (await trail.execute(
  `SELECT COUNT(*) AS n FROM wiki_backlinks wb
     JOIN documents d ON d.id = wb.from_document_id
    WHERE d.ingest_job_id = ? AND wb.edge_type != 'cites'`,
  [job.id],
)).rows[0] as { n: number };

const brokenCount = (await trail.execute(
  `SELECT COUNT(*) AS n FROM broken_links bl
     JOIN documents d ON d.id = bl.from_document_id
    WHERE d.ingest_job_id = ? AND bl.status = 'open'`,
  [job.id],
)).rows[0] as { n: number };

console.log('=== Produced ===');
console.log(`  Total docs: ${producedDocs.length}`);
console.log(`  Concepts:   ${byPath.concept ?? 0}`);
console.log(`  Entities:   ${byPath.entity ?? 0}`);
console.log(`  Source sum: ${byPath['source-summary'] ?? 0}`);
console.log(`  Other:      ${byPath.other ?? 0}`);
console.log(`  Backlinks:  ${backlinkCount.n}`);
console.log(`  Typed edges: ${typedEdgeCount.n}`);
console.log(`  Open broken links: ${brokenCount.n}`);
console.log(`  Turns: (not captured at job level yet)`);
console.log(`  Wall-clock: ${elapsedSec}s`);
console.log(`  Cost: ${job.costCents} cent`);
console.log(`  Backend: ${job.backend ?? '?'} | model_trail: ${job.modelTrail ?? '?'}`);

// Compare with ground-truth ranges
const gt = JSON.parse(readFileSync(GROUND_TRUTH_PATH, 'utf8'));
const exp = gt.expected;
function check(name: string, value: number, range: { min?: number; max?: number; exact?: number }): boolean {
  if (range.exact !== undefined) {
    const ok = value === range.exact;
    console.log(`  ${ok ? '✓' : '✗'} ${name}: ${value} (expected exactly ${range.exact})`);
    return ok;
  }
  const okMin = range.min === undefined || value >= range.min;
  const okMax = range.max === undefined || value <= range.max;
  const ok = okMin && okMax;
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${value} (expected ${range.min}..${range.max})`);
  return ok;
}

console.log('\n=== Ground-truth comparison ===');
let allOk = true;
allOk = check('source_summary_page', byPath['source-summary'] ?? 0, exp.source_summary_page.count) && allOk;
allOk = check('concept_pages', byPath.concept ?? 0, exp.concept_pages.count) && allOk;
allOk = check('entity_pages', byPath.entity ?? 0, exp.entity_pages.count) && allOk;
allOk = check('wiki_backlinks', backlinkCount.n, exp.wiki_backlinks.count) && allOk;
allOk = check('typed_edges', typedEdgeCount.n, exp.typed_edges.count) && allOk;
allOk = check('broken_links', brokenCount.n, exp.broken_links.open_count) && allOk;

// Cost should be in the Gemini Flash range
const flashRange = exp.ingest_job.cost_cents_by_backend['openrouter/google/gemini-2.5-flash'];
allOk = check('cost_cents', job.costCents, flashRange) && allOk;

// Restore KB config
console.log('\n=== Restoring KB config ===');
await trail.db
  .update(knowledgeBases)
  .set(prevConfig)
  .where(eq(knowledgeBases.id, kb.id))
  .run();
console.log(`✓ KB ingest-config restored`);

console.log(`\n${allOk ? '✓ SMOKE TEST PASSED' : '✗ SMOKE TEST: ground-truth mismatches noted above'}\n`);
process.exit(allOk && job.status === 'done' ? 0 : 1);
