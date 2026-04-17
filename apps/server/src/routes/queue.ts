import { Hono, type Context } from 'hono';
import {
  CreateQueueCandidateSchema,
  ResolveCandidateSchema,
  ListQueueQuerySchema,
} from '@trail/shared';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import {
  createCandidate,
  resolveCandidate,
  listCandidates,
  countCandidates,
  getCandidate,
  type Actor,
  type ResolutionResult,
} from '@trail/core';
import { INGEST_USER_ID } from '../bootstrap/ingest-user.js';
import { broadcaster } from '../services/broadcast.js';
import { ensureActionsInLocale } from '../services/translation.js';

export const queueRoutes = new Hono();

queueRoutes.use('*', requireAuth);

/**
 * Build the Actor for a candidate write. A curator clicking a resolution
 * button in the admin is `kind: 'user'` — that pins `createdBy`, which the
 * F19 policy reads as "human-originated, never auto-approve". The pre-seeded
 * service user (bearer-authenticated ingest calls, e.g. buddy's F39 POSTs)
 * is machine-originated: `kind: 'system'` leaves createdBy null so axes 1
 * and 2 (trusted pipeline, confidence threshold) can evaluate the candidate
 * on its own merits.
 */
function userActor(c: Context): Actor {
  const user = getUser(c);
  if (user.id === INGEST_USER_ID) {
    return { id: user.id, kind: 'system' };
  }
  return { id: user.id, kind: 'user' };
}

/**
 * Emit the universal resolved event + the narrow approved event when the
 * effect produced a Neuron. Doc-indexers (reference-extractor, contradiction-
 * lint, backlink-extractor) subscribe to `candidate_approved` and only need
 * to wake up when a new/edited Neuron exists. The pending-count badge + the
 * admin panels subscribe to `candidate_resolved` so they react to every
 * curator decision regardless of effect.
 */
function emitResolution(
  result: ResolutionResult,
  candidate: { tenantId: string; knowledgeBaseId: string },
): void {
  broadcaster.emit({
    type: 'candidate_resolved',
    tenantId: candidate.tenantId,
    kbId: candidate.knowledgeBaseId,
    candidateId: result.candidateId,
    actionId: result.actionId,
    effect: result.effect,
    documentId: result.documentId,
    autoApproved: result.autoApproved,
  });
  if (result.effect === 'approve' && result.documentId) {
    broadcaster.emit({
      type: 'candidate_approved',
      tenantId: candidate.tenantId,
      kbId: candidate.knowledgeBaseId,
      candidateId: result.candidateId,
      documentId: result.documentId,
      autoApproved: result.autoApproved,
    });
  }
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
      emitResolution(result.approval, {
        tenantId: tenant.id,
        knowledgeBaseId: result.candidate.knowledgeBaseId,
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
  // `count` is the TOTAL matching filter — independent of `limit`. Callers
  // that want the length of the paginated page just use items.length.
  const [items, count] = await Promise.all([
    listCandidates(getTrail(c), tenant.id, query.data),
    countCandidates(getTrail(c), tenant.id, query.data),
  ]);
  return c.json({ items, count });
});

queueRoutes.get('/queue/:id', async (c) => {
  const tenant = getTenant(c);
  const candidate = await getCandidate(getTrail(c), tenant.id, c.req.param('id'));
  if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
  return c.json(candidate);
});

/**
 * GET /queue/:id/actions?locale=da — ensure every action has a label +
 * explanation in the requested locale, calling the translation service
 * (LLM) when a locale is missing. Cached back into the stored actions
 * JSON so subsequent reads are instant.
 *
 * Primary consumer: the admin, which calls this after loading a candidate
 * to guarantee the user's preferred language is populated before rendering
 * the action buttons. EN is free — returns immediately from the DB.
 */
queueRoutes.get('/queue/:id/actions', async (c) => {
  const tenant = getTenant(c);
  const url = new URL(c.req.url);
  const rawLocale = url.searchParams.get('locale') ?? 'en';
  // Only 'en' and 'da' are supported transports — see translation service.
  // Any other value falls back to 'en' so a mistyped locale doesn't burn
  // tokens trying to translate to something like '', '*', or 'xx-YY'.
  const locale: 'en' | 'da' = rawLocale === 'da' ? 'da' : 'en';

  const actions = await ensureActionsInLocale(
    getTrail(c),
    tenant.id,
    c.req.param('id'),
    locale,
  );
  if (!actions) return c.json({ error: 'Candidate not found or has no actions' }, 404);
  return c.json({ locale, actions });
});

/**
 * The canonical curator-decision endpoint. Replaces the old approve + reject
 * split. Body: `{ actionId, args?, filename?, path?, editedContent?, reason?,
 * notes? }`. `actionId` must match one of the candidate's actions (or
 * 'approve'/'reject' on legacy candidates).
 */
queueRoutes.post('/queue/:id/resolve', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = ResolveCandidateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const tenant = getTenant(c);
  const existing = await getCandidate(getTrail(c), tenant.id, c.req.param('id'));
  if (!existing) return c.json({ error: 'Candidate not found' }, 404);

  try {
    const result = await resolveCandidate(
      getTrail(c),
      tenant.id,
      c.req.param('id'),
      userActor(c),
      parsed.data,
    );
    emitResolution(result, existing);
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Candidate not found')) return c.json({ error: msg }, 404);
    if (msg.startsWith('Candidate is not pending')) return c.json({ error: msg }, 409);
    if (msg.startsWith('Unknown action')) return c.json({ error: msg }, 400);
    return c.json({ error: msg }, 500);
  }
});

