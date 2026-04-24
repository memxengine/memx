/**
 * F151 — Cost & Quality Dashboard data layer.
 *
 * Pure SQL aggregates over `ingest_jobs` + joins onto `documents`,
 * `wiki_backlinks`, `broken_links`. No LLM, no cross-row derivation.
 * 60s TTL cache keyed per (tenantId, kbId, windowDays) so a curator
 * opening the Cost tab repeatedly doesn't hammer the DB.
 *
 * Cache-bust: subscribed to `candidate_approved` — any new Neuron
 * committed might have been produced by a just-completed ingest,
 * which means ingest_jobs got a new row (cost + backend + model_trail)
 * we want the dashboard to reflect immediately.
 */

import type { TrailDatabase } from '@trail/db';
import { broadcaster } from './broadcast.js';

// ── Cost summary ────────────────────────────────────────────────────────

export interface CostSummary {
  windowDays: number;
  totalCents: number;
  /** F151 shadow — sum of cost_cents_estimated for pre-F149 untracked
   *  jobs in the window. Null when UI didn't opt-in to shadow. */
  totalEstimatedCents: number | null;
  /** Jobs completed in the window. Excludes failed/running. */
  jobCount: number;
  /** Daily totals. Days with 0 jobs are included as 0 so a sparse-KB
   *  chart still renders a continuous line. `estimatedCents` is null
   *  when shadow is off, or the cumulative estimate for that day when on. */
  byDay: Array<{ date: string; cents: number; jobs: number; estimatedCents: number | null }>;
  /** Top 10 most expensive sources by sum(cost_cents). */
  bySource: Array<{
    documentId: string;
    filename: string;
    title: string | null;
    cents: number;
    jobCount: number;
  }>;
  /**
   * Rough estimate: totalCents / (count of all wiki Neurons produced
   * by the ingests in window). 0 when no jobs exist or all costs 0
   * (Max Plan). UI renders as "—" in those cases.
   */
  avgCentsPerNeuron: number;
  /** Whether the caller opted into shadow estimates. Echoed back so
   *  UI can style accordingly without managing the flag locally. */
  includeShadow: boolean;
}

interface CostCacheEntry {
  summary: CostSummary;
  expiresAt: number;
}
const TTL_MS = 60_000;
const costCache = new Map<string, CostCacheEntry>();
function costKey(tenantId: string, kbId: string, window: number): string {
  return `${tenantId}:${kbId}:${window}`;
}

export function invalidateCostCache(tenantId: string, kbId: string): void {
  // Drop every window-size entry for this KB.
  for (const k of costCache.keys()) {
    if (k.startsWith(`${tenantId}:${kbId}:`)) costCache.delete(k);
  }
}

/**
 * Build a Cost summary for the given KB. window in days (7, 30, 90, 365).
 * Served from cache when fresh.
 *
 * `includeShadow` (F151 shadow-estimat): when true, also sum
 * `cost_cents_estimated` into totalEstimatedCents + per-day estimate,
 * so the UI can show "+ ca. $82 estimeret" below the real total.
 */
