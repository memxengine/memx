/**
 * F148 Lag 3 — link-checker service.
 *
 * Walks every `[[wiki-link]]` in every wiki Neuron in every KB and
 * resolves it against the in-memory Neuron pool using the same four
 * strategies the backlink-extractor uses (exact filename, slugified,
 * title match, bilingual fold). Unresolved links land in the
 * `broken_links` table as durable findings that the admin UI can
 * surface to the curator.
 *
 * Runs three ways:
 *   1. At boot — `backfillLinkCheck(trail)` does one pass so existing
 *      broken links are populated on first deploy.
 *   2. Reactive — `startLinkChecker(trail)` subscribes to
 *      `candidate_approved` and re-scans the doc that just committed.
 *      Catches newly-introduced links immediately.
 *   3. Scheduled — `runFullLinkCheck(trail, kb)` is called from the
 *      lint-scheduler's 24h sweep so renames/archives that remove a
 *      target Neuron get picked up.
 *
 * Pure text + SQL work. No LLM, no external calls. Per-KB pool + KB-
 * language are cached for 60s so a burst of `candidate_approved` events
 * from a bulk ingest doesn't hammer the DB.
 *
 * The checker is READ-MOSTLY against `documents` and WRITE-ONLY against
 * `broken_links`. It does NOT rewrite Neuron content — that's a
 * curator decision, exposed via the admin's link-report panel.
 */

import {
  documents,
  knowledgeBases,
  brokenLinks,
  type TrailDatabase,
} from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { slugify, normalizedSlug } from '@trail/shared';
import { parseWikiLinks } from './backlink-extractor.js';
import { broadcaster } from './broadcast.js';

interface WikiPoolRef {
  id: string;
  filename: string;
  title: string | null;
}

interface CachedPool {
  pool: WikiPoolRef[];
  language: string;
  expiresAt: number;
}

const POOL_TTL_MS = 60_000;
const poolCache = new Map<string, CachedPool>();

function cacheKey(tenantId: string, kbId: string): string {
  return `${tenantId}:${kbId}`;
}

/**
 * Fetch the KB's wiki-doc pool + language in one pass. Cached for 60s so
 * a bulk `candidate_approved` burst during ingest doesn't trigger a
 * fresh SELECT per doc.
 */
async function getKbContext(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
): Promise<CachedPool> {
  const key = cacheKey(tenantId, kbId);
  const hit = poolCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit;

  const [pool, kbRow] = await Promise.all([
    trail.db
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
      .all(),
    trail.db
      .select({ language: knowledgeBases.language })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenantId)))
      .get(),
  ]);

  const entry: CachedPool = {
    pool,
    language: kbRow?.language ?? 'da',
    expiresAt: Date.now() + POOL_TTL_MS,
  };
  poolCache.set(key, entry);
  return entry;
}

/** Drop the cache for a KB — call after bulk changes so the next scan is fresh. */
export function invalidatePoolCache(tenantId: string, kbId: string): void {
  poolCache.delete(cacheKey(tenantId, kbId));
}

function stripExt(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, '');
}

/**
 * Same four strategies as backlink-extractor's `resolveLink`. Duplicated
 * here rather than imported because backlink-extractor's copy is
 * non-exported — and the link-checker returns the FULL ref (for
 * suggested_fix surface) while backlink-extractor only needs the id.
 *
 * Returns the resolved Neuron or null.
 */
function resolveLink(
  pool: WikiPoolRef[],
  fromDocId: string,
  linkText: string,
  language: string,
): WikiPoolRef | null {
  const target = linkText.trim();
  if (!target) return null;
  const candidates = pool.filter((n) => n.id !== fromDocId);
  if (candidates.length === 0) return null;

  const withMd = target.endsWith('.md') ? target : `${target}.md`;
  const exact = candidates.find((n) => n.filename === withMd || n.filename === target);
  if (exact) return exact;

  const slug = slugify(target) || target.toLowerCase();
  const bySlug = candidates.find((n) => stripExt(n.filename).toLowerCase() === slug);
  if (bySlug) return bySlug;

  const needle = target.toLowerCase();
  const byTitle = candidates.find((n) => (n.title ?? '').toLowerCase() === needle);
  if (byTitle) return byTitle;

  const foldedTarget = normalizedSlug(slug, language);
  const foldedMatches = candidates.filter((n) => {
    const fn = stripExt(n.filename).toLowerCase();
    return normalizedSlug(fn, language) === foldedTarget;
  });
  if (foldedMatches.length === 1) return foldedMatches[0]!;

  return null;
}

