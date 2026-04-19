import { Hono } from 'hono';
import { knowledgeBases } from '@trail/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth, getTenant, getTrail } from '../middleware/auth.js';
import { parseTags, canonicaliseTag } from '@trail/shared';

export const searchRoutes = new Hono();

searchRoutes.use('*', requireAuth);

searchRoutes.get('/knowledge-bases/:kbId/search', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = c.req.param('kbId');
  const query = c.req.query('q') ?? '';
  const limit = Math.min(Number(c.req.query('limit') ?? 10), 50);
  // F92 — repeated ?tag= params narrow the hit list to Neurons whose
  // `tags` column contains every tag (AND-semantics). Canonicalise
  // here so `Ops`, `ops`, and `OPS` all collapse to the same filter
  // and match a case-insensitive DB value. An empty/non-canonicalisable
  // tag is dropped silently — same rule as the write path.
  const rawTags = c.req.queries('tag') ?? [];
  const tagFilters = rawTags
    .map((raw) => canonicaliseTag(raw))
    .filter((t): t is string => !!t);

  if (!query.trim()) {
    return c.json({ documents: [], chunks: [] });
  }

  const kb = await trail.db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .get();
  if (!kb) return c.json({ error: 'Not found' }, 404);

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return c.json({ documents: [], chunks: [] });

  const [documents, chunks] = await Promise.all([
    trail.searchDocuments(ftsQuery, kbId, tenant.id, limit),
    trail.searchChunks(ftsQuery, kbId, tenant.id, limit),
  ]);

  // F92 tag facet. searchDocuments returns a narrow projection that
  // doesn't include the tags column, so we re-hydrate tags here for
  // just the doc IDs in the hit list, then filter + decorate.
  if (tagFilters.length > 0 && documents.length > 0) {
    const tagMap = await loadTagsForDocIds(
      trail,
      tenant.id,
      documents.map((d) => d.id),
    );
    const filtered = documents.filter((d) => {
      const docTags = parseTags(tagMap.get(d.id) ?? null).map((t) => t.toLowerCase());
      return tagFilters.every((t) => docTags.includes(t));
    });
    return c.json({
      documents: filtered.map((d) => ({ ...d, tags: tagMap.get(d.id) ?? null })),
      chunks,
    });
  }

  // Even without a tag filter, decorate docs with their tags so the
  // search UI can render per-hit chips. Saves a second round-trip.
  if (documents.length > 0) {
    const tagMap = await loadTagsForDocIds(
      trail,
      tenant.id,
      documents.map((d) => d.id),
    );
    return c.json({
      documents: documents.map((d) => ({ ...d, tags: tagMap.get(d.id) ?? null })),
      chunks,
    });
  }

  return c.json({ documents, chunks });
});

/**
 * One-shot tags lookup for the hit list. Single IN query — the hit
 * list is capped at `limit` (max 50) so the parameter list never
 * exceeds SQLite's 999-param ceiling.
 */
async function loadTagsForDocIds(
  trail: ReturnType<typeof getTrail>,
  tenantId: string,
  ids: string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await trail.execute(
    `SELECT id, tags FROM documents
      WHERE tenant_id = ?
        AND id IN (${placeholders})`,
    [tenantId, ...ids],
  );
  for (const row of rows.rows as Array<{ id: string; tags: string | null }>) {
    map.set(row.id, row.tags);
  }
  return map;
}

// Turn user input into a safe FTS5 MATCH expression.
// FTS5 MATCH treats quotes, dashes, and other punctuation as syntax, so a
// raw user string can explode the parser. We tokenise on whitespace, strip
// non-word chars, and OR the terms together as phrase-prefix searches.
function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return terms.join(' OR ');
}
