/**
 * F15 iter 2 — Wiki backlink extraction.
 *
 * Sibling to reference-extractor.ts. That one handles provenance
 * (Neuron → Source citations from frontmatter `sources:`). This one handles
 * navigation: `[[wiki-link]]` syntax in Neuron bodies that points to OTHER
 * Neurons. Graph-building, not citation-tracking.
 *
 * Populates `wiki_backlinks` with (fromDocumentId, toDocumentId, linkText)
 * triples. The unique index on the triple makes re-extraction idempotent —
 * safe to run on every candidate_approved + a boot sweep.
 *
 * Link resolution tries (in order):
 *   1. Exact filename match: `[[orphans-stale.md]]` → `orphans-stale.md`
 *   2. Slugified link text matches filename stem: `[[Orphans + Stale]]`
 *      → slugify → `orphans-stale` → match `orphans-stale.md`
 *   3. Case-insensitive title match: `[[F87]]` → document whose title
 *      (case-folded) contains `f87`
 *
 * Unresolved links are silently skipped — chat tools can later detect
 * "broken [[link]]" patterns for a follow-up lint, but that's not MVP.
 */
import { documents, wikiBacklinks, type TrailDatabase } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { slugify } from '@trail/core';
import type { CandidateApprovedEvent } from '@trail/shared';
import { broadcaster } from './broadcast.js';

type WikiDoc = {
  id: string;
  tenantId: string;
  knowledgeBaseId: string;
  filename: string;
  content: string | null;
  title: string | null;
};

/**
 * Extract every `[[...]]` string from a Neuron body. Ignores frontmatter
 * (between the first pair of `---` lines) — source refs live there, and we
 * don't want to double-count a [[link]] that happens to sit in YAML.
 */
export function parseWikiLinks(content: string): string[] {
  const withoutFrontmatter = stripFrontmatter(content);
  const matches = withoutFrontmatter.matchAll(/\[\[([^\[\]|\n]+?)(?:\|[^\]]*)?\]\]/g);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const raw = m[1]!.trim();
    if (!raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function stripFrontmatter(content: string): string {
  const m = content.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  return m ? content.slice(m[0].length) : content;
}

/**
 * Resolve a link to a target Neuron in the same KB. Returns null if no
 * match is found via any strategy.
 */
async function resolveLink(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
  fromDocId: string,
  linkText: string,
): Promise<{ id: string } | null> {
  const target = linkText.trim();
  if (!target) return null;

  // Load every wiki document in this KB once per extraction pass. Cheap for
  // small-to-medium KBs; if this becomes a hot path with 10k+ Neurons we
  // cache per-extractor-call. For now each candidate_approved triggers a
  // fresh query — correct by construction.
  const neurons = await trail.db
    .select({
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
    })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.knowledgeBaseId, kbId),
        eq(documents.kind, 'wiki'),
        eq(documents.archived, false),
      ),
    )
    .all();

  // Self-link would loop a Neuron against itself — skip.
  const pool = neurons.filter((n) => n.id !== fromDocId);
  if (pool.length === 0) return null;

  // Strategy 1: exact filename match (with or without .md extension).
  const withMd = target.endsWith('.md') ? target : `${target}.md`;
  const exact = pool.find((n) => n.filename === withMd || n.filename === target);
  if (exact) return { id: exact.id };

  // Strategy 2: slugified link text matches filename stem.
  const slug = slugify(target) || target.toLowerCase();
  const bySlug = pool.find((n) => stripExt(n.filename).toLowerCase() === slug);
  if (bySlug) return { id: bySlug.id };

  // Strategy 3: case-insensitive title match. We match the FULL title so
  // `[[F87]]` doesn't accidentally grab "F87 shipped" — use `===` on the
  // lowercased form, not includes().
  const needle = target.toLowerCase();
  const byTitle = pool.find((n) => (n.title ?? '').toLowerCase() === needle);
  if (byTitle) return { id: byTitle.id };

  return null;
}

function stripExt(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, '');
}