export async function getCostSummary(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
  windowDays: number,
  includeShadow = false,
): Promise<CostSummary> {
  const key = `${costKey(tenantId, kbId, windowDays)}:${includeShadow ? 'shadow' : 'real'}`;
  const hit = costCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.summary;

  const windowCutoff = `date('now', '-${Math.max(1, Math.floor(windowDays))} days')`;

  const totalRow = (await trail.execute(
    `SELECT
       COALESCE(SUM(cost_cents), 0) AS total_cents,
       COALESCE(SUM(cost_cents_estimated), 0) AS total_estimated_cents,
       COUNT(*) AS job_count
     FROM ingest_jobs
     WHERE tenant_id = ?
       AND knowledge_base_id = ?
       AND status = 'done'
       AND started_at >= ${windowCutoff}`,
    [tenantId, kbId],
  )).rows[0] as { total_cents: number; total_estimated_cents: number; job_count: number };

  const byDayRows = (await trail.execute(
    `SELECT
       date(started_at) AS day,
       COALESCE(SUM(cost_cents), 0) AS cents,
       COALESCE(SUM(cost_cents_estimated), 0) AS estimated_cents,
       COUNT(*) AS jobs
     FROM ingest_jobs
     WHERE tenant_id = ?
       AND knowledge_base_id = ?
       AND status = 'done'
       AND started_at >= ${windowCutoff}
     GROUP BY date(started_at)
     ORDER BY day ASC`,
    [tenantId, kbId],
  )).rows as Array<{ day: string; cents: number; estimated_cents: number; jobs: number }>;

  // Pad days with zero so the chart is continuous. Builds from the
  // first observed day through today; if there are no jobs at all,
  // leave empty (UI shows "no data yet").
  const paddedByDay = padDays(byDayRows, windowDays);

  const bySourceRows = (await trail.execute(
    `SELECT
       d.id AS document_id,
       d.filename,
       d.title,
       COALESCE(SUM(j.cost_cents), 0) AS cents,
       COUNT(*) AS job_count
     FROM ingest_jobs j
     JOIN documents d ON d.id = j.document_id
     WHERE j.tenant_id = ?
       AND j.knowledge_base_id = ?
       AND j.status = 'done'
       AND j.started_at >= ${windowCutoff}
     GROUP BY d.id
     ORDER BY cents DESC, job_count DESC
     LIMIT 10`,
    [tenantId, kbId],
  )).rows as Array<{ document_id: string; filename: string; title: string | null; cents: number; job_count: number }>;

  // Per-Neuron avg: total cost over count of wiki neurons produced
  // by any ingest in the window. Rough — a massive kilde producing
  // 30 neurons averages lower than a small source producing 3 that
  // happen to hit an expensive model.
  const neuronCountRow = (await trail.execute(
    `SELECT COUNT(*) AS n
     FROM documents d
     JOIN ingest_jobs j ON j.id = d.ingest_job_id
     WHERE j.tenant_id = ?
       AND j.knowledge_base_id = ?
       AND j.status = 'done'
       AND j.started_at >= ${windowCutoff}
       AND d.kind = 'wiki'
       AND d.archived = 0`,
    [tenantId, kbId],
  )).rows[0] as { n: number };

  const avgCentsPerNeuron =
    neuronCountRow.n > 0 && totalRow.total_cents > 0
      ? Math.round((totalRow.total_cents / neuronCountRow.n) * 100) / 100
      : 0;

  const summary: CostSummary = {
    windowDays,
    totalCents: totalRow.total_cents,
    totalEstimatedCents: includeShadow ? totalRow.total_estimated_cents : null,
    jobCount: totalRow.job_count,
    byDay: paddedByDay,
    bySource: bySourceRows.map((r) => ({
      documentId: r.document_id,
      filename: r.filename,
      title: r.title,
      cents: r.cents,
      jobCount: r.job_count,
    })),
    avgCentsPerNeuron,
    includeShadow,
  };

  costCache.set(key, { summary, expiresAt: Date.now() + TTL_MS });
  return summary;
}

function padDays(
  rows: Array<{ day: string; cents: number; jobs: number; estimated_cents?: number }>,
  windowDays: number,
): Array<{ date: string; cents: number; jobs: number; estimatedCents: number | null }> {
  if (rows.length === 0) return [];
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: Array<{ date: string; cents: number; jobs: number; estimatedCents: number | null }> = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);
  for (let d = new Date(start); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const hit = byDay.get(iso);
    out.push({
      date: iso,
      cents: hit?.cents ?? 0,
      jobs: hit?.jobs ?? 0,
      estimatedCents: hit?.estimated_cents ?? null,
    });
  }
  return out;
}

// ── Paginated + sortable source list ───────────────────────────────────

export type SourceSortKey = 'cost' | 'jobs' | 'filename' | 'title' | 'recent';
export type SortOrder = 'asc' | 'desc';

export interface SourcePage {
  sources: Array<{
    documentId: string;
    filename: string;
    title: string | null;
    cents: number;
    jobCount: number;
    lastIngestedAt: string | null;
  }>;
  total: number;
  limit: number;
  offset: number;
  sort: SourceSortKey;
  order: SortOrder;
}

const SORT_COLUMN: Record<SourceSortKey, string> = {
  cost: 'cents',
  jobs: 'job_count',
  filename: 'filename',
  title: 'title',
  recent: 'last_ingested_at',
};

/**
 * Full paginated + sortable source list for the Cost panel's
 * "alle kilder" table. Separate from getCostSummary's top-10 so the
 * summary endpoint stays snappy; curator pays the fan-out query cost
 * only when they actively page/sort.
 *
 * Serves cached when the cache contains a fresh match with the same
 * params; otherwise queries + caches.
 */
