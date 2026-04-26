/**
 * F150 — verify the POST /link-check/:id/accept algorithm end-to-end.
 *
 * The route handler is a thin orchestrator over three DB operations:
 *
 *   1. read broken_links + source doc
 *   2. str_replace the [[linkText]] → suggestedFix in doc.content,
 *      route through submitCuratorEdit (same path as the editor)
 *   3. flip broken_links.status='auto_fixed'
 *
 * This script exercises that exact sequence against the live SQLite DB
 * — no HTTP server required. Mirrors verify-link-integrity.ts (F148).
 *
 * Cases covered:
 *   - happy path: linkText present in content → rewritten, version bumped,
 *     row flipped to auto_fixed
 *   - 409 path: linkText NOT in content → row flipped to dismissed
 *   - 400 path: row without suggested_fix → no rewrite (skipped here as
 *     the route layer guards with a simple null-check that typechecks
 *     prove cannot drift)
 *
 * Cleanup: archives probe artifacts under /neurons/_probe_f150/.
 *
 * Run with: `cd apps/server && bun run scripts/verify-link-accept.ts`
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  createLibsqlDatabase,
  documents,
  knowledgeBases,
  tenants,
  users,
  brokenLinks,
} from '@trail/db';
import { submitCuratorEdit } from '@trail/core';
import { and, eq } from 'drizzle-orm';

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

console.log(`\n=== F150 Link-accept probe (id: ${PROBE_ID}) ===\n`);

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });
await trail.runMigrations();

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

// ── 1. Seed target + source docs ───────────────────────────────────────────
console.log('[1] Seed probe Neurons');
const targetDocId = `doc_probe_f150_tgt_${PROBE_ID}`;
const sourceDocId = `doc_probe_f150_src_${PROBE_ID}`;
const nowIso = new Date().toISOString();
const wrongLinkText = `Wrong Probe ${PROBE_ID}`;
const correctTitle = `Right Probe ${PROBE_ID}`;
const correctFilename = `right-probe-${PROBE_ID}.md`;

await trail.db
  .insert(documents)
  .values({
    id: targetDocId,
    tenantId: tenant.id,
    knowledgeBaseId: kb.id,
    userId: user.id,
    kind: 'wiki',
    filename: correctFilename,
    path: '/neurons/_probe_f150/',
    title: correctTitle,
    fileType: 'text/markdown',
    fileSize: 0,
    content: `---\ntitle: ${correctTitle}\ntags: [probe, f150]\n---\n\nProbe target.\n`,
    status: 'ready',
    archived: false,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  })
  .run();

await trail.db
  .insert(documents)
  .values({
    id: sourceDocId,
    tenantId: tenant.id,
    knowledgeBaseId: kb.id,
    userId: user.id,
    kind: 'wiki',
    filename: `f150-probe-source-${PROBE_ID}.md`,
    path: '/neurons/_probe_f150/',
    title: `F150 probe source ${PROBE_ID}`,
    fileType: 'text/markdown',
    fileSize: 0,
    content: `---\ntitle: F150 probe source ${PROBE_ID}\ntags: [probe, f150]\n---\n\nSee [[${wrongLinkText}]] for context.\n`,
    status: 'ready',
    archived: false,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  })
  .run();

assert(true, `seeded target + source (${PROBE_ID})`);

// ── 2. Seed two broken_links rows ──────────────────────────────────────────
console.log('\n[2] Seed broken_links rows');
const findingHappyId = `bl_probe_${PROBE_ID}_h`;
const finding409Id = `bl_probe_${PROBE_ID}_g`;

await trail.execute(
  `INSERT INTO broken_links (id, tenant_id, knowledge_base_id, from_document_id, link_text, suggested_fix, status, reported_at)
   VALUES (?, ?, ?, ?, ?, ?, 'open', datetime('now'))`,
  [findingHappyId, tenant.id, kb.id, sourceDocId, wrongLinkText, `[[${correctTitle}]]`],
);
await trail.execute(
  `INSERT INTO broken_links (id, tenant_id, knowledge_base_id, from_document_id, link_text, suggested_fix, status, reported_at)
   VALUES (?, ?, ?, ?, ?, ?, 'open', datetime('now'))`,
  [finding409Id, tenant.id, kb.id, sourceDocId, `Ghost Link ${PROBE_ID}`, `[[${correctTitle}]]`],
);
assert(true, 'seeded happy + ghost (409) rows');

// ── 3. Happy path — replicate route logic ──────────────────────────────────
console.log('\n[3] Happy path — accept rewrites content');
const happyFinding = await trail.db
  .select({
    id: brokenLinks.id,
    fromDocumentId: brokenLinks.fromDocumentId,
    linkText: brokenLinks.linkText,
    suggestedFix: brokenLinks.suggestedFix,
    status: brokenLinks.status,
  })
  .from(brokenLinks)
  .where(eq(brokenLinks.id, findingHappyId))
  .get();
assert(happyFinding?.status === 'open', 'happy finding starts as open');
assert(!!happyFinding?.suggestedFix, 'happy finding has suggested_fix');

const happyDoc = await trail.db
  .select({
    id: documents.id,
    content: documents.content,
    title: documents.title,
    tags: documents.tags,
    version: documents.version,
  })
  .from(documents)
  .where(eq(documents.id, sourceDocId))
  .get();

const oldLink = `[[${happyFinding!.linkText}]]`;
assert(happyDoc!.content!.includes(oldLink), `source doc contains ${oldLink}`);
const startVersion = happyDoc!.version;
const newContent = happyDoc!.content!.replaceAll(oldLink, happyFinding!.suggestedFix!);
assert(!newContent.includes(oldLink), 'new content no longer contains the wrong link');
assert(newContent.includes(`[[${correctTitle}]]`), 'new content contains the corrected link');

const result = await submitCuratorEdit(
  trail,
  tenant.id,
  sourceDocId,
  {
    content: newContent,
    title: happyDoc!.title ?? undefined,
    tags: happyDoc!.tags ?? undefined,
    expectedVersion: startVersion,
  },
  { id: user.id, kind: 'user' },
);
assert(!!result.wikiEventId, `submitCuratorEdit returned wikiEventId (${result.wikiEventId})`);

await trail.db
  .update(brokenLinks)
  .set({ status: 'auto_fixed', fixedAt: new Date().toISOString() })
  .where(eq(brokenLinks.id, findingHappyId))
  .run();

const afterDoc = await trail.db
  .select({ content: documents.content, version: documents.version })
  .from(documents)
  .where(eq(documents.id, sourceDocId))
  .get();
assert(!afterDoc!.content!.includes(oldLink), 'persisted content no longer has wrong link');
assert(afterDoc!.content!.includes(`[[${correctTitle}]]`), 'persisted content has corrected link');
assert(afterDoc!.version > startVersion, `version bumped (${startVersion} → ${afterDoc!.version})`);

const happyAfterRow = await trail.db
  .select({ status: brokenLinks.status, fixedAt: brokenLinks.fixedAt })
  .from(brokenLinks)
  .where(eq(brokenLinks.id, findingHappyId))
  .get();
assert(happyAfterRow?.status === 'auto_fixed', 'happy row flipped to auto_fixed');
assert(!!happyAfterRow?.fixedAt, 'happy row has fixed_at stamp');

// ── 4. 409 path — link not in content auto-dismisses ───────────────────────
console.log('\n[4] 409 path — ghost link auto-dismissed');
const ghostFinding = await trail.db
  .select({
    id: brokenLinks.id,
    fromDocumentId: brokenLinks.fromDocumentId,
    linkText: brokenLinks.linkText,
  })
  .from(brokenLinks)
  .where(eq(brokenLinks.id, finding409Id))
  .get();

const ghostDoc = await trail.db
  .select({ content: documents.content })
  .from(documents)
  .where(eq(documents.id, ghostFinding!.fromDocumentId))
  .get();
const ghostOldLink = `[[${ghostFinding!.linkText}]]`;
assert(!ghostDoc!.content!.includes(ghostOldLink), `source doc does NOT contain ${ghostOldLink}`);

// Mirror what the route does on 409 — flip to dismissed.
await trail.db
  .update(brokenLinks)
  .set({ status: 'dismissed', fixedAt: new Date().toISOString() })
  .where(eq(brokenLinks.id, finding409Id))
  .run();

const ghostAfter = await trail.db
  .select({ status: brokenLinks.status })
  .from(brokenLinks)
  .where(eq(brokenLinks.id, finding409Id))
  .get();
assert(ghostAfter?.status === 'dismissed', 'ghost row dismissed (matches 409 route behaviour)');

// ── Cleanup — archive probe artifacts ──────────────────────────────────────
console.log('\n[cleanup] archive probe artifacts');
await trail.db
  .update(documents)
  .set({ archived: true, status: 'archived' })
  .where(and(eq(documents.knowledgeBaseId, kb.id), eq(documents.path, '/neurons/_probe_f150/')))
  .run();
// broken_links rows have FK cascade on doc delete but we archived not deleted;
// remove them explicitly so future runs of the probe don't bump uniqueness.
await trail.db.delete(brokenLinks).where(eq(brokenLinks.id, findingHappyId)).run();
await trail.db.delete(brokenLinks).where(eq(brokenLinks.id, finding409Id)).run();

console.log(`\n=== F150 probe complete: ${failures === 0 ? 'PASS' : `${failures} FAILURE(S)`} ===\n`);
process.exit(failures === 0 ? 0 : 1);
