/**
 * Salvage broken_links findings from the F148 first-run backfill.
 *
 * Two operations:
 *
 *   1. BULK DISMISS — rows whose link_text is a syntax-example (e.g.
 *      the prose `bare [[target]] means cites` ends up in a
 *      compiled Neuron; the link-checker sees [[target]] and records
 *      it as broken even though it was never meant as a real link).
 *      Safe because the whitelist is exact-match on a curated
 *      placeholder list.
 *
 *   2. HIGH-CONFIDENCE ACCEPT — for rows whose suggested_fix has
 *      slug-Levenshtein ≤ 1 against link_text (after bilingual fold),
 *      rewrite the source document's [[old]] → [[new]] + bump
 *      version + mark broken_link status='auto_fixed'. These are the
 *      unambiguous wins (case/hyphen-drift, trivial EN↔DA stem-drift
 *      like Qi (energy) ↔ Qi (energi)).
 *
 * Dry-run by default. Pass --apply to actually mutate the DB.
 *
 * Run with:
 *   cd apps/server && bun run scripts/salvage-broken-links.ts          # dry-run
 *   cd apps/server && bun run scripts/salvage-broken-links.ts --apply  # execute
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLibsqlDatabase, brokenLinks, documents } from '@trail/db';
import { and, eq, inArray } from 'drizzle-orm';
import { slugify, normalizedSlug } from '@trail/shared';

const APPLY = process.argv.includes('--apply');

const trail = await createLibsqlDatabase({ path: join(homedir(), 'Apps/broberg/trail/data/trail.db') });

// ── 1. Syntax-example whitelist ─────────────────────────────────────────
// These are link_text values that we're confident are prose-syntax-
// examples rather than real broken links. Exact match only — no regex
// because "trail" is a real concept name, only "[[trail]]" standalone in
// Buddy sessions isn't a genuine link (it's referring to the project).
// BUT: 4× [[trail]] in Buddy sessions is ambiguous — could be a real
// cross-reference gone wrong. Skip it from the whitelist so curator
// reviews.
const SYNTAX_WHITELIST = [
  'target',
  'x',
  'link',
  'wiki-link',
  'wiki-links',
  'kb:...',
  'ext:...',
  'part-of',
  'is-a',
  'contradicts',
  'supersedes',
  'example-of',
  'caused-by',
  'cites',
];

// ── 2. Query candidates for each operation ──────────────────────────────

// 2a. Syntax findings
const syntaxRows = await trail.db
  .select({
    id: brokenLinks.id,
    linkText: brokenLinks.linkText,
    fromDocumentId: brokenLinks.fromDocumentId,
  })
  .from(brokenLinks)
  .where(
    and(
      eq(brokenLinks.status, 'open'),
      inArray(brokenLinks.linkText, SYNTAX_WHITELIST),
    ),
  )
  .all();

// 2b. HIGH-confidence fixes — distance ≤ 1 between slugs (after fold)
function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

const allWithSugg = await trail.execute(`
  SELECT bl.id, bl.link_text, bl.suggested_fix, bl.from_document_id, kb.language
  FROM broken_links bl
  JOIN knowledge_bases kb ON kb.id = bl.knowledge_base_id
  WHERE bl.status = 'open' AND bl.suggested_fix IS NOT NULL
`);

const highConfidence: Array<{
  id: string;
  linkText: string;
  suggestedFix: string;  // raw, may or may not include [[...]]
  targetTitle: string;   // extracted from [[...]] or passthrough
  fromDocumentId: string;
  dist: number;
}> = [];
for (const r of allWithSugg.rows as any[]) {
  const sfRaw = String(r.suggested_fix);
  const sfTitle = sfRaw.replace(/^\[\[|\]\]$/g, '');  // strip bracket wrapper if present
  const linkSlug = slugify(r.link_text);
  const sfSlug = slugify(sfTitle);
  const rawDist = lev(linkSlug, sfSlug);
  const foldedDist = lev(normalizedSlug(linkSlug, r.language), normalizedSlug(sfSlug, r.language));
  const bestDist = Math.min(rawDist, foldedDist);
  if (bestDist <= 1) {
    highConfidence.push({
      id: r.id,
      linkText: r.link_text,
      suggestedFix: sfRaw,
      targetTitle: sfTitle,
      fromDocumentId: r.from_document_id,
      dist: bestDist,
    });
  }
}

// ── 3. Report what we're about to do ────────────────────────────────────
console.log(`\n=== Salvage plan (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
console.log(`[1] Bulk-dismiss ${syntaxRows.length} syntax-example rows:`);
const bySyntax = new Map<string, number>();
for (const r of syntaxRows) bySyntax.set(r.linkText, (bySyntax.get(r.linkText) ?? 0) + 1);
for (const [k, v] of [...bySyntax.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${v}× [[${k}]]`);
}

console.log(`\n[2] Accept ${highConfidence.length} HIGH-confidence fixes:`);
for (const h of highConfidence) {
  console.log(`    [[${h.linkText}]] → [[${h.targetTitle}]]  (dist=${h.dist})`);
}

// ── 4. Execute (if --apply) ─────────────────────────────────────────────
if (!APPLY) {
  console.log('\nDry run complete. Pass --apply to mutate.\n');
  process.exit(0);
}

console.log('\n=== Applying ===\n');

// 4a. Dismiss syntax rows
if (syntaxRows.length > 0) {
  const nowIso = new Date().toISOString();
  const res = await trail.db
    .update(brokenLinks)
    .set({ status: 'dismissed', fixedAt: nowIso })
    .where(
      and(
        eq(brokenLinks.status, 'open'),
        inArray(brokenLinks.linkText, SYNTAX_WHITELIST),
      ),
    )
    .run();
  console.log(`  ✓ Dismissed ${res.rowsAffected} syntax-example row(s)`);
}

// 4b. Rewrite content + accept HIGH-confidence
let accepted = 0;
let skippedNotInContent = 0;
for (const h of highConfidence) {
  const doc = await trail.db
    .select({ id: documents.id, content: documents.content, version: documents.version })
    .from(documents)
    .where(eq(documents.id, h.fromDocumentId))
    .get();
  if (!doc || !doc.content) {
    console.log(`    ✗ ${h.id}: document missing/empty — dismissed instead`);
    await trail.db.update(brokenLinks).set({ status: 'dismissed', fixedAt: new Date().toISOString() }).where(eq(brokenLinks.id, h.id)).run();
    continue;
  }
  const oldLink = `[[${h.linkText}]]`;
  const newLink = h.suggestedFix.startsWith('[[') ? h.suggestedFix : `[[${h.targetTitle}]]`;
  if (!doc.content.includes(oldLink)) {
    // The link text was already rewritten (maybe curator edited manually
    // or a prior salvage run got to it). Just dismiss the row.
    skippedNotInContent += 1;
    await trail.db
      .update(brokenLinks)
      .set({ status: 'dismissed', fixedAt: new Date().toISOString() })
      .where(eq(brokenLinks.id, h.id))
      .run();
    continue;
  }
  const newContent = doc.content.replaceAll(oldLink, newLink);
  const nowIso = new Date().toISOString();
  await trail.db
    .update(documents)
    .set({ content: newContent, version: doc.version + 1, updatedAt: nowIso })
    .where(eq(documents.id, doc.id))
    .run();
  await trail.db
    .update(brokenLinks)
    .set({ status: 'auto_fixed', fixedAt: nowIso })
    .where(eq(brokenLinks.id, h.id))
    .run();
  accepted += 1;
  console.log(`    ✓ ${oldLink} → ${newLink}  in doc ${doc.id.slice(-8)}`);
}
console.log(`  ✓ Accepted ${accepted} high-confidence fix(es); ${skippedNotInContent} already-absent dismissed`);

// ── 5. After-state summary ──────────────────────────────────────────────
const remaining = await trail.execute(`SELECT COUNT(*) AS n FROM broken_links WHERE status='open'`);
console.log(`\n=== Remaining open broken_links: ${(remaining.rows[0] as any).n} ===\n`);