export async function getCostSourcesPage(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
  opts: {
    windowDays: number;
    sort: SourceSortKey;
    order: SortOrder;
    limit: number;
    offset: number;
  },
): Promise<SourcePage> {
  const windowCutoff = `date('now', '-${Math.max(1, Math.floor(opts.windowDays))} days')`;
  const limit = Math.max(1, Math.min(opts.limit, 200));
  const offset = Math.max(0, opts.offset);
  const column = SORT_COLUMN[opts.sort];
  const order = opts.order === 'asc' ? 'ASC' : 'DESC';
  // Stable secondary sort so pagination doesn't reshuffle ties.
  const orderClause = `${column} ${order} NULLS LAST, d.id ASC`;

  const totalRow = (await trail.execute(
    `SELECT COUNT(DISTINCT d.id) AS total
     FROM ingest_jobs j
     JOIN documents d ON d.id = j.document_id
     WHERE j.tenant_id = ?
       AND j.knowledge_base_id = ?
       AND j.status = 'done'
       AND j.started_at >= ${windowCutoff}`,
    [tenantId, kbId],
  )).rows[0] as { total: number };

  const rows = (await trail.execute(
    `SELECT
       d.id AS document_id,
       d.filename,
       d.title,
       COALESCE(SUM(j.cost_cents), 0) AS cents,
       COUNT(*) AS job_count,
       MAX(j.completed_at) AS last_ingested_at
     FROM ingest_jobs j
     JOIN documents d ON d.id = j.document_id
     WHERE j.tenant_id = ?
       AND j.knowledge_base_id = ?
       AND j.status = 'done'
       AND j.started_at >= ${windowCutoff}
     GROUP BY d.id
     ORDER BY ${orderClause}
     LIMIT ? OFFSET ?`,
    [tenantId, kbId, limit, offset],
  )).rows as Array<{
    document_id: string;
    filename: string;
    title: string | null;
    cents: number;
    job_count: number;
    last_ingested_at: string | null;
  }>;

  return {
    sources: rows.map((r) => ({
      documentId: r.document_id,
      filename: r.filename,
      title: r.title,
      cents: r.cents,
      jobCount: r.job_count,
      lastIngestedAt: r.last_ingested_at,
    })),
    total: totalRow.total,
    limit,
    offset,
    sort: opts.sort,
    order: opts.order,
  };
}

// ── CSV export ──────────────────────────────────────────────────────────

export interface CostCsvRow {
  job_id: string;
  started_at: string;
  completed_at: string | null;
  source_filename: string;
  backend: string | null;
  model_first: string | null;  // extracted from model_trail[0]
  cost_cents: number;
  status: string;
}

export async function getCostCsvRows(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
  windowDays: number,
): Promise<CostCsvRow[]> {
  const windowCutoff = `date('now', '-${Math.max(1, Math.floor(windowDays))} days')`;
  const rows = (await trail.execute(
    `SELECT
       j.id AS job_id,
       j.started_at,
       j.completed_at,
       d.filename AS source_filename,
       j.backend,
       j.model_trail,
       j.cost_cents,
       j.status
     FROM ingest_jobs j
     JOIN documents d ON d.id = j.document_id
     WHERE j.tenant_id = ?
       AND j.knowledge_base_id = ?
       AND j.started_at >= ${windowCutoff}
     ORDER BY j.started_at DESC`,
    [tenantId, kbId],
  )).rows as Array<{
    job_id: string;
    started_at: string;
    completed_at: string | null;
    source_filename: string;
    backend: string | null;
    model_trail: string | null;
    cost_cents: number;
    status: string;
  }>;

  return rows.map((r) => ({
    job_id: r.job_id,
    started_at: r.started_at,
    completed_at: r.completed_at,
    source_filename: r.source_filename,
    backend: r.backend,
    model_first: extractFirstModel(r.model_trail),
    cost_cents: r.cost_cents,
    status: r.status,
  }));
}

function extractFirstModel(trailJson: string | null): string | null {
  if (!trailJson) return null;
  try {
    const arr = JSON.parse(trailJson) as Array<{ model?: string }>;
    return arr[0]?.model ?? null;
  } catch {
    return null;
  }
}

export function renderCostCsv(rows: CostCsvRow[]): string {
  const header = ['job_id', 'started_at', 'completed_at', 'source_filename', 'backend', 'model_first', 'cost_cents', 'status'].join(',');
  const body = rows.map((r) => [
    csvEscape(r.job_id),
    csvEscape(r.started_at),
    csvEscape(r.completed_at ?? ''),
    csvEscape(r.source_filename),
    csvEscape(r.backend ?? ''),
    csvEscape(r.model_first ?? ''),
    String(r.cost_cents),
    csvEscape(r.status),
  ].join(',')).join('\n');
  return header + '\n' + body + '\n';
}

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

