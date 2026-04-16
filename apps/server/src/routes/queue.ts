import { Hono, type Context } from 'hono';
import {
  CreateQueueCandidateSchema,
  ApproveCandidateSchema,
  RejectCandidateSchema,
  ListQueueQuerySchema,
} from '@trail/shared';
import { requireAuth, getTenant, getUser } from '../middleware/auth.js';
import {
  createCandidate,
  approveCandidate,
  rejectCandidate,
  listCandidates,
  getCandidate,
  type Actor,
} from '../queue/candidates.js';

export const queueRoutes = new Hono();

queueRoutes.use('*', requireAuth);

function userActor(c: Context): Actor {
  const user = getUser(c);
  return { id: user.id, kind: 'user' };
}

queueRoutes.post('/queue/candidates', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateQueueCandidateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const tenant = getTenant(c);
  try {
    const result = createCandidate(tenant.id, parsed.data, userActor(c));
    return c.json(result, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Knowledge base not found')) return c.json({ error: msg }, 404);
    return c.json({ error: msg }, 500);
  }
});

queueRoutes.get('/queue', (c) => {
  const query = ListQueueQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!query.success) return c.json({ error: query.error.flatten() }, 400);

  const tenant = getTenant(c);
  const items = listCandidates(tenant.id, query.data);
  return c.json({ items, count: items.length });
});

queueRoutes.get('/queue/:id', (c) => {
  const tenant = getTenant(c);
  const candidate = getCandidate(tenant.id, c.req.param('id'));
  if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
  return c.json(candidate);
});

queueRoutes.post('/queue/:id/approve', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = ApproveCandidateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const tenant = getTenant(c);
  try {
    const result = approveCandidate(
      tenant.id,
      c.req.param('id'),
      userActor(c),
      parsed.data,
    );
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
    const result = rejectCandidate(
      tenant.id,
      c.req.param('id'),
      userActor(c),
      parsed.data,
    );
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Candidate not found')) return c.json({ error: msg }, 404);
    if (msg.startsWith('Candidate is not pending')) return c.json({ error: msg }, 409);
    return c.json({ error: msg }, 500);
  }
});
