import { Hono } from 'hono';
import { knowledgeBases } from '@trail/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth, getTenant, getTrail } from '../middleware/auth.js';

export const searchRoutes = new Hono();

searchRoutes.use('*', requireAuth);

searchRoutes.get('/knowledge-bases/:kbId/search', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = c.req.param('kbId');
  const query = c.req.query('q') ?? '';
  const limit = Math.min(Number(c.req.query('limit') ?? 10), 50);

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

  return c.json({ documents, chunks });
});

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
