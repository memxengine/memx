/**
 * F164 Phase 2 — verify the vision-rerun job-handler end-to-end.
 *
 * What this proves (not infers):
 *   1. Submit a 'vision-rerun' job referencing an existing source-doc
 *      whose images include some NULL-description rows.
 *   2. SSE stream emits 'progress' events as the handler ticks through
 *      images via pLimit(4).
 *   3. On completion, result includes { total, described, decorative,
 *      failed, model, sampleImages[] } and the sum is internally
 *      consistent (described+decorative+failed === total).
 *   4. document_images rows that succeeded now have non-null
 *      vision_description AND vision_at AND vision_model stamps.
 *   5. Handler is idempotent: re-running on the same doc when 0 NULL-
 *      rows remain returns { total: 0 } without burning Vision calls.
 *   6. Old wrapper endpoint (POST /documents/:docId/rerun-vision) still
 *      returns the legacy { rowsScanned, described, skipped, model }
 *      shape so the current admin button keeps working.
 *
 * Pre-reqs:
 *   - Engine running with TRAIL_VISION_RERUN_UI=1 + at least one of
 *     ANTHROPIC_API_KEY / OPENROUTER_API_KEY set.
 *   - At least one source-doc in tenant 'christian' with NULL-description
 *     images. We pick the first matching doc; the live Zoneterapibogen
 *     fits perfectly.
 *
 * Run with: `cd apps/server && bun run scripts/verify-f164-vision-rerun.ts`
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { eq, and, isNull, sql } from 'drizzle-orm';
import {
  createLibsqlDatabase,
  documents,
  documentImages,
  tenants,
} from '@trail/db';

const REPO_ROOT_DB = join(homedir(), 'Apps/broberg/trail/data/trail.db');
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

console.log(`\n=== F164 Phase 2 verify (vision-rerun handler) ===\n`);

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });
await trail.runMigrations();

const tenant = await trail.db
  .select({ id: tenants.id })
  .from(tenants)
  .where(eq(tenants.slug, 'christian'))
  .get();
if (!tenant) {
  console.log('  ✗ tenant t-christian missing');
  process.exit(1);
}

// Find a source doc that has NULL-description images we can re-run on.
// Pick the one with the fewest pending — keeps the verify run short.
console.log('[1] Find a source doc with NULL-description images');
const candidates = await trail.execute(
  `
  SELECT d.id, d.filename, COUNT(di.id) AS null_count
    FROM documents d
    JOIN document_images di ON di.document_id = d.id
   WHERE d.tenant_id = ?
     AND d.kind = 'source'
     AND d.archived = 0
     AND di.vision_description IS NULL
   GROUP BY d.id
   ORDER BY null_count ASC
   LIMIT 1
  `,
  [tenant.id],
);

const row = candidates.rows[0] as { id?: unknown; filename?: unknown; null_count?: unknown } | undefined;
if (!row?.id) {
  console.log('  ⚠ no source-doc with NULL-description images — nothing to verify against');
  console.log('  ⚠ upload a fresh source with images, then re-run');
  process.exit(0);
}
const docId = String(row.id);
const filename = String(row.filename);
const initialNullCount = Number(row.null_count);
console.log(`  → doc=${docId.slice(0, 8)}… filename="${filename}" nullImages=${initialNullCount}`);

// To keep the verify-run short, we cap by selectively pre-stamping
// extra images so only N remain NULL — then we run the job and assert
// it processed exactly N. This makes the test hermetic regardless of
// how many NULL rows the live doc actually has.
const MAX_TO_PROCESS = 5;
let preStamped = 0;
if (initialNullCount > MAX_TO_PROCESS) {
  const excess = initialNullCount - MAX_TO_PROCESS;
  // Stamp `excess` rows with a placeholder description so they're
  // excluded from the next NULL-only filter. We use a sentinel marker
  // we can clean up after, even on script failure.
  const SENTINEL = `__verify-f164-pre-stamp-${Date.now()}__`;
  await trail.execute(
    `
    UPDATE document_images
       SET vision_description = ?,
           vision_model = 'verify-script-pre-stamp',
           vision_at = ?,
           updated_at = ?
     WHERE id IN (
       SELECT id FROM document_images
        WHERE document_id = ? AND vision_description IS NULL
        LIMIT ?
     )
    `,
    [SENTINEL, new Date().toISOString(), new Date().toISOString(), docId, excess],
  );
  preStamped = excess;
  console.log(`  → pre-stamped ${preStamped} excess rows (sentinel marker for cleanup)`);
}

// ── 2. Submit the job via the new /jobs API ────────────────────────────
console.log('\n[2] POST /jobs — submit vision-rerun');
const submitRes = await fetch(`${TRAIL_BASE}/api/v1/jobs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: 'session=dev' },
  body: JSON.stringify({
    kind: 'vision-rerun',
    payload: { documentIds: [docId], filter: 'null-only' },
  }),
});
assert(submitRes.status === 201, `POST /jobs returns 201 (got ${submitRes.status})`);
const submitBody = (await submitRes.json()) as { id?: string };
const jobId = submitBody.id;
assert(typeof jobId === 'string' && jobId.startsWith('job_'), 'returns job_<uuid>');

// ── 3. SSE stream — wait for completion ────────────────────────────────
console.log('\n[3] SSE — stream until completion');
const sseRes = await fetch(`${TRAIL_BASE}/api/v1/jobs/${jobId}/stream`, {
  headers: { Cookie: 'session=dev', Accept: 'text/event-stream' },
});
assert(sseRes.status === 200, `SSE 200 (got ${sseRes.status})`);

const reader = sseRes.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
const deadline = Date.now() + 5 * 60_000; // 5 min cap; 5 images via API ~= 20s
let progressEvents = 0;
let finalEvent: { type: string; data: unknown } | null = null;

while (Date.now() < deadline && !finalEvent) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const blocks = buffer.split('\n\n');
  buffer = blocks.pop() ?? '';
  for (const block of blocks) {
    const lines = block.split('\n');
    let event = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (event === 'progress') progressEvents += 1;
    if (event === 'completed' || event === 'aborted' || event === 'error') {
      finalEvent = { type: event, data: data ? JSON.parse(data) : null };
      break;
    }
  }
}
reader.cancel();

assert(finalEvent !== null, 'received terminal event');
assert(finalEvent?.type === 'completed', `terminal event is "completed" (got "${finalEvent?.type}")`);
assert(progressEvents >= 1, `received ≥1 "progress" event (got ${progressEvents})`);

// ── 4. Snapshot the final job state ────────────────────────────────────
console.log('\n[4] GET /jobs/:id — final result shape');
const snapRes = await fetch(`${TRAIL_BASE}/api/v1/jobs/${jobId}`, {
  headers: { Cookie: 'session=dev' },
});
const snap = (await snapRes.json()) as {
  status?: string;
  result?: {
    total?: number;
    described?: number;
    decorative?: number;
    failed?: number;
    model?: string;
    sampleImages?: Array<{ id: string; description: string }>;
  };
};
assert(snap.status === 'completed', `job.status='completed' (got ${snap.status})`);
const r = snap.result ?? {};
assert(typeof r.total === 'number', 'result.total is number');
assert(typeof r.described === 'number', 'result.described is number');
assert(typeof r.decorative === 'number', 'result.decorative is number');
assert(typeof r.failed === 'number', 'result.failed is number');
assert(typeof r.model === 'string' && r.model.length > 0, 'result.model populated');
assert(
  Array.isArray(r.sampleImages),
  'result.sampleImages is array',
);
assert(
  (r.described ?? 0) + (r.decorative ?? 0) + (r.failed ?? 0) === (r.total ?? -1),
  `described+decorative+failed === total (${r.described}+${r.decorative}+${r.failed} vs ${r.total})`,
);

const expectedTotal = Math.min(initialNullCount, MAX_TO_PROCESS);
assert(
  r.total === expectedTotal,
  `processed expected count (${r.total} vs ${expectedTotal})`,
);

// ── 5. Verify DB stamps for described rows ─────────────────────────────
console.log('\n[5] DB state — stamps applied to described rows');
if ((r.described ?? 0) > 0) {
  const describedRows = await trail.db
    .select({
      id: documentImages.id,
      visionDescription: documentImages.visionDescription,
      visionAt: documentImages.visionAt,
      visionModel: documentImages.visionModel,
    })
    .from(documentImages)
    .where(
      and(
        eq(documentImages.documentId, docId),
        sql`${documentImages.visionDescription} IS NOT NULL`,
        sql`${documentImages.visionModel} != 'verify-script-pre-stamp'`,
      ),
    )
    .limit(3)
    .all();
  for (const dr of describedRows) {
    assert(typeof dr.visionDescription === 'string' && dr.visionDescription.length > 0, `image ${dr.id.slice(0, 8)} has description text`);
    assert(typeof dr.visionAt === 'string', `image ${dr.id.slice(0, 8)} has vision_at stamp`);
    assert(typeof dr.visionModel === 'string', `image ${dr.id.slice(0, 8)} has vision_model stamp`);
  }
}

// ── 6. Idempotency — re-run on the same doc ────────────────────────────
console.log('\n[6] Idempotency — re-run on same doc');
const remainingNull = await trail.db
  .select({ count: sql<number>`COUNT(*)` })
  .from(documentImages)
  .where(and(eq(documentImages.documentId, docId), isNull(documentImages.visionDescription)))
  .get();
console.log(`  → remaining NULL images: ${remainingNull?.count ?? '?'}`);

const submit2 = await fetch(`${TRAIL_BASE}/api/v1/jobs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: 'session=dev' },
  body: JSON.stringify({
    kind: 'vision-rerun',
    payload: { documentIds: [docId], filter: 'null-only' },
  }),
});
const job2 = (await submit2.json()) as { id: string };
// Wait for completion (poll instead of SSE — simpler, this is fast)
let finalSnap2: { status?: string; result?: { total?: number; described?: number } } = {};
const deadline2 = Date.now() + 60_000;
while (Date.now() < deadline2) {
  const s = await fetch(`${TRAIL_BASE}/api/v1/jobs/${job2.id}`, { headers: { Cookie: 'session=dev' } });
  finalSnap2 = (await s.json()) as typeof finalSnap2;
  if (finalSnap2.status === 'completed' || finalSnap2.status === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert(finalSnap2.status === 'completed', `re-run completed (got ${finalSnap2.status})`);
const expectedRerunTotal = remainingNull?.count ?? 0;
assert(
  finalSnap2.result?.total === expectedRerunTotal,
  `re-run scoped to remaining NULLs (${finalSnap2.result?.total} vs ${expectedRerunTotal})`,
);

// ── 7. Old endpoint shape — backwards-compat ──────────────────────────
console.log('\n[7] Old endpoint — POST /documents/:id/rerun-vision returns legacy shape');
const oldRes = await fetch(`${TRAIL_BASE}/api/v1/documents/${docId}/rerun-vision`, {
  method: 'POST',
  headers: { Cookie: 'session=dev' },
});
assert(oldRes.status === 200, `old endpoint 200 (got ${oldRes.status})`);
const oldBody = (await oldRes.json()) as {
  rowsScanned?: number;
  described?: number;
  skipped?: number;
  model?: string;
  jobId?: string;
};
assert(typeof oldBody.rowsScanned === 'number', 'rowsScanned present');
assert(typeof oldBody.described === 'number', 'described present');
assert(typeof oldBody.skipped === 'number', 'skipped present (decorative+failed lumped)');
assert(typeof oldBody.model === 'string', 'model present');
assert(typeof oldBody.jobId === 'string', 'jobId also surfaced (forward-compat)');

// ── Cleanup pre-stamps ─────────────────────────────────────────────────
if (preStamped > 0) {
  console.log(`\n[cleanup] reverting ${preStamped} pre-stamp rows`);
  await trail.execute(
    `
    UPDATE document_images
       SET vision_description = NULL,
           vision_model = NULL,
           vision_at = NULL
     WHERE document_id = ?
       AND vision_model = 'verify-script-pre-stamp'
    `,
    [docId],
  );
}

console.log(`\n=== ${failures === 0 ? 'PASS' : `FAIL (${failures})`} ===\n`);
await trail.close();
process.exit(failures === 0 ? 0 : 1);
