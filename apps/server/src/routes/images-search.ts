/**
 * F161 — image-search endpoint.
 *
 * `GET /api/v1/knowledge-bases/:kbId/images?q=&limit=&audience=`
 *
 * FTS5 over `document_images.vision_description` via the contentless
 * `document_images_fts` virtual table. Returns image rows with
 * absolute URLs + parent-doc audience-filter applied.
 *
 * Use cases:
 *   - "Find images about søvn" → curator browse / Eir-chat-tool
 *   - Image-galleri view (when admin UI gets it)
 *   - Site-LLM orchestrator that wants to surface specific images
 *     beyond what /retrieve already returns
 *
 * Audience-filter: Bearer-keys default to `tool` so heuristic +
 * internal-tagged Neuron images never leak. Done by joining
 * documents and applying isVisibleToAudience.
 */

import { Hono } from 'hono';
import { documents, documentImages, knowledgeBases } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { requireAuth, getTenant, getTrail } from '../middleware/auth.js';
import { resolveKbId } from '@trail/core';
import {
  parseAudienceParam,
  defaultAudienceForAuth,
  isVisibleToAudience,
  type Audience,
} from '../services/audience.js';
import type { AppBindings } from '../app.js';

export const imagesSearchRoutes = new Hono<AppBindings>();
imagesSearchRoutes.use('*', requireAuth);

const HARD_LIMIT_CAP = 50;

imagesSearchRoutes.get('/knowledge-bases/:kbId/images', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Not found' }, 404);

  const query = (c.req.query('q') ?? '').trim();
  const limit = Math.min(Number(c.req.query('limit') ?? 20), HARD_LIMIT_CAP);
  const audience: Audience =
    parseAudienceParam(c.req.query('audience')) ??
    defaultAudienceForAuth(c.get('authType'));

  // Empty query: return latest N images for this KB so admin browse
  // works without a search term. We sort by created_at DESC (newest
  // first) — same convention as the rest of the admin browse views.
  const ftsQuery = query ? sanitizeFtsQuery(query) : '';

  // Base SQL — we use raw execute because the FTS join is more
  // readable in SQL than in Drizzle's query-builder, and we already
  // need to JOIN documents for the audience-filter columns anyway.
  const sql = ftsQuery
    ? `
      SELECT di.id, di.document_id, di.filename, di.page, di.width, di.height,
             di.vision_description, di.vision_model, di.created_at,
             d.path AS doc_path, d.tags AS doc_tags
        FROM document_images_fts fts
        JOIN document_images di ON di.rowid = fts.rowid
        JOIN documents d ON d.id = di.document_id
       WHERE fts.vision_description MATCH ?
         AND di.tenant_id = ?
         AND di.knowledge_base_id = ?
       ORDER BY rank
       LIMIT ?
    `
    : `
      SELECT di.id, di.document_id, di.filename, di.page, di.width, di.height,
             di.vision_description, di.vision_model, di.created_at,
             d.path AS doc_path, d.tags AS doc_tags
        FROM document_images di
        JOIN documents d ON d.id = di.document_id
       WHERE di.tenant_id = ?
         AND di.knowledge_base_id = ?
       ORDER BY di.created_at DESC
       LIMIT ?
    `;
  const args = ftsQuery
    ? [ftsQuery, tenant.id, kbId, limit * 3]
    : [tenant.id, kbId, limit * 3];
  // Over-fetch by 3x so audience-filter on parent-doc still leaves a
  // useful list when many images come from filtered-out docs.
  const result = await trail.execute(sql, args);

  const baseUrl = new URL(c.req.url).origin;
  const hits = (result.rows as Array<Record<string, unknown>>)
    .filter((row) =>
      isVisibleToAudience(audience, String(row.doc_path), row.doc_tags as string | null),
    )
    .slice(0, limit)
    .map((row) => ({
      id: String(row.id),
      documentId: String(row.document_id),
      filename: String(row.filename),
      url: `${baseUrl}/api/v1/documents/${row.document_id}/images/${String(row.filename).replace(/^\//, '')}`,
      alt: (row.vision_description as string | null) ?? '',
      page: row.page as number | null,
      width: row.width as number,
      height: row.height as number,
      visionModel: (row.vision_model as string | null) ?? null,
      createdAt: String(row.created_at),
    }));

  return c.json({ hits });
});

/**
 * FTS5 sanitiser identical to the one in /search and /retrieve. See
 * those for rationale; pulled into a shared module would be the right
 * cleanup but is out of scope here.
 */
function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return terms.join(' OR ');
}
