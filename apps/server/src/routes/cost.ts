/**
 * F151 — Cost & Quality Dashboard HTTP surface.
 *
 *   GET /api/v1/knowledge-bases/:kbId/cost?window=7d|30d|90d|365d
 *     → CostSummary JSON
 *
 *   GET /api/v1/knowledge-bases/:kbId/cost.csv?window=...
 *     → CSV download of per-job rows
 *
 *   GET /api/v1/sources/:sourceId/ingests
 *     → QualityComparison JSON (all ingest-runs against the source)
 *
 * Auth: all three require the standard session/bearer auth and
 * tenant-scope the query via the caller's tenantId.
 */

import { Hono } from 'hono';
import { documents } from '@trail/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth, getTenant, getTrail } from '../middleware/auth.js';
import { resolveKbId } from '@trail/core';
import {
  getCostSummary,
  getCostCsvRows,
  renderCostCsv,
  getQualityRuns,
  getCostSourcesPage,
  type SourceSortKey,
  type SortOrder,
} from '../services/cost-aggregator.js';

export const costRoutes = new Hono();

costRoutes.use('*', requireAuth);

function parseWindow(raw: string | undefined): number {
  if (!raw) return 30;
  const m = raw.match(/^(\d+)d?$/i);
  if (!m) return 30;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, 365);
}

costRoutes.get('/knowledge-bases/:kbId/cost', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);
  const window = parseWindow(c.req.query('window'));
  const includeShadow = c.req.query('shadow') === '1';
  const summary = await getCostSummary(trail, tenant.id, kbId, window, includeShadow);
  return c.json(summary);
});

const SORT_KEYS = new Set(['cost', 'jobs', 'filename', 'title', 'recent']);

/**
 * Paginated + sortable source list. Separate from the summary so
 * the top-line view stays snappy; the fuller "alle kilder"-tabel
 * only hits this when the curator actually scrolls/sorts.
 */
costRoutes.get('/knowledge-bases/:kbId/cost/sources', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

  const windowDays = parseWindow(c.req.query('window'));
  const rawSort = (c.req.query('sort') ?? 'cost').toLowerCase();
  const sort: SourceSortKey = (SORT_KEYS.has(rawSort) ? rawSort : 'cost') as SourceSortKey;
  const order: SortOrder = c.req.query('order') === 'asc' ? 'asc' : 'desc';
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '25', 10) || 25, 200));
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

  const page = await getCostSourcesPage(trail, tenant.id, kbId, {
    windowDays,
    sort,
    order,
    limit,
    offset,
  });
  return c.json(page);
});

costRoutes.get('/knowledge-bases/:kbId/cost.csv', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);
  const window = parseWindow(c.req.query('window'));
  const rows = await getCostCsvRows(trail, tenant.id, kbId, window);
  const csv = renderCostCsv(rows);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="trail-cost-${window}d.csv"`,
    },
  });
});

costRoutes.get('/sources/:sourceId/ingests', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const sourceId = c.req.param('sourceId');

  // Tenant-scope: fail if the requested source doesn't belong to the
  // authenticated tenant. Don't leak cross-tenant existence.
  const source = await trail.db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, sourceId), eq(documents.tenantId, tenant.id)))
    .get();
  if (!source) return c.json({ error: 'Source not found' }, 404);

  const result = await getQualityRuns(trail, tenant.id, sourceId);
  if (!result) return c.json({ error: 'Source not found' }, 404);
  return c.json(result);
});