/**
 * Bulk resolve. Takes a list of candidate ids and applies the SAME actionId
 * to each. Per-candidate errors don't abort the batch — we return a summary
 * telling the caller exactly which ones succeeded, which failed, and why.
 *
 * Runs serially — parallel would stampede the write path, and at curator
 * click pace sequential is fine. Each resolution emits its own event pair,
 * same as individual /resolve.
 */
queueRoutes.post('/queue/bulk', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | {
        actionId?: string;
        ids?: unknown;
        reason?: unknown;
        filename?: unknown;
        path?: unknown;
        args?: unknown;
      }
    | null;
  const actionId = typeof body?.actionId === 'string' ? body.actionId : null;
  const ids = Array.isArray(body?.ids)
    ? body!.ids.filter((id): id is string => typeof id === 'string')
    : [];
  const reason = typeof body?.reason === 'string' ? body.reason : undefined;
  const filename = typeof body?.filename === 'string' ? body.filename : undefined;
  const path = typeof body?.path === 'string' ? body.path : undefined;
  const args =
    body?.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : undefined;

  if (!actionId) return c.json({ error: 'actionId required' }, 400);
  if (ids.length === 0) return c.json({ error: 'ids array required' }, 400);
  if (ids.length > 500) return c.json({ error: 'max 500 ids per batch' }, 400);

  const tenant = getTenant(c);
  const trail = getTrail(c);
  const actor = userActor(c);

  const results = {
    actionId,
    requested: ids.length,
    succeeded: [] as Array<{ id: string }>,
    failed: [] as Array<{ id: string; error: string }>,
  };

  for (const id of ids) {
    const existing = await getCandidate(trail, tenant.id, id);
    if (!existing) {
      results.failed.push({ id, error: 'not found' });
      continue;
    }
    try {
      const parsed = ResolveCandidateSchema.safeParse({
        actionId,
        args,
        filename,
        path,
        reason,
      });
      if (!parsed.success) {
        results.failed.push({ id, error: 'invalid resolve payload' });
        continue;
      }
      const r = await resolveCandidate(trail, tenant.id, id, actor, parsed.data);
      emitResolution(r, existing);
      results.succeeded.push({ id });
    } catch (err) {
      results.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json(results);
});