// ── Quality comparison ──────────────────────────────────────────────────

export interface QualityRun {
  jobId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  backend: string | null;
  primaryModel: string | null;
  finalModel: string | null;
  costCents: number;
  modelTrailLen: number;
  metrics: {
    neuronsCreated: number;
    conceptsCreated: number;
    entitiesCreated: number;
    wikiBacklinks: number;
    typedEdges: number;
    openBrokenLinks: number;
  };
}

export async function getQualityRuns(
  trail: TrailDatabase,
  tenantId: string,
  documentId: string,
): Promise<{ source: { id: string; filename: string; title: string | null }; runs: QualityRun[] } | null> {
  const source = (await trail.execute(
    `SELECT id, filename, title FROM documents WHERE id = ? AND tenant_id = ?`,
    [documentId, tenantId],
  )).rows[0] as { id: string; filename: string; title: string | null } | undefined;
  if (!source) return null;

  const jobs = (await trail.execute(
    `SELECT id, status, started_at, completed_at, backend, model_trail, cost_cents
       FROM ingest_jobs
      WHERE tenant_id = ?
        AND document_id = ?
      ORDER BY started_at DESC`,
    [tenantId, documentId],
  )).rows as Array<{
    id: string;
    status: string;
    started_at: string;
    completed_at: string | null;
    backend: string | null;
    model_trail: string | null;
    cost_cents: number;
  }>;

  const runs: QualityRun[] = [];
  for (const j of jobs) {
    const trailArr = j.model_trail ? (safeJson<Array<{ model: string }>>(j.model_trail) ?? []) : [];
    const [producedCountRow, backlinkRow, typedEdgeRow, brokenRow, conceptRow, entityRow] = await Promise.all([
      trail.execute(
        `SELECT COUNT(*) AS n FROM documents WHERE ingest_job_id = ? AND kind = 'wiki' AND archived = 0`,
        [j.id],
      ),
      trail.execute(
        `SELECT COUNT(*) AS n FROM wiki_backlinks wb
           JOIN documents d ON d.id = wb.from_document_id
          WHERE d.ingest_job_id = ?`,
        [j.id],
      ),
      trail.execute(
        `SELECT COUNT(*) AS n FROM wiki_backlinks wb
           JOIN documents d ON d.id = wb.from_document_id
          WHERE d.ingest_job_id = ? AND wb.edge_type != 'cites'`,
        [j.id],
      ),
      trail.execute(
        `SELECT COUNT(*) AS n FROM broken_links bl
           JOIN documents d ON d.id = bl.from_document_id
          WHERE d.ingest_job_id = ? AND bl.status = 'open'`,
        [j.id],
      ),
      trail.execute(
        `SELECT COUNT(*) AS n FROM documents
          WHERE ingest_job_id = ? AND path LIKE '/neurons/concepts/%' AND archived = 0`,
        [j.id],
      ),
      trail.execute(
        `SELECT COUNT(*) AS n FROM documents
          WHERE ingest_job_id = ? AND path LIKE '/neurons/entities/%' AND archived = 0`,
        [j.id],
      ),
    ]);

    const durationMs = j.completed_at && j.started_at
      ? new Date(j.completed_at).getTime() - new Date(j.started_at).getTime()
      : null;

    runs.push({
      jobId: j.id,
      status: j.status,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      durationMs,
      backend: j.backend,
      primaryModel: trailArr[0]?.model ?? null,
      finalModel: trailArr[trailArr.length - 1]?.model ?? null,
      costCents: j.cost_cents,
      modelTrailLen: trailArr.length,
      metrics: {
        neuronsCreated: (producedCountRow.rows[0] as { n: number }).n,
        conceptsCreated: (conceptRow.rows[0] as { n: number }).n,
        entitiesCreated: (entityRow.rows[0] as { n: number }).n,
        wikiBacklinks: (backlinkRow.rows[0] as { n: number }).n,
        typedEdges: (typedEdgeRow.rows[0] as { n: number }).n,
        openBrokenLinks: (brokenRow.rows[0] as { n: number }).n,
      },
    });
  }

  return { source, runs };
}

function safeJson<T>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ── Subscribe for cache-bust ────────────────────────────────────────────

broadcaster.subscribe((event) => {
  if (event.type === 'candidate_approved') {
    invalidateCostCache(event.tenantId, event.kbId);
  }
});
