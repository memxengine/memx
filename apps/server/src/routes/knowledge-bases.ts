import { Hono } from 'hono';
import { knowledgeBases, type TrailDatabase } from '@trail/db';
import { CreateKBSchema, UpdateKBSchema } from '@trail/shared';
import { eq, and } from 'drizzle-orm';
import { requireAuth, getUser, getTenant, getTrail } from '../middleware/auth.js';
import { uniqueSlug, createCandidate } from '@trail/core';

export const kbRoutes = new Hono();

kbRoutes.use('/knowledge-bases/*', requireAuth);
kbRoutes.use('/knowledge-bases', requireAuth);

const LIST_SQL = `
  SELECT kb.id, kb.tenant_id AS tenantId, kb.created_by AS createdBy,
         kb.name, kb.slug, kb.description, kb.language,
         kb.created_at AS createdAt, kb.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM documents d
            WHERE d.knowledge_base_id = kb.id
              AND d.kind = 'source'
              AND d.archived = 0) AS sourceCount,
         (SELECT COUNT(*) FROM documents d
            WHERE d.knowledge_base_id = kb.id
              AND d.kind = 'wiki'
              AND d.archived = 0) AS wikiPageCount
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
  const kbId = c.req.param('id');

  const kb = await trail.db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .get();

  if (!kb) return c.json({ error: 'Not found' }, 404);
  return c.json(kb);
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

  // Seed wiki/overview.md and wiki/log.md so the wiki isn't empty from the start.
  // Flows through the Curation Queue so the invariant "every wiki write goes
  // through approveCandidate" holds even for KB bootstrap. Auto-approves because
  // actor.kind='system' and kind='ingest-summary' (see shouldAutoApprove).
  const overviewContent = `# ${body.name}\n\nThis is the overview page for your wiki. It will be updated automatically as sources are added and the LLM compiles knowledge.\n`;
  const logContent = `# Log\n\nChronological record of wiki activity.\n\n---\n`;

  for (const page of [
    { filename: 'overview.md', title: body.name, content: overviewContent },
    { filename: 'log.md', title: 'Log', content: logContent },
  ]) {
    await createCandidate(
      trail,
      tenant.id,
      {
        knowledgeBaseId: id,
        kind: 'ingest-summary',
        title: page.title,
        content: page.content,
        metadata: JSON.stringify({ op: 'create', filename: page.filename, path: '/wiki/' }),
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
  return c.json(kb, 201);
});

kbRoutes.patch('/knowledge-bases/:id', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = c.req.param('id');
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
  const kbId = c.req.param('id');

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