async function insertBacklink(
  trail: TrailDatabase,
  wikiDoc: WikiDoc,
  targetId: string,
  linkText: string,
): Promise<boolean> {
  const id = `bl_${crypto.randomUUID().slice(0, 12)}`;
  try {
    await trail.db
      .insert(wikiBacklinks)
      .values({
        id,
        tenantId: wikiDoc.tenantId,
        knowledgeBaseId: wikiDoc.knowledgeBaseId,
        fromDocumentId: wikiDoc.id,
        toDocumentId: targetId,
        linkText,
      })
      .run();
    return true;
  } catch {
    // Unique-index violation on the triple — idempotent re-run is expected.
    return false;
  }
}

/**
 * Extract + upsert backlinks for a single Neuron. Before inserting new ones,
 * prune backlinks from this Neuron that no longer exist in its current body
 * — otherwise a rewrite that removes a link would leave a stale backlink
 * pointing at the now-unreferenced target. Returns the count of NEW rows
 * written (existing ones skip via unique index).
 */
export async function extractBacklinksForDoc(
  trail: TrailDatabase,
  docId: string,
): Promise<number> {
  const doc = await trail.db
    .select({
      id: documents.id,
      tenantId: documents.tenantId,
      knowledgeBaseId: documents.knowledgeBaseId,
      filename: documents.filename,
      content: documents.content,
      title: documents.title,
      kind: documents.kind,
      archived: documents.archived,
    })
    .from(documents)
    .where(eq(documents.id, docId))
    .get();

  if (!doc || doc.kind !== 'wiki' || doc.archived || !doc.content) return 0;

  const links = parseWikiLinks(doc.content);

  // Resolve every link, keep only those that land on a real Neuron.
  const resolved: Array<{ targetId: string; linkText: string }> = [];
  for (const linkText of links) {
    const target = await resolveLink(trail, doc.tenantId, doc.knowledgeBaseId, doc.id, linkText);
    if (target) resolved.push({ targetId: target.id, linkText });
  }

  // Delete any prior backlinks from this doc that are no longer present in
  // its body. Without this pass, removing a [[link]] in a rewrite would
  // leave a ghost row forever. We delete first, then insert — the unique
  // index handles idempotency on re-inserts of unchanged links.
  await trail.db
    .delete(wikiBacklinks)
    .where(eq(wikiBacklinks.fromDocumentId, doc.id))
    .run();

  let inserted = 0;
  for (const { targetId, linkText } of resolved) {
    const ok = await insertBacklink(trail, doc, targetId, linkText);
    if (ok) inserted += 1;
  }
  return inserted;
}

/**
 * Boot-time backfill: scan every Neuron in every KB and populate backlinks.
 * Idempotent — safe to re-run on every restart. Logs a summary when it
 * touches anything, silent otherwise.
 */
export async function backfillBacklinks(trail: TrailDatabase): Promise<void> {
  const wikiDocs = await trail.db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.kind, 'wiki'), eq(documents.archived, false)))
    .all();

  let totalInserted = 0;
  let touched = 0;
  for (const d of wikiDocs) {
    const n = await extractBacklinksForDoc(trail, d.id);
    if (n > 0) {
      totalInserted += n;
      touched += 1;
    }
  }
  if (totalInserted > 0) {
    console.log(
      `  backlink backfill: ${totalInserted} backlink${totalInserted === 1 ? '' : 's'} written across ${touched} Neuron${touched === 1 ? '' : 's'}`,
    );
  }
}

/**
 * Start the live subscriber. Re-extracts backlinks for a Neuron whenever it
 * commits via the queue. Returns an unsubscribe function for graceful
 * shutdown.
 */
export function startBacklinkExtractor(trail: TrailDatabase): () => void {
  const unsubscribe = broadcaster.subscribe((event) => {
    if (event.type !== 'candidate_approved') return;
    run(trail, event).catch((err) => {
      console.error('[backlink-extractor] error:', err);
    });
  });
  console.log('  backlink-extractor: listening');
  return unsubscribe;
}

async function run(trail: TrailDatabase, event: CandidateApprovedEvent): Promise<void> {
  if (!event.documentId) return;
  const inserted = await extractBacklinksForDoc(trail, event.documentId);
  if (inserted > 0) {
    console.log(
      `[backlink-extractor] ${event.documentId.slice(0, 8)}…: +${inserted} backlink${inserted === 1 ? '' : 's'}`,
    );
  }
}

