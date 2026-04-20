/**
 * F141 — Neuron access rollup aggregator.
 *
 * Nightly pass (piggybacks on F32 lint-scheduler's dreaming-pass) that
 * reduces `document_access` rows into the `document_access_rollup`
 * table consumers read for usage-weighting signals. Pure SQL — no LLM
 * calls, cheap enough to run on every KB every pass.
 *
 * What the rollup computes per document:
 *   - reads_7d / reads_30d / reads_90d — time-window counts
 *   - reads_total — all-time
 *   - last_read_at — most recent entry
 *   - usage_weight — normalised 0-1 PER KB (KB's hottest Neuron = 1.0,
 *     coldest = 0). Log-scaled so one-viral-Neuron doesn't flatten the
 *     rest; consumers can use the number as-is for node-radius
 *     scaling, search tie-break, chat-context bias.
 *
 * Scope is per-KB so the per-KB `track_access` toggle can gate the
 * whole rebuild. KBs with tracking OFF skip — their rollup stays at
 * the last-computed value until tracking is flipped back on.
 */
import {
  documentAccess,
  documentAccessRollup,
  knowledgeBases,
  type TrailDatabase,
} from '@trail/db';
import { and, eq, lt, sql } from 'drizzle-orm';

interface KbAggRow {
  documentId: string;
  reads7d: number;
  reads30d: number;
  reads90d: number;
  readsTotal: number;
  lastReadAt: string | null;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/**
 * Rebuild the rollup for every non-archived KB that has tracking
 * enabled. Returns summary stats so the scheduler can log once.
 */
export async function rebuildAccessRollup(trail: TrailDatabase): Promise<{
  kbsProcessed: number;
  documentsRolledUp: number;
  elapsedMs: number;
}> {
  const t0 = Date.now();
  const kbs = await trail.db
    .select({
      id: knowledgeBases.id,
      trackAccess: knowledgeBases.trackAccess,
    })
    .from(knowledgeBases)
    .all();

  let kbsProcessed = 0;
  let documentsRolledUp = 0;

  for (const kb of kbs) {
    if (!kb.trackAccess) continue;

    const aggs = await aggregatePerDocument(trail, kb.id);
    if (aggs.length === 0) continue;

    // Normalise usage_weight per-KB: the document with the most reads
    // in the last 30d scores 1.0; every other doc scales proportional
    // to that peak (log-scaled to dampen heavy-tail dominance).
    const peak = Math.max(...aggs.map((a) => a.reads30d));
    const logPeak = peak > 0 ? Math.log1p(peak) : 1;

    await trail.db.delete(documentAccessRollup)
      .where(eq(documentAccessRollup.knowledgeBaseId, kb.id))
      .run();

    const nowIso = new Date().toISOString();
    for (const a of aggs) {
      const weight = peak > 0 ? Math.log1p(a.reads30d) / logPeak : 0;
      await trail.db.insert(documentAccessRollup).values({
        documentId: a.documentId,
        knowledgeBaseId: kb.id,
        reads7d: a.reads7d,
        reads30d: a.reads30d,
        reads90d: a.reads90d,
        readsTotal: a.readsTotal,
        lastReadAt: a.lastReadAt,
        usageWeight: weight,
        rolledUpAt: nowIso,
      }).run();
    }

    kbsProcessed += 1;
    documentsRolledUp += aggs.length;
  }

  return { kbsProcessed, documentsRolledUp, elapsedMs: Date.now() - t0 };
}

/**
 * Per-document read counts for one KB. Four separate COUNTs — easier
 * than a single UNION + pivot, and SQLite handles the indexed range
 * scans fast on the (document_id, created_at) index. Ignores
 * actor_kind='system' at query time so automated passes that slipped
 * into document_access (bootstrap migrations, etc.) don't skew the
 * weight. 'user' and 'llm' both count.
 */
async function aggregatePerDocument(
  trail: TrailDatabase,
  kbId: string,
): Promise<KbAggRow[]> {
  const d7 = daysAgo(7);
  const d30 = daysAgo(30);
  const d90 = daysAgo(90);

  const rows = (await trail.db
    .select({
      documentId: documentAccess.documentId,
      readsTotal: sql<number>`COUNT(*)`.as('reads_total'),
      reads90d: sql<number>`SUM(CASE WHEN ${documentAccess.createdAt} >= ${d90} THEN 1 ELSE 0 END)`.as('reads_90d'),
      reads30d: sql<number>`SUM(CASE WHEN ${documentAccess.createdAt} >= ${d30} THEN 1 ELSE 0 END)`.as('reads_30d'),
      reads7d: sql<number>`SUM(CASE WHEN ${documentAccess.createdAt} >= ${d7} THEN 1 ELSE 0 END)`.as('reads_7d'),
      lastReadAt: sql<string>`MAX(${documentAccess.createdAt})`.as('last_read_at'),
    })
    .from(documentAccess)
    .where(
      and(
        eq(documentAccess.knowledgeBaseId, kbId),
        // Filter system at the query level so noise doesn't propagate.
        sql`${documentAccess.actorKind} != 'system'`,
      ),
    )
    .groupBy(documentAccess.documentId)
    .all()) as unknown as Array<{
    documentId: string;
    readsTotal: number | null;
    reads90d: number | null;
    reads30d: number | null;
    reads7d: number | null;
    lastReadAt: string | null;
  }>;

  return rows.map((r) => ({
    documentId: r.documentId,
    reads7d: r.reads7d ?? 0,
    reads30d: r.reads30d ?? 0,
    reads90d: r.reads90d ?? 0,
    readsTotal: r.readsTotal ?? 0,
    lastReadAt: r.lastReadAt,
  }));
}

/**
 * Prune `document_access` rows older than `keepDays`. Keeps the table
 * from growing unbounded; the rollup retains reads_total so we don't
 * lose the all-time signal. Default 180 days — enough history to
 * compute quarterly trends without blowing up the DB.
 */
export async function pruneOldAccessRows(
  trail: TrailDatabase,
  keepDays = 180,
): Promise<number> {
  const cutoff = daysAgo(keepDays);
  const result = await trail.db
    .delete(documentAccess)
    .where(lt(documentAccess.createdAt, cutoff))
    .run();
  return result.rowsAffected ?? 0;
}
