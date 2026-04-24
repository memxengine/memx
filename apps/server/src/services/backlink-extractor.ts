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
import { documents, knowledgeBases, wikiBacklinks, type TrailDatabase } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { slugify } from '@trail/core';
import { normalizedSlug } from '@trail/shared';
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
 * Minimal Neuron projection used by `resolveLink`. Load once per
 * extraction pass, not once per [[link]].
 */
export type WikiNeuronRef = {
  id: string;
  filename: string;
  title: string | null;
};

async function loadWikiPool(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
): Promise<WikiNeuronRef[]> {
  return trail.db
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
}

/**
 * F148 — look up the KB's configured language. Defaults to 'da' when the
 * row is missing (matches the schema default). Cheap single-row query;
 * callers with a batch (backfill) should cache per KB.
 */
async function loadKbLanguage(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
): Promise<string> {
  const row = await trail.db
    .select({ language: knowledgeBases.language })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenantId)))
    .get();
  return row?.language ?? 'da';
}

/**
 * Closed set of edge types accepted from `[[target|edge-type]]` syntax.
 * Anything the LLM emits that isn't in this list falls back to 'cites'
 * — bad edge-type strings don't break extraction, they just lose the
 * semantic annotation.
 */
export const VALID_EDGE_TYPES = [
  'cites',
  'is-a',
  'part-of',
  'contradicts',
  'supersedes',
  'example-of',
  'caused-by',
] as const;
export type EdgeType = (typeof VALID_EDGE_TYPES)[number];
const EDGE_TYPE_SET = new Set<string>(VALID_EDGE_TYPES);

export interface WikiLinkMatch {
  target: string;
  edgeType: EdgeType;
}

/**
 * Extract every `[[...]]` string from a Neuron body. Ignores frontmatter
 * (between the first pair of `---` lines) — source refs live there, and we
 * don't want to double-count a [[link]] that happens to sit in YAML.
 *
 * F137 — when the link carries an `|edge-type` suffix (`[[target|is-a]]`),
 * parse it. Bare `[[link]]`s default to 'cites'. Unknown edge-types also
 * default to 'cites' so a malformed suffix stays useful as a reference.
 */
