/**
 * F162 — verify source dedup via SHA-256 content hash.
 *
 * What this proves end-to-end (not infers):
 *   1. Migration 0024 — content_hash column + non-unique partial index
 *      both present.
 *   2. Backfill — pre-existing source rows have content_hash populated
 *      (we just observe the live state after the boot-time backfill ran).
 *   3. Fresh upload computes correct SHA-256 + writes it to the row.
 *   4. Re-upload of identical bytes returns 409 with structured payload
 *      including code='duplicate_source' + existingDocumentId.
 *   5. Re-upload of identical bytes with ?force=true returns 200 and
 *      creates a separate row whose content_hash equals the original
 *      (preserves audit trail; force just skips the gate).
 *   6. Cross-KB same-tenant same-bytes: legitimate (no 409). Tests that
 *      dedup is KB-scoped, not tenant-scoped.
 *   7. Different bytes upload normally returns 200.
 *
 * Run with: `cd apps/server && bun run scripts/verify-f162.ts`
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

const REPO_ROOT_DB = join(homedir(), 'Apps/broberg/trail/data/trail.db');
const TRAIL_BASE = process.env.TRAIL_TEST_BASE ?? 'http://127.0.0.1:58021';
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

console.log(`\n=== F162 probe (id: ${PROBE_ID}) ===\n`);

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });
await trail.runMigrations();

// ── 1. Migration 0024 schema ────────────────────────────────────────────
console.log('[1] Migration 0024 — content_hash column + index');
const cols = await trail.execute(
  `SELECT name FROM pragma_table_info('documents') WHERE name = 'content_hash'`,
);
assert(cols.rows.length === 1, 'documents.content_hash exists');

const idx = await trail.execute(
  `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_documents_content_hash'`,
);
assert(idx.rows.length === 1, 'idx_documents_content_hash exists');

// ── 2. Backfill state ──────────────────────────────────────────────────
console.log('\n[2] Backfill — at least one legacy source has hash populated');
const hashedRows = await trail.execute(
  `SELECT COUNT(*) AS n FROM documents WHERE kind='source' AND content_hash IS NOT NULL`,
);
const hashedCount = Number((hashedRows.rows[0] as { n: number }).n);
assert(hashedCount > 0, `${hashedCount} source-rows already hashed (backfill ran)`);

// ── 3-7 require HTTP. Mint probe key + KB. ─────────────────────────────
const tenant = await trail.db.select({ id: tenants.id }).from(tenants).limit(1).get();
if (!tenant) {
  console.log('  ✗ No tenant'); process.exit(1);
}
const user = await trail.db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.tenantId, tenant.id))
  .limit(1)
  .get();
if (!user) {
  console.log('  ✗ No user'); process.exit(1);
}

// Use Sanne's KB if it exists, otherwise the first.
const kbA = await trail.db
  .select({ id: knowledgeBases.id, slug: knowledgeBases.slug })
  .from(knowledgeBases)
  .where(eq(knowledgeBases.tenantId, tenant.id))
  .limit(1)
  .get();
if (!kbA) {
  console.log('  ✗ No KB'); process.exit(1);
}

// We need a SECOND KB in the same tenant for the cross-KB test. Synthesise
// one if there isn't a second already.
const otherKbs = await trail.db
  .select({ id: knowledgeBases.id, slug: knowledgeBases.slug })
  .from(knowledgeBases)
  .where(eq(knowledgeBases.tenantId, tenant.id))
  .all();
let kbBId: string;
let createdKbB = false;
const otherExisting = otherKbs.find((k) => k.id !== kbA.id);
if (otherExisting) {
  kbBId = otherExisting.id;
} else {
  kbBId = `kb_prb_${PROBE_ID}`;
  await trail.db
    .insert(knowledgeBases)
    .values({
      id: kbBId,
      tenantId: tenant.id,
      name: `probe-kb-b-${PROBE_ID}`,
      slug: `probe-kb-b-${PROBE_ID}`,
    })
    .run();
  createdKbB = true;
}

const rawKey = `trail_${createHash('sha256').update(`${PROBE_ID}-f162`).digest('hex')}`;
const keyHash = createHash('sha256').update(rawKey).digest('hex');
const keyId = `apk_f162_${PROBE_ID}`;
await trail.db
  .insert(apiKeys)
  .values({
    id: keyId,
    tenantId: tenant.id,
    userId: user.id,
    name: `f162-probe-${PROBE_ID}`,
    keyHash,
  })
  .run();

const probeBytes = new TextEncoder().encode(
  `# F162 probe ${PROBE_ID}\n\nThis is the content used to test dedup. ${PROBE_ID}.\n`,
);
const probeHash = createHash('sha256').update(probeBytes).digest('hex');
const otherProbeBytes = new TextEncoder().encode(
  `# F162 probe ${PROBE_ID} VARIANT\n\nDifferent bytes, different hash.\n`,
);

const cleanupDocIds: string[] = [];

async function uploadProbe(
  kbId: string,
  bytes: Uint8Array,
  filename: string,
  force = false,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'text/markdown' }), filename);
  const url = `${TRAIL_BASE}/api/v1/knowledge-bases/${kbId}/documents/upload${force ? '?force=true' : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rawKey}` },
    body: fd,
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status >= 200 && res.status < 300 && typeof body.id === 'string') {
    cleanupDocIds.push(body.id);
  }
  return { status: res.status, body };
}

try {
  // ── 3. Fresh upload computes + stores hash ──────────────────────────
  console.log('\n[3] Fresh upload — content_hash computed + stored');
  const r3 = await uploadProbe(kbA.id, probeBytes, `f162-probe-${PROBE_ID}.md`);
  assert(r3.status === 201, `201 Created (got ${r3.status})`);
  const docId3 = r3.body.id as string;
  const row3 = await trail.db
    .select({ contentHash: documents.contentHash })
    .from(documents)
    .where(eq(documents.id, docId3))
    .get();
  assert(row3?.contentHash === probeHash, `content_hash matches expected SHA-256`);

  // ── 4. Re-upload same bytes returns 409 ─────────────────────────────
  console.log('\n[4] Re-upload identical bytes → 409 with structured payload');
  const r4 = await uploadProbe(kbA.id, probeBytes, `f162-probe-rename-${PROBE_ID}.md`);
  assert(r4.status === 409, `409 (got ${r4.status})`);
  assert(r4.body.code === 'duplicate_source', `code=duplicate_source (got '${r4.body.code}')`);
  assert(r4.body.existingDocumentId === docId3, 'existingDocumentId points at the first upload');
  assert(typeof r4.body.existingFilename === 'string', 'existingFilename is string');
  assert(typeof r4.body.hint === 'string', 'hint is provided');

  // ── 5. ?force=true bypasses ─────────────────────────────────────────
  console.log('\n[5] ?force=true bypasses dedup; new row carries same hash');
  const r5 = await uploadProbe(
    kbA.id,
    probeBytes,
    `f162-probe-forced-${PROBE_ID}.md`,
    true,
  );
  assert(r5.status === 201, `201 (got ${r5.status})`);
  const docId5 = r5.body.id as string;
  assert(docId5 !== docId3, 'force creates a SEPARATE row');
  const row5 = await trail.db
    .select({ contentHash: documents.contentHash })
    .from(documents)
    .where(eq(documents.id, docId5))
    .get();
  assert(
    row5?.contentHash === probeHash,
    'force-uploaded row carries the same hash (audit trail intact)',
  );

  // ── 6. Cross-KB same-tenant same-bytes → 201 (KB-scoped, not tenant) ─
  console.log('\n[6] Cross-KB same-bytes — allowed (KB-scoped dedup)');
  const r6 = await uploadProbe(kbBId, probeBytes, `f162-probe-cross-${PROBE_ID}.md`);
  assert(r6.status === 201, `201 in different KB (got ${r6.status})`);

  // ── 7. Different bytes upload normally → 201 ───────────────────────
  console.log('\n[7] Different bytes — normal 201');
  const r7 = await uploadProbe(kbA.id, otherProbeBytes, `f162-probe-other-${PROBE_ID}.md`);
  assert(r7.status === 201, `201 (got ${r7.status})`);
} finally {
  // Cleanup. archived=true rather than DELETE so we don't trip any
  // FK/cascade behaviour on the legacy probe-rows.
  for (const id of cleanupDocIds) {
    await trail.db.update(documents).set({ archived: true }).where(eq(documents.id, id)).run();
  }
  await trail.db.delete(apiKeys).where(eq(apiKeys.id, keyId)).run();
  if (createdKbB) {
    await trail.db.delete(knowledgeBases).where(eq(knowledgeBases.id, kbBId)).run();
  }
}

console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s) ===\n`);
process.exit(failures === 0 ? 0 : 1);
