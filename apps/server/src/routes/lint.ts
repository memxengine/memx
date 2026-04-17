import { Hono, type Context } from 'hono';
import { knowledgeBases } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import { runLint, type Actor } from '@trail/core';
import { INGEST_USER_ID } from '../bootstrap/ingest-user.js';
import { broadcaster } from '../services/broadcast.js';

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

  const report = await runLint(
    trail,
    kbId,
    tenant.id,
    lintActor(c),
    {
      staleDays: typeof body.staleDays === 'number' ? body.staleDays : undefined,
      hubPages: Array.isArray(body.hubPages) ? body.hubPages : undefined,
    },
    // Broadcast candidate_created per finding so the badge + Queue panel
    // update the same way a human POST to /queue/candidates would. Without
    // this, lint-generated candidates landed silently — Christian saw the
    // "6 new candidates" toast but no badge until the next refetch.
    ({ candidate, autoApproved, documentId }) => {
      broadcaster.emit({
        type: 'candidate_created',
        tenantId: candidate.tenantId,
        kbId: candidate.knowledgeBaseId,
        candidateId: candidate.id,
        kind: candidate.kind,
        title: candidate.title,
        status: autoApproved ? 'approved' : 'pending',
        autoApproved,
        confidence: candidate.confidence,
        createdBy: candidate.createdBy,
      });
      if (autoApproved) {
        // Lint candidates use the default action set, so an auto-approval
        // here always fires actionId='approve' / effect='approve'. The
        // narrow doc-producing event only emits when a document was
        // actually created (some actions don't, see queue.ts emitResolution).
        broadcaster.emit({
          type: 'candidate_resolved',
          tenantId: candidate.tenantId,
          kbId: candidate.knowledgeBaseId,
          candidateId: candidate.id,
          actionId: 'approve',
          effect: 'approve',
          documentId,
          autoApproved: true,
        });
        if (documentId) {
          broadcaster.emit({
            type: 'candidate_approved',
            tenantId: candidate.tenantId,
            kbId: candidate.knowledgeBaseId,
            candidateId: candidate.id,
            documentId,
            autoApproved: true,
          });
        }
      }
    },
  );

  return c.json(report);
});
