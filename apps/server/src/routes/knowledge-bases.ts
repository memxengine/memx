import { Hono } from 'hono';
import { documents, knowledgeBases, wikiBacklinks, type TrailDatabase } from '@trail/db';
import { CreateKBSchema, UpdateKBSchema } from '@trail/shared';
import { eq, and } from 'drizzle-orm';
import { requireAuth, getUser, getTenant, getTrail } from '../middleware/auth.js';
import { uniqueSlug, createCandidate, resolveKbId } from '@trail/core';
import { broadcaster } from '../services/broadcast.js';
import { listKbTags } from '../services/tag-aggregate.js';
import { buildSeedGlossary } from '../services/glossary-seed.js';
import { VALID_EDGE_TYPES, type EdgeType } from '../services/backlink-extractor.js';
import { getIngestStatus } from '../services/ingest.js';

export const kbRoutes = new Hono();

kbRoutes.use('/knowledge-bases/*', requireAuth);
kbRoutes.use('/knowledge-bases', requireAuth);

const LIST_SQL = `
  SELECT kb.id, kb.tenant_id AS tenantId, kb.created_by AS createdBy,
         kb.name, kb.slug, kb.description, kb.language,
         kb.lint_policy AS lintPolicy,
         kb.created_at AS createdAt, kb.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM documents d
            WHERE d.knowledge_base_id = kb.id
              AND d.kind = 'source'
              AND d.archived = 0) AS sourceCount,
         (SELECT COUNT(*) FROM documents d
            WHERE d.knowledge_base_id = kb.id
              AND d.kind = 'wiki'
              AND d.archived = 0) AS wikiPageCount,
         (SELECT COUNT(*) FROM queue_candidates q
            WHERE q.knowledge_base_id = kb.id
              AND q.status = 'pending') AS pendingCandidateCount
    FROM knowledge_bases kb
   WHERE kb.tenant_id = ?
   ORDER BY kb.updated_at DESC
`;

kbRoutes.get('/knowledge-bases', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);

  const result = await trail.execute(LIST_SQL, [tenant.id]);
  return c.json(result.rows);
});

kbRoutes.get('/knowledge-bases/:id', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('id'));
  if (!kbId) return c.json({ error: 'Not found' }, 404);

  const kb = await trail.db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .get();

  if (!kb) return c.json({ error: 'Not found' }, 404);
  return c.json(kb);
});

/**
 * F92 — per-KB tag aggregate. Returns every distinct tag present on
 * non-archived Neurons + its Neuron count, descending by count. Used
 * by the Queue + Neurons listing filter bars so the full vocabulary
 * can render as chips before the user has picked anything.
 *
 * Result is cached per-KB (60s TTL) and busted on `candidate_approved`
 * events — see services/tag-aggregate.ts for the cache implementation.
 * SQL is a single SELECT + split-and-count in app code (SQLite's
 * string-tokenising is awkward enough that a loop is cleaner than a
 * trigger-maintained tag table at the current volume; revisit if a KB
 * exceeds ~10k Neurons).
 */
kbRoutes.get('/knowledge-bases/:id/tags', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('id'));
  if (!kbId) return c.json({ error: 'Not found' }, 404);

  const tags = await listKbTags(trail, tenant.id, kbId);
  return c.json(tags);
});

/**
 * F21 — ingest backpressure status. Sources panel polls this to show
 * curators their position in the queue ("3 før dig") and to render
 * friendly capacity messages when the global cap is hit. Future F154
 * Control Plane will aggregate the same shape across tenants.
 */
kbRoutes.get('/knowledge-bases/:id/ingest-status', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('id'));
  if (!kbId) return c.json({ error: 'Not found' }, 404);

  const status = await getIngestStatus(trail, tenant.id, kbId);
  return c.json(status);
});

/**
 * F137 — typed Neuron relationships.
 * GET /knowledge-bases/:id/relationships?type=contradicts
 *
 * Returns every wiki_backlinks row whose edge_type matches the filter,
 * joined against documents so the response carries titles + filenames
 * the UI can render without a round-trip. Filter is optional — omitting
 * `?type=` returns every typed edge, which powers the graph side legend
 * and the "all my relationships"-view.
 *
 * Invalid edge-type strings return [] (fail-soft — a typo in the query
 * string shouldn't 400 the whole panel). Unknown `?type=` values are
 * treated as "no match" for the same reason.
 */
kbRoutes.get('/knowledge-bases/:id/relationships', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('id'));
  if (!kbId) return c.json({ error: 'Not found' }, 404);

  const typeParam = c.req.query('type');
  if (typeParam && !(VALID_EDGE_TYPES as readonly string[]).includes(typeParam)) {
    return c.json({ edges: [] });
  }

  const edges = await listRelationships(trail, tenant.id, kbId, typeParam as EdgeType | undefined);
  return c.json({ edges });
});

