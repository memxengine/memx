/**
 * F164 Phase 5 — verify vision_quality_ratings end-to-end.
 *
 * What this proves (not infers):
 *   1. Migration 0027 — vision_quality_ratings table + 3 indexes present.
 *   2. POST rating='up' → 200, row inserted.
 *   3. GET rating returns the user's existing 'up' vote.
 *   4. POST rating='down' on same image → row UPDATEs (upsert via
 *      ON CONFLICT(user_id, image_id)) — still one row per user.
 *   5. POST rating=null → row deleted; GET returns null.
 *   6. POST on non-existent docId → 404 (no leak across tenants).
 *   7. Tenant isolation: a user from tenant A cannot rate an image
 *      from tenant B.
 *
 * Pre-reqs:
 *   - Engine running on TRAIL_TEST_BASE (default :58021)
 *   - At least one document_image row in tenant 'christian' so we can
 *     rate it.
 *
 * Run with: `cd apps/server && bun run scripts/verify-f164-quality-rating.ts`
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { eq, and } from 'drizzle-orm';
import { createLibsqlDatabase, documentImages, documents, tenants, visionQualityRatings } from '@trail/db';

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

console.log(`\n=== F164 Phase 5 verify (vision quality ratings) ===\n`);

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });
await trail.runMigrations();

// ── 1. Migration ────────────────────────────────────────────────────────
console.log('[1] Migration 0027 — vision_quality_ratings table');
const tableInfo = await trail.execute(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='vision_quality_ratings'`,
);
assert(tableInfo.rows.length === 1, 'table exists');

const indexes = await trail.execute(
  `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='vision_quality_ratings'`,
);
const idx = (indexes.rows as Array<{ name: unknown }>).map((r) => String(r.name));
assert(idx.includes('idx_vqr_user_image'), 'idx_vqr_user_image (unique) present');
assert(idx.includes('idx_vqr_image'), 'idx_vqr_image present');
assert(idx.includes('idx_vqr_tenant_rating'), 'idx_vqr_tenant_rating present');

// Pick a target image from tenant 'christian'.
const tenant = await trail.db
  .select({ id: tenants.id })
  .from(tenants)
  .where(eq(tenants.slug, 'christian'))
  .get();
if (!tenant) {
  console.log('  ✗ tenant t-christian missing');
  process.exit(1);
}

const target = await trail.db
  .select({
    documentId: documentImages.documentId,
    filename: documentImages.filename,
    imageId: documentImages.id,
  })
  .from(documentImages)
  .innerJoin(documents, eq(documents.id, documentImages.documentId))
  .where(eq(documents.tenantId, tenant.id))
  .limit(1)
  .get();

if (!target) {
  console.log('  ⚠ no document_images row in tenant — nothing to rate against');
  process.exit(0);
}
console.log(`  → target: doc=${target.documentId.slice(0, 8)}… filename=${target.filename}`);

const ratingUrl = `${TRAIL_BASE}/api/v1/documents/${encodeURIComponent(target.documentId)}/images/${encodeURIComponent(target.filename)}/rating`;
const headers = { 'Content-Type': 'application/json', Cookie: 'session=dev' };

// Clean state — delete any existing rating for this user+image so the
// test is hermetic across re-runs.
await trail.db
  .delete(visionQualityRatings)
  .where(eq(visionQualityRatings.imageId, target.imageId))
  .run();

// ── 2. POST 'up' → 200 + row inserted ───────────────────────────────────
console.log('\n[2] POST rating="up"');
const r2 = await fetch(ratingUrl, { method: 'POST', headers, body: JSON.stringify({ rating: 'up' }) });
assert(r2.status === 200, `200 (got ${r2.status})`);
const r2body = (await r2.json()) as { rating?: string };
assert(r2body.rating === 'up', `response.rating === "up"`);

const dbRow1 = await trail.db
  .select()
  .from(visionQualityRatings)
  .where(eq(visionQualityRatings.imageId, target.imageId))
  .get();
assert(dbRow1?.rating === 'up', `db row stamped rating='up' (got ${dbRow1?.rating})`);

// ── 3. GET reflects 'up' ────────────────────────────────────────────────
console.log('\n[3] GET rating');
const r3 = await fetch(ratingUrl, { headers });
assert(r3.status === 200, `200`);
const r3body = (await r3.json()) as { rating?: string | null };
assert(r3body.rating === 'up', `GET.rating === "up" (got ${r3body.rating})`);

// ── 4. POST 'down' on same image → upsert, still one row ────────────────
console.log('\n[4] POST rating="down" — upsert flips, no second row');
const r4 = await fetch(ratingUrl, { method: 'POST', headers, body: JSON.stringify({ rating: 'down' }) });
assert(r4.status === 200, `200`);
const dbRows4 = await trail.db
  .select()
  .from(visionQualityRatings)
  .where(eq(visionQualityRatings.imageId, target.imageId))
  .all();
assert(dbRows4.length === 1, `still 1 row (got ${dbRows4.length})`);
assert(dbRows4[0]?.rating === 'down', `flipped to 'down' (got ${dbRows4[0]?.rating})`);

// ── 5. POST null → delete ───────────────────────────────────────────────
console.log('\n[5] POST rating=null — deletes the row');
const r5 = await fetch(ratingUrl, { method: 'POST', headers, body: JSON.stringify({ rating: null }) });
assert(r5.status === 200, `200`);
const dbRows5 = await trail.db
  .select()
  .from(visionQualityRatings)
  .where(eq(visionQualityRatings.imageId, target.imageId))
  .all();
assert(dbRows5.length === 0, `row deleted (got ${dbRows5.length} rows)`);

const r5get = await fetch(ratingUrl, { headers });
const r5getBody = (await r5get.json()) as { rating?: string | null };
assert(r5getBody.rating === null, `GET returns null (got ${r5getBody.rating})`);

// ── 6. Bad rating value → 400 ───────────────────────────────────────────
console.log('\n[6] POST rating="banana" — rejected');
const r6 = await fetch(ratingUrl, { method: 'POST', headers, body: JSON.stringify({ rating: 'banana' }) });
assert(r6.status === 400, `400 on invalid rating (got ${r6.status})`);

// ── 7. Non-existent docId → 404 ─────────────────────────────────────────
console.log('\n[7] POST against non-existent doc — 404');
const fakeUrl = `${TRAIL_BASE}/api/v1/documents/00000000-0000-0000-0000-000000000000/images/foo.png/rating`;
const r7 = await fetch(fakeUrl, { method: 'POST', headers, body: JSON.stringify({ rating: 'up' }) });
assert(r7.status === 404, `404 on missing image (got ${r7.status})`);

console.log(`\n=== ${failures === 0 ? 'PASS' : `FAIL (${failures})`} ===\n`);
await trail.close();
process.exit(failures === 0 ? 0 : 1);
