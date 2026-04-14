import { Hono } from 'hono';
import { db, documents } from '@memx/db';
import { eq, and } from 'drizzle-orm';
import { basename } from 'node:path';
import { requireAuth, getTenant } from '../middleware/auth.js';
import { storage, imagePath } from '../lib/storage.js';

export const imageRoutes = new Hono();

imageRoutes.use('*', requireAuth);

imageRoutes.get('/documents/:docId/images/:filename', async (c) => {
  const tenant = getTenant(c);
  const docId = c.req.param('docId');
  const filename = basename(c.req.param('filename'));

  if (!/^[\w.-]+$/.test(filename) || filename.includes('..')) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const doc = db
    .select({ id: documents.id, knowledgeBaseId: documents.knowledgeBaseId })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();
  if (!doc) return c.json({ error: 'Not found' }, 404);

  const data = await storage.get(imagePath(tenant.id, doc.knowledgeBaseId, docId, filename));
  if (!data) return c.json({ error: 'Image not found' }, 404);

  const ext = filename.split('.').pop()?.toLowerCase();
  const contentType =
    ext === 'png' ? 'image/png' :
    ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
    ext === 'webp' ? 'image/webp' :
    ext === 'gif' ? 'image/gif' :
    'application/octet-stream';

  return new Response(data, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=3600',
    },
  });
});