kbRoutes.post('/knowledge-bases', async (c) => {
  const trail = getTrail(c);
  const user = getUser(c);
  const tenant = getTenant(c);
  const body = CreateKBSchema.parse(await c.req.json());

  const id = crypto.randomUUID();
  const slug = await nextAvailableKbSlug(trail, tenant.id, body.name);

  await trail.db
    .insert(knowledgeBases)
    .values({
      id,
      tenantId: tenant.id,
      createdBy: user.id,
      name: body.name,
      slug,
      description: body.description ?? null,
      language: body.language ?? 'da',
    })
    .run();

  // Seed wiki/overview.md, wiki/log.md and wiki/glossary.md (F102) so the
  // wiki isn't empty from the start. Flows through the Curation Queue so
  // the invariant "every wiki write goes through approveCandidate" holds
  // even for KB bootstrap. Auto-approves because actor.kind='system' and
  // kind='ingest-summary' (see shouldAutoApprove).
  const lang = body.language ?? 'da';
  const overviewContent = `# ${body.name}\n\nThis is the overview page for your wiki. It will be updated automatically as sources are added and the LLM compiles knowledge.\n`;
  const logContent = `# Log\n\nChronological record of wiki activity.\n\n---\n`;
  const glossaryContent = buildSeedGlossary(lang);
  const glossaryTitle = lang === 'da' ? 'Ordliste' : 'Glossary';

  for (const page of [
    { filename: 'overview.md', title: body.name, content: overviewContent },
    { filename: 'log.md', title: 'Log', content: logContent },
    { filename: 'glossary.md', title: glossaryTitle, content: glossaryContent },
  ]) {
    await createCandidate(
      trail,
      tenant.id,
      {
        knowledgeBaseId: id,
        kind: 'ingest-summary',
        title: page.title,
        content: page.content,
        metadata: JSON.stringify({ op: 'create', filename: page.filename, path: '/neurons/' }),
        confidence: 1,
      },
      { id: user.id, kind: 'system' },
    );
  }

  const kb = await trail.db
    .select()
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, id))
    .get();
  if (kb) {
    broadcaster.emit({
      type: 'kb_created',
      tenantId: tenant.id,
      kbId: kb.id,
      slug: kb.slug,
      name: kb.name,
    });
  }
  return c.json(kb, 201);
});

kbRoutes.patch('/knowledge-bases/:id', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('id'));
  if (!kbId) return c.json({ error: 'Not found' }, 404);
  const body = UpdateKBSchema.parse(await c.req.json());

  const existing = await trail.db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .get();

  if (!existing) return c.json({ error: 'Not found' }, 404);

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.name !== undefined) {
    updates.name = body.name;
    updates.slug = await nextAvailableKbSlug(trail, tenant.id, body.name, kbId);
  }
  if (body.description !== undefined) updates.description = body.description;
  if (body.language !== undefined) updates.language = body.language;
  if (body.lintPolicy !== undefined) updates.lintPolicy = body.lintPolicy;

  await trail.db.update(knowledgeBases).set(updates).where(eq(knowledgeBases.id, kbId)).run();

  const kb = await trail.db
    .select()
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, kbId))
    .get();
  return c.json(kb);
});

kbRoutes.delete('/knowledge-bases/:id', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('id'));
  if (!kbId) return c.json({ error: 'Not found' }, 404);

  const existing = await trail.db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .get();

  if (!existing) return c.json({ error: 'Not found' }, 404);

  await trail.db.delete(knowledgeBases).where(eq(knowledgeBases.id, kbId)).run();
  return c.body(null, 204);
});

async function nextAvailableKbSlug(
  trail: TrailDatabase,
  tenantId: string,
  name: string,
  ignoreKbId?: string,
): Promise<string> {
  const base = uniqueSlug(name);
  let candidate = base;
  let suffix = 1;
  while (true) {
    const clash = await trail.db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.tenantId, tenantId), eq(knowledgeBases.slug, candidate)))
      .get();
    if (!clash || clash.id === ignoreKbId) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

/**
 * F137 — load typed edges for a KB, with document titles/filenames on
 * both ends so the API response is renderable without a follow-up
 * round-trip. Scoped to non-archived documents so a stale link to a
 * retired Neuron doesn't surface in the listing. `typeFilter` narrows
 * to a single edge_type; undefined returns every typed edge.
 */
async function listRelationships(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
  typeFilter: EdgeType | undefined,
): Promise<
  Array<{
    from: { id: string; title: string | null; filename: string };
    to: { id: string; title: string | null; filename: string };
    edgeType: EdgeType;
    linkText: string;
  }>
> {
  const rows = await trail.db
    .select({
      fromId: wikiBacklinks.fromDocumentId,
      toId: wikiBacklinks.toDocumentId,
      edgeType: wikiBacklinks.edgeType,
      linkText: wikiBacklinks.linkText,
    })
    .from(wikiBacklinks)
    .where(
      and(
        eq(wikiBacklinks.tenantId, tenantId),
        eq(wikiBacklinks.knowledgeBaseId, kbId),
        ...(typeFilter ? [eq(wikiBacklinks.edgeType, typeFilter)] : []),
      ),
    )
    .all();

  if (rows.length === 0) return [];

  // One pass: collect every doc id we need to resolve titles for, then
  // one SELECT to fetch the document projections. Avoids N+1 lookups.
  const docIds = new Set<string>();
  for (const r of rows) {
    docIds.add(r.fromId);
    docIds.add(r.toId);
  }
  const docs = await trail.db
    .select({
      id: documents.id,
      title: documents.title,
      filename: documents.filename,
      archived: documents.archived,
    })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.knowledgeBaseId, kbId)))
    .all();

  const byId = new Map<string, { title: string | null; filename: string; archived: boolean }>();
  for (const d of docs) {
    byId.set(d.id, { title: d.title, filename: d.filename, archived: d.archived });
  }

  const out: Awaited<ReturnType<typeof listRelationships>> = [];
  for (const r of rows) {
    const from = byId.get(r.fromId);
    const to = byId.get(r.toId);
    // Skip edges touching archived docs — a retired Neuron's relations
    // shouldn't surface in the "live KB" listing.
    if (!from || !to || from.archived || to.archived) continue;
    out.push({
      from: { id: r.fromId, title: from.title, filename: from.filename },
      to: { id: r.toId, title: to.title, filename: to.filename },
      edgeType: r.edgeType as EdgeType,
      linkText: r.linkText,
    });
  }
  return out;
}