/**
 * Classic Levenshtein — O(m*n) dynamic programming. Capped at `max`: as
 * soon as every cell in a row is > max we short-circuit and return
 * max+1 so callers don't pay for long distances they don't care about.
 * Used only for suggested-fix candidates (max=2), so the cap makes the
 * hot path effectively O(m).
 */
function levenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,      // delete
        curr[j - 1]! + 1,  // insert
        prev[j - 1]! + cost, // replace
      );
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n]!;
}

/**
 * When resolveLink returned null, look for a single near-match by
 * Levenshtein ≤ 2 on the slugified candidate-title vs the slugified
 * link text. Returns the Neuron's canonical wiki-link form (its title
 * wrapped in [[…]]) as a `suggested_fix` string, or null if no clear
 * near-match exists.
 *
 * We require EXACTLY ONE near-match; ambiguity → no suggestion, let
 * the curator disambiguate manually.
 */
function suggestFix(
  pool: WikiPoolRef[],
  fromDocId: string,
  linkText: string,
): string | null {
  const targetSlug = slugify(linkText);
  if (!targetSlug) return null;
  const candidates = pool.filter((n) => n.id !== fromDocId);
  const near: WikiPoolRef[] = [];
  for (const n of candidates) {
    const candidateSlug = slugify(n.title ?? stripExt(n.filename));
    if (!candidateSlug) continue;
    const d = levenshtein(targetSlug, candidateSlug, 2);
    if (d <= 2) near.push(n);
    if (near.length > 1) return null; // ambiguity
  }
  if (near.length !== 1) return null;
  const t = near[0]!.title ?? stripExt(near[0]!.filename);
  return `[[${t}]]`;
}

/**
 * Re-scan one Neuron's body. For every [[link]] that resolves, remove
 * any stale broken_links row (the link was broken in a prior scan, now
 * fixed). For every [[link]] that does NOT resolve, upsert a
 * broken_links row. Returns counts for logging.
 */
export async function rescanDocLinks(
  trail: TrailDatabase,
  docId: string,
): Promise<{ recorded: number; resolved: number }> {
  const doc = await trail.db
    .select({
      id: documents.id,
      tenantId: documents.tenantId,
      knowledgeBaseId: documents.knowledgeBaseId,
      content: documents.content,
      kind: documents.kind,
      archived: documents.archived,
    })
    .from(documents)
    .where(eq(documents.id, docId))
    .get();

  if (!doc || doc.kind !== 'wiki' || doc.archived || !doc.content) {
    return { recorded: 0, resolved: 0 };
  }

  const { pool, language } = await getKbContext(trail, doc.tenantId, doc.knowledgeBaseId);
  const links = parseWikiLinks(doc.content);
  const seenLinkTexts = new Set<string>();
  let recorded = 0;
  let resolved = 0;

  for (const link of links) {
    seenLinkTexts.add(link.target);
    const hit = resolveLink(pool, doc.id, link.target, language);
    if (hit) {
      resolved += 1;
      // If it was previously recorded broken, clear it. Harmless no-op
      // if no prior row exists.
      await trail.db
        .delete(brokenLinks)
        .where(
          and(
            eq(brokenLinks.fromDocumentId, doc.id),
            eq(brokenLinks.linkText, link.target),
          ),
        )
        .run();
      continue;
    }

    // Not resolved — upsert broken_links row. Unique (from_document_id,
    // link_text) makes the insert a no-op on a second scan unless
    // suggested_fix changes (which it might if a near-match Neuron was
    // just added). We do a simple insert-or-update via raw SQL.
    recorded += 1;
    const suggestion = suggestFix(pool, doc.id, link.target);
    const id = `bl_${crypto.randomUUID().slice(0, 12)}`;
    await trail.execute(
      `INSERT INTO broken_links
         (id, tenant_id, knowledge_base_id, from_document_id, link_text, suggested_fix, status, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', datetime('now'))
       ON CONFLICT (from_document_id, link_text) DO UPDATE SET
         suggested_fix = excluded.suggested_fix,
         reported_at = datetime('now'),
         -- don't reset status: dismissed rows stay dismissed on re-scan
         status = CASE WHEN status = 'dismissed' THEN 'dismissed' ELSE 'open' END`,
      [id, doc.tenantId, doc.knowledgeBaseId, doc.id, link.target, suggestion],
    );
  }

  // Clean up rows for links that used to exist in this doc but no
  // longer do (e.g. the curator edited out a [[broken]] reference).
  // Cheap DELETE — bounded by the number of broken rows for this doc,
  // not the whole KB.
  const stale = await trail.db
    .select({ linkText: brokenLinks.linkText })
    .from(brokenLinks)
    .where(eq(brokenLinks.fromDocumentId, doc.id))
    .all();
  for (const row of stale) {
    if (!seenLinkTexts.has(row.linkText)) {
      await trail.db
        .delete(brokenLinks)
        .where(
          and(
            eq(brokenLinks.fromDocumentId, doc.id),
            eq(brokenLinks.linkText, row.linkText),
          ),
        )
        .run();
    }
  }

  return { recorded, resolved };
}

