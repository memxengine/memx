import { Hono } from 'hono';
import { and, eq, desc, asc } from 'drizzle-orm';
import { documents, wikiEvents } from '@trail/db';
import {
  CreateWorkSchema,
  UpdateWorkStateSchema,
  WorkStatusEnum,
  WorkKindEnum,
  slugify,
} from '@trail/shared';
import { createCandidate, resolveKbId, type CandidateOp } from '@trail/core';
import { requireAuth, getUser, getTenant, getTrail } from '../middleware/auth.js';

/**
 * F138 — Work Layer routes.
 *
 * Work items are stored in `documents` as `kind='work'` rows with the
 * `work_*` columns populated. Wiki-links, backlinks, F99 graph, search
 * and chat treat them as regular documents — the Work panel is just a
 * different lens on the same table.
 *
 * Write invariants:
 *   POST /work/:kbId        → flows through the Curation Queue
 *                             (createCandidate, kind='external-feed',
 *                             op.docKind='work'). Auto-approved via the
 *                             trusted-pipeline policy.
 *   PATCH /work/:docId/state → direct UPDATE. Status / assignee / due
 *                             date are state-fields, not content-fields;
 *                             treating them like `archived` / sortOrder
 *                             (already direct-write) keeps the Kanban
 *                             drag-drop responsive without queue round-
 *                             trips. Content edits (title/body) continue
 *                             to go through submitCuratorEdit on the
 *                             documents/:id/content endpoint.
 */
export const workRoutes = new Hono();

workRoutes.use('*', requireAuth);

workRoutes.get('/knowledge-bases/:kbId/work', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

  const statusParam = c.req.query('status');
  const kindParam = c.req.query('kind');
  const assigneeParam = c.req.query('assignee');
  const archivedParam = c.req.query('archived');

  const conditions = [
    eq(documents.tenantId, tenant.id),
    eq(documents.knowledgeBaseId, kbId),
    eq(documents.kind, 'work'),
  ];
  if (archivedParam !== 'all') {
    conditions.push(eq(documents.archived, archivedParam === 'true'));
  }
  if (statusParam) {
    const parsed = WorkStatusEnum.safeParse(statusParam);
    if (!parsed.success) return c.json({ error: 'Invalid status' }, 400);
    conditions.push(eq(documents.workStatus, parsed.data));
  }
  if (kindParam) {
    const parsed = WorkKindEnum.safeParse(kindParam);
    if (!parsed.success) return c.json({ error: 'Invalid work kind' }, 400);
    conditions.push(eq(documents.workKind, parsed.data));
  }
  if (assigneeParam) {
    conditions.push(eq(documents.workAssignee, assigneeParam));
  }

  const rows = await trail.db
    .select({
      id: documents.id,
      title: documents.title,
      filename: documents.filename,
      path: documents.path,
      tags: documents.tags,
      workStatus: documents.workStatus,
      workKind: documents.workKind,
      workAssignee: documents.workAssignee,
      workDueAt: documents.workDueAt,
      version: documents.version,
      archived: documents.archived,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(and(...conditions))
    .orderBy(asc(documents.workDueAt), desc(documents.updatedAt))
    .all();

  return c.json(rows);
});

workRoutes.post('/knowledge-bases/:kbId/work', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = CreateWorkSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  // Normalise filename + path. Work items live under `/work/` by default
  // so the Kanban query has a stable lookup; curators can still override
  // via `path` in the POST body.
  const rawSlug = slugify(input.title) || 'work-item';
  const filename = rawSlug.endsWith('.md') ? rawSlug : `${rawSlug}.md`;
  const path = input.path.endsWith('/') ? input.path : `${input.path}/`;

  const op: CandidateOp = {
    op: 'create',
    docKind: 'work',
    filename,
    path,
    tags: input.tags ?? null,
    workKind: input.workKind,
    workStatus: input.workStatus,
    workAssignee: input.workAssignee ?? null,
    workDueAt: input.workDueAt ?? null,
  };
  const metadata = JSON.stringify({ ...op, connector: 'curator' });

  // createCandidate applies the shouldAutoApprove policy — kind
  // 'external-feed' with confidence=1 + createdBy=null is trusted. We
  // want the item to land immediately so the panel can show it; the
  // queue audit trail still records the write.
  const { candidate, approval } = await createCandidate(
    trail,
    tenant.id,
    {
      knowledgeBaseId: kbId,
      kind: 'external-feed',
      title: input.title,
      content: input.content,
      metadata,
      confidence: 1,
    },
    { kind: 'user', id: user.id },
  );

  if (!approval?.documentId) {
    // Candidate stayed pending — return it so the client knows the write
    // is awaiting curator review (unusual for F138 but possible if
    // shouldAutoApprove policy rejects).
    return c.json({ candidateId: candidate.id, status: 'pending' }, 202);
  }

  const row = await trail.db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, approval.documentId),
        eq(documents.tenantId, tenant.id),
      ),
    )
    .get();
  return c.json(row, 201);
});

workRoutes.patch('/work/:docId/state', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const docId = c.req.param('docId');

  const body = await c.req.json().catch(() => null);
  const parsed = UpdateWorkStateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const doc = await trail.db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, docId),
        eq(documents.tenantId, tenant.id),
        eq(documents.kind, 'work'),
      ),
    )
    .get();
  if (!doc) return c.json({ error: 'Work item not found' }, 404);

  const patch: Partial<typeof doc> = {};
  if (input.workStatus !== undefined) patch.workStatus = input.workStatus;
  if (input.workAssignee !== undefined) patch.workAssignee = input.workAssignee;
  if (input.workDueAt !== undefined) patch.workDueAt = input.workDueAt;
  if (input.workKind !== undefined) patch.workKind = input.workKind;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'No state fields in body' }, 400);
  }

  const now = new Date().toISOString();
  await trail.db
    .update(documents)
    .set({ ...patch, updatedAt: now })
    .where(eq(documents.id, docId))
    .run();

  // Record the state change as an 'edited' event so the timeline panel
  // shows Kanban moves alongside content edits. The content snapshot is
  // unchanged — this event tracks metadata mutation only; the summary
  // carries the state transition.
  const summaryParts: string[] = [];
  if (patch.workStatus) summaryParts.push(`status: ${doc.workStatus ?? '—'} → ${patch.workStatus}`);
  if (patch.workKind) summaryParts.push(`kind: ${doc.workKind ?? '—'} → ${patch.workKind}`);
  if ('workAssignee' in patch) summaryParts.push(`assignee: ${doc.workAssignee ?? '—'} → ${patch.workAssignee ?? '—'}`);
  if ('workDueAt' in patch) summaryParts.push(`due: ${doc.workDueAt ?? '—'} → ${patch.workDueAt ?? '—'}`);

  await trail.db
    .insert(wikiEvents)
    .values({
      id: `evt_${crypto.randomUUID().slice(0, 12)}`,
      tenantId: tenant.id,
      documentId: docId,
      eventType: 'edited',
      actorId: user.id,
      actorKind: 'user',
      previousVersion: doc.version,
      newVersion: doc.version,
      summary: summaryParts.join('; ') || 'state update',
      prevEventId: null,
      contentSnapshot: doc.content ?? '',
    })
    .run();

  const fresh = await trail.db
    .select()
    .from(documents)
    .where(eq(documents.id, docId))
    .get();
  return c.json(fresh);
});
