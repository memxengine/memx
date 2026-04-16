import { Hono } from 'hono';
import { documents } from '@trail/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import { triggerIngest } from '../services/ingest.js';

export const ingestRoutes = new Hono();

ingestRoutes.use('*', requireAuth);

ingestRoutes.post('/documents/:docId/ingest', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const docId = c.req.param('docId');

  const doc = await trail.db
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();

  if (!doc) return c.json({ error: 'Not found' }, 404);
  if (doc.status === 'processing') return c.json({ error: 'Already processing' }, 409);
  if (doc.kind !== 'source') {
    return c.json({ error: 'Only source documents can be ingested' }, 400);
  }

  triggerIngest({
    trail,
    docId,
    kbId: doc.knowledgeBaseId,
    tenantId: tenant.id,
    userId: user.id,
  });

  return c.json({ ok: true, message: 'Ingest started' }, 202);
});