export interface LinkCheckSummary {
  /** Count of docs touched in this pass. */
  docsScanned: number;
  /** Total broken-link rows written (including updates). */
  openRecorded: number;
  /** Total links that resolved successfully. */
  resolved: number;
}

/**
 * Full KB sweep — iterate every non-archived wiki Neuron and re-scan.
 * Called from lint-scheduler's daily pass. Idempotent — the broken_links
 * unique index makes re-runs safe, and stale rows are pruned per-doc.
 */
export async function runFullLinkCheck(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
): Promise<LinkCheckSummary> {
  invalidatePoolCache(tenantId, kbId); // fresh pool for a full pass

  const docs = await trail.db
    .select({ id: documents.id })
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

  let openRecorded = 0;
  let resolved = 0;
  for (const d of docs) {
    const r = await rescanDocLinks(trail, d.id);
    openRecorded += r.recorded;
    resolved += r.resolved;
  }
  return { docsScanned: docs.length, openRecorded, resolved };
}

/**
 * Boot-time backfill: run a full pass on every KB so the broken_links
 * table is populated immediately after deploy. Idempotent — safe on
 * every restart.
 */
export async function backfillLinkCheck(trail: TrailDatabase): Promise<void> {
  const kbs = await trail.db
    .select({ id: knowledgeBases.id, tenantId: knowledgeBases.tenantId, name: knowledgeBases.name })
    .from(knowledgeBases)
    .all();

  let totalOpen = 0;
  let totalResolved = 0;
  let touched = 0;
  for (const kb of kbs) {
    const r = await runFullLinkCheck(trail, kb.tenantId, kb.id);
    totalOpen += r.openRecorded;
    totalResolved += r.resolved;
    if (r.openRecorded > 0 || r.resolved > 0) touched += 1;
  }
  if (totalOpen > 0 || touched > 0) {
    console.log(
      `  link-checker backfill: ${totalResolved} resolved, ${totalOpen} broken recorded across ${touched} KB${touched === 1 ? '' : 's'}`,
    );
  }
}

/**
 * Live subscriber — re-scan a doc whenever it commits via the queue.
 * Returns an unsubscribe function for graceful shutdown.
 */
export function startLinkChecker(trail: TrailDatabase): () => void {
  const unsubscribe = broadcaster.subscribe((event) => {
    if (event.type !== 'candidate_approved') return;
    if (!event.documentId) return;
    // Pool cache might be stale if this same candidate_approved just
    // created a new Neuron that another wiki_doc links to. Drop the
    // cache so the rescan sees the fresh pool.
    invalidatePoolCache(event.tenantId, event.kbId);
    void rescanDocLinks(trail, event.documentId).catch((err) => {
      console.error('[link-checker] rescan failed for', event.documentId, err);
    });
  });
  return unsubscribe;
}
