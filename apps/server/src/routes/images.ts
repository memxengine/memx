import { Hono } from 'hono';
import { documents, documentImages, visionQualityRatings } from '@trail/db';
import { eq, and, sql } from 'drizzle-orm';
import { basename } from 'node:path';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import { storage, imagePath } from '../lib/storage.js';
import { defaultAudienceForAuth, isVisibleToAudience } from '../services/audience.js';
import type { AppBindings } from '../app.js';

export const imageRoutes = new Hono<AppBindings>();

imageRoutes.use('*', requireAuth);

imageRoutes.get('/documents/:docId/images/:filename', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const docId = c.req.param('docId');
  const filename = basename(c.req.param('filename'));

  if (!/^[\w.-]+$/.test(filename) || filename.includes('..')) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const doc = await trail.db
    .select({
      id: documents.id,
      knowledgeBaseId: documents.knowledgeBaseId,
      path: documents.path,
      tags: documents.tags,
    })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();
  if (!doc) return c.json({ error: 'Not found' }, 404);

  // F161 — audience-aware visibility check. Bearer-keys default to
  // `tool` audience; heuristic + internal-tagged Neuron's images
  // become 404 instead of 200, preventing URL-guess bypass of the
  // F160 audience-filter on /search and /retrieve.
  const audience = defaultAudienceForAuth(c.get('authType'));
  if (!isVisibleToAudience(audience, doc.path, doc.tags)) {
    return c.json({ error: 'Not found' }, 404);
  }

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

/**
 * F164 Phase 5 — vision quality rating (👍 / 👎).
 *
 * POST /documents/:docId/images/:filename/rating
 *   body: { rating: 'up' | 'down' | null }
 *
 * Upsert on (user_id, image_id). null = delete the user's existing
 * vote (curator un-rates after second look).
 *
 * Tenant-scoped: image must belong to a doc in the calling tenant.
 * Cross-tenant probe returns 404 (same shape as missing).
 *
 * v1 = collect-only. v2 will use 👎-rated images as input for prompt-
 * tuning loops; nothing acts on the data automatically yet.
 */
imageRoutes.post('/documents/:docId/images/:filename/rating', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const docId = c.req.param('docId');
  const filename = basename(c.req.param('filename'));

  if (!/^[\w.-]+$/.test(filename) || filename.includes('..')) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const body = (await c.req.json().catch(() => null)) as { rating?: unknown } | null;
  const rating = body?.rating;
  if (rating !== 'up' && rating !== 'down' && rating !== null) {
    return c.json({ error: 'rating must be "up", "down", or null' }, 400);
  }

  // Lookup image scoped to tenant via parent doc. Filename comparison
  // is leading-slash-tolerant: F161 backfill stamped some rows with
  // "/page-1-img-1.png" while uploads write "page-1-img-1.png" — match
  // the route param against either form.
  const slashed = `/${filename}`;
  const row = await trail.db
    .select({
      id: documentImages.id,
      visionModel: documentImages.visionModel,
    })
    .from(documentImages)
    .innerJoin(documents, eq(documents.id, documentImages.documentId))
    .where(
      and(
        eq(documentImages.documentId, docId),
        sql`(${documentImages.filename} = ${filename} OR ${documentImages.filename} = ${slashed})`,
        eq(documents.tenantId, tenant.id),
      ),
    )
    .get();

  if (!row) return c.json({ error: 'Not found' }, 404);

  if (rating === null) {
    await trail.db
      .delete(visionQualityRatings)
      .where(
        and(
          eq(visionQualityRatings.imageId, row.id),
          eq(visionQualityRatings.userId, user.id),
        ),
      )
      .run();
    return c.json({ ok: true, rating: null });
  }

  // UPSERT — flip an existing vote or create a fresh one. SQLite's
  // ON CONFLICT(...) is keyed by the unique index on (user_id, image_id).
  const id = `vqr_${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  await trail.execute(
    `
    INSERT INTO vision_quality_ratings (id, image_id, user_id, tenant_id, rating, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, image_id) DO UPDATE SET
      rating = excluded.rating,
      model = excluded.model,
      updated_at = excluded.updated_at
    `,
    [id, row.id, user.id, tenant.id, rating, row.visionModel ?? null, now, now],
  );

  return c.json({ ok: true, rating });
});

/**
 * GET /documents/:docId/images/:filename/rating — fetch the calling
 * user's existing rating (if any) so the modal can pre-fill the
 * up/down state when the curator reopens an old completion view.
 */
imageRoutes.get('/documents/:docId/images/:filename/rating', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const docId = c.req.param('docId');
  const filename = basename(c.req.param('filename'));

  if (!/^[\w.-]+$/.test(filename) || filename.includes('..')) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const slashed = `/${filename}`;
  const row = await trail.db
    .select({
      rating: visionQualityRatings.rating,
    })
    .from(visionQualityRatings)
    .innerJoin(documentImages, eq(documentImages.id, visionQualityRatings.imageId))
    .innerJoin(documents, eq(documents.id, documentImages.documentId))
    .where(
      and(
        eq(documentImages.documentId, docId),
        sql`(${documentImages.filename} = ${filename} OR ${documentImages.filename} = ${slashed})`,
        eq(documents.tenantId, tenant.id),
        eq(visionQualityRatings.userId, user.id),
      ),
    )
    .get();

  return c.json({ rating: row?.rating ?? null });
});