export function parseWikiLinks(content: string): WikiLinkMatch[] {
  const withoutFrontmatter = stripFrontmatter(content);
  const matches = withoutFrontmatter.matchAll(/\[\[([^\[\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g);
  const seen = new Map<string, WikiLinkMatch>();
  for (const m of matches) {
    const target = m[1]!.trim();
    if (!target) continue;
    const suffix = (m[2] ?? '').trim().toLowerCase();
    const edgeType: EdgeType = EDGE_TYPE_SET.has(suffix) ? (suffix as EdgeType) : 'cites';
    // Dedup by target; first-write-wins on edge_type. A Neuron that
    // writes `[[A|contradicts]]` and later `[[A]]` keeps contradicts.
    // Matches how the old dedup-by-target worked, just with typed edge.
    if (seen.has(target)) continue;
    seen.set(target, { target, edgeType });
  }
  return Array.from(seen.values());
}

function stripFrontmatter(content: string): string {
  const m = content.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  return m ? content.slice(m[0].length) : content;
}

/**
 * Resolve a link to a target Neuron in the same KB. Returns null if no
 * match is found via any strategy. Pure in-memory lookup against the
 * pool — callers hoist the KB wiki-list once per extraction pass.
 *
 * F148 adds strategy 4: bilingual slug fold. When neither canonical
 * slugification nor full-title match resolves, fold both sides toward
 * the KB's configured language and retry the slug comparison. Example:
 * a Danish KB with filename `yin-and-yang.md` and a link `[[Yin og
 * Yang]]` — canonical slugify gives `yin-og-yang` vs `yin-and-yang`,
 * no match; folded to Danish canonical on both sides → `yin-og-yang`
 * on each, match. Only accepts entydig (exactly one) match — multiple
 * candidates folding to the same form means the content itself is
 * ambiguous, and we'd rather surface that via the link-checker than
 * guess at resolve-time.
 */
function resolveLink(
  pool: WikiNeuronRef[],
  fromDocId: string,
  linkText: string,
  language: string,
): { id: string } | null {
  const target = linkText.trim();
  if (!target) return null;

  // Self-link would loop a Neuron against itself — skip. Explicit guard
  // (cheaper than relying on the wiki_backlinks unique-index to reject
  // the insert attempt, and keeps the intent visible at the call site).
  const candidates = pool.filter((n) => n.id !== fromDocId);
  if (candidates.length === 0) return null;

  // Strategy 1: exact filename match (with or without .md extension).
  const withMd = target.endsWith('.md') ? target : `${target}.md`;
  const exact = candidates.find((n) => n.filename === withMd || n.filename === target);
  if (exact) return { id: exact.id };

  // Strategy 2: slugified link text matches filename stem.
  const slug = slugify(target) || target.toLowerCase();
  const bySlug = candidates.find((n) => stripExt(n.filename).toLowerCase() === slug);
  if (bySlug) return { id: bySlug.id };

  // Strategy 3: case-insensitive title match. We match the FULL title so
  // `[[F87]]` doesn't accidentally grab "F87 shipped" — use `===` on the
  // lowercased form, not includes().
  const needle = target.toLowerCase();
  const byTitle = candidates.find((n) => (n.title ?? '').toLowerCase() === needle);
  if (byTitle) return { id: byTitle.id };

  // Strategy 4 (F148): bilingual fold. Only consulted when the above
  // three canonical strategies fail. Requires entydig match — if two
  // candidates fold to the same canonical, we refuse to guess.
  const foldedTarget = normalizedSlug(slug, language);
  const foldedMatches = candidates.filter((n) => {
    const fn = stripExt(n.filename).toLowerCase();
    return normalizedSlug(fn, language) === foldedTarget;
  });
  if (foldedMatches.length === 1) return { id: foldedMatches[0]!.id };

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
  edgeType: EdgeType,
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
        edgeType,
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
 *
 * `pool` lets a batch caller (backfill) hoist the KB wiki-list once and
 * reuse it across many docs — O(N) selects become O(K) where K is the
 * number of distinct KBs. Single-doc callers omit it and we load once
 * per call — still O(1) select regardless of link count, where it used
 * to be O(L) (one per [[link]] in the body).
 */
export async function extractBacklinksForDoc(
  trail: TrailDatabase,
  docId: string,
  pool?: WikiNeuronRef[],
  language?: string,
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
  const wikiPool = pool ?? (await loadWikiPool(trail, doc.tenantId, doc.knowledgeBaseId));
  // F148: bilingual fold needs KB language. Batch callers pass it in to
  // avoid the per-doc SELECT; single-doc callers (event subscriber) pay
  // one cheap lookup here.
  const kbLanguage = language ?? (await loadKbLanguage(trail, doc.tenantId, doc.knowledgeBaseId));

  // Resolve every link, keep only those that land on a real Neuron.
  const resolved: Array<{ targetId: string; linkText: string; edgeType: EdgeType }> = [];
  for (const link of links) {
    const target = resolveLink(wikiPool, doc.id, link.target, kbLanguage);
    if (target) resolved.push({ targetId: target.id, linkText: link.target, edgeType: link.edgeType });
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
  for (const { targetId, linkText, edgeType } of resolved) {
    const ok = await insertBacklink(trail, doc, targetId, linkText, edgeType);
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
    .select({
      id: documents.id,
      tenantId: documents.tenantId,
      knowledgeBaseId: documents.knowledgeBaseId,
    })
    .from(documents)
    .where(and(eq(documents.kind, 'wiki'), eq(documents.archived, false)))
    .all();

  // Cache the wiki-pool per (tenant, KB) so a KB with thousands of
  // Neurons only triggers one SELECT for the whole backfill pass
  // instead of one per doc. Relies on the fact that `documents` isn't
  // mutated mid-backfill (we only insert/delete wiki_backlinks rows).
  const poolByKb = new Map<string, WikiNeuronRef[]>();
  // F148: KB language cached alongside the pool — the fold needs it,
  // and `knowledge_bases.language` is stable mid-backfill so one SELECT
  // per KB is plenty.
  const languageByKb = new Map<string, string>();

  let totalInserted = 0;
  let touched = 0;
  for (const d of wikiDocs) {
    const key = `${d.tenantId}|${d.knowledgeBaseId}`;
    let pool = poolByKb.get(key);
    if (!pool) {
      pool = await loadWikiPool(trail, d.tenantId, d.knowledgeBaseId);
      poolByKb.set(key, pool);
    }
    let language = languageByKb.get(key);
    if (language === undefined) {
      language = await loadKbLanguage(trail, d.tenantId, d.knowledgeBaseId);
      languageByKb.set(key, language);
    }
    const n = await extractBacklinksForDoc(trail, d.id, pool, language);
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

