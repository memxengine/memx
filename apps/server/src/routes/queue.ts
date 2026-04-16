import { Hono, type Context } from 'hono';
import {
  CreateQueueCandidateSchema,
  ApproveCandidateSchema,
  RejectCandidateSchema,
  ListQueueQuerySchema,
} from '@trail/shared';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import {
  createCandidate,
  approveCandidate,
  rejectCandidate,
  listCandidates,
  getCandidate,
  type Actor,
} from '@trail/core';
import { INGEST_USER_ID } from '../bootstrap/ingest-user.js';
import { broadcaster } from '../services/broadcast.js';

export const queueRoutes = new Hono();

queueRoutes.use('*', requireAuth);

/**
 * Build the Actor for a candidate write. A curator clicking "submit" in the
 * admin is `kind: 'user'` — that pins `createdBy`, which the F19 policy
 * reads as "human-originated, never auto-approve". The pre-seeded service
 * user (bearer-authenticated ingest calls, e.g. buddy's F39 POSTs) is
 * machine-originated: `kind: 'system'` leaves createdBy null so axes 1 and 2
 * (trusted pipeline, confidence threshold) can evaluate the candidate on its
 * own merits.
 */
function userActor(c: Context): Actor {
  const user = getUser(c);
  if (user.id === INGEST_USER_ID) {
    return { id: user.id, kind: 'system' };
  }
  return { id: user.id, kind: 'user' };
}

queueRoutes.post('/queue/candidates', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateQueueCandidateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const tenant = getTenant(c);
  try {
    const result = await createCandidate(getTrail(c), tenant.id, parsed.data, userActor(c));
    broadcaster.emit({
      type: 'candidate_created',
      tenantId: tenant.id,
      kbId: result.candidate.knowledgeBaseId,
      candidateId: result.candidate.id,
      kind: result.candidate.kind,
      title: result.candidate.title,
      status: result.approval ? 'approved' : 'pending',
      autoApproved: !!result.approval,
      confidence: result.candidate.confidence,
      createdBy: result.candidate.createdBy,
    });
    if (result.approval) {
      broadcaster.emit({
        type: 'candidate_approved',
        tenantId: tenant.id,
        kbId: result.candidate.knowledgeBaseId,
        candidateId: result.candidate.id,
        documentId: result.approval.documentId,
        autoApproved: true,
      });
    }
    return c.json(result, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Knowledge base not found')) return c.json({ error: msg }, 404);
    return c.json({ error: msg }, 500);
  }
});

queueRoutes.get('/queue', async (c) => {
  const query = ListQueueQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!query.success) return c.json({ error: query.error.flatten() }, 400);

  const tenant = getTenant(c);
  const items = await listCandidates(getTrail(c), tenant.id, query.data);
  return c.json({ items, count: items.length });
});

queueRoutes.get('/queue/:id', async (c) => {
  const tenant = getTenant(c);
  const candidate = await getCandidate(getTrail(c), tenant.id, c.req.param('id'));
  if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
  return c.json(candidate);
});

queueRoutes.post('/queue/:id/approve', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = ApproveCandidateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const tenant = getTenant(c);
  try {
    const result = await approveCandidate(
      getTrail(c),
      tenant.id,
      c.req.param('id'),
      userActor(c),
      parsed.data,
    );
    const candidate = await getCandidate(getTrail(c), tenant.id, c.req.param('id'));
    broadcaster.emit({
      type: 'candidate_approved',
      tenantId: tenant.id,
      kbId: candidate?.knowledgeBaseId ?? '',
      candidateId: result.candidateId,
      documentId: result.documentId,
      autoApproved: result.autoApproved,
    });
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Candidate not found')) return c.json({ error: msg }, 404);
    if (msg.startsWith('Candidate is not pending')) return c.json({ error: msg }, 409);
    return c.json({ error: msg }, 500);
  }
});

queueRoutes.post('/queue/:id/reject', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = RejectCandidateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const tenant = getTenant(c);
  try {
    const result = await rejectCandidate(
      getTrail(c),
      tenant.id,
      c.req.param('id'),
      userActor(c),
      parsed.data,
    );
    const candidate = await getCandidate(getTrail(c), tenant.id, c.req.param('id'));
    broadcaster.emit({
      type: 'candidate_rejected',
      tenantId: tenant.id,
      kbId: candidate?.knowledgeBaseId ?? '',
      candidateId: result.candidateId,
      reason: result.reason,
    });
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Candidate not found')) return c.json({ error: msg }, 404);
    if (msg.startsWith('Candidate is not pending')) return c.json({ error: msg }, 409);
    return c.json({ error: msg }, 500);
  }
});
