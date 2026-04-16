import { Hono, type Context } from 'hono';
import { knowledgeBases } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import { runLint, type Actor } from '@trail/core';
import { INGEST_USER_ID } from '../bootstrap/ingest-user.js';

/**
 * F32.1 — on-demand lint.
 *
 * `POST /api/v1/knowledge-bases/:kbId/lint` runs orphan + stale detectors
 * against the KB and emits findings as queue candidates. Idempotent: if a
 * pending/approved candidate already exists for a given finding
 * (matched via `metadata.lintFingerprint`), it is skipped.
 *
 * No scheduler, no LLM. That's F32.2. This route is what F32.2's cron
 * will call into.
 *
 * Optional body: `{ staleDays?: number, hubPages?: string[] }`.
 */
export const lintRoutes = new Hono();

lintRoutes.use('*', requireAuth);

function lintActor(c: Context): Actor {
  const user = getUser(c);
  // Bearer/service runs get 'system' actor so their candidates can
  // auto-approve where policy allows — same distinction queue.ts makes.
  if (user.id === INGEST_USER_ID) {
    return { id: user.id, kind: 'system' };
  }
  return { id: user.id, kind: 'user' };
}

lintRoutes.post('/knowledge-bases/:kbId/lint', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = c.req.param('kbId');

  const kb = await trail.db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .get();
  if (!kb) return c.json({ error: 'Knowledge base not found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    staleDays?: number;
    hubPages?: string[];
  };

  const report = await runLint(trail, kbId, tenant.id, lintActor(c), {
    staleDays: typeof body.staleDays === 'number' ? body.staleDays : undefined,
    hubPages: Array.isArray(body.hubPages) ? body.hubPages : undefined,
  });

  return c.json(report);
});
