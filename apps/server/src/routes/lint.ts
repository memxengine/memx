import { Hono, type Context } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { brokenLinks, documents } from '@trail/db';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import { runLint, resolveKbId, type Actor } from '@trail/core';
import { INGEST_USER_ID } from '../bootstrap/ingest-user.js';
import { broadcaster } from '../services/broadcast.js';
import { rescanDocLinks, runFullLinkCheck } from '../services/link-checker.js';

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
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

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

// ── F148 — Link Integrity routes ─────────────────────────────────────────────

/**
 * List open broken-link findings for a KB. Joins through documents so the
 * curator UI can render "in <Neuron title> → [[<broken link text>]]" rows
 * without a per-finding lookup.
 */
lintRoutes.get('/knowledge-bases/:kbId/link-check', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

  const rows = await trail.db
    .select({
      id: brokenLinks.id,
      fromDocumentId: brokenLinks.fromDocumentId,
      fromFilename: documents.filename,
      fromTitle: documents.title,
      linkText: brokenLinks.linkText,
      suggestedFix: brokenLinks.suggestedFix,
      status: brokenLinks.status,
      reportedAt: brokenLinks.reportedAt,
    })
    .from(brokenLinks)
    .innerJoin(documents, eq(documents.id, brokenLinks.fromDocumentId))
    .where(
      and(
        eq(brokenLinks.tenantId, tenant.id),
        eq(brokenLinks.knowledgeBaseId, kbId),
        eq(brokenLinks.status, 'open'),
      ),
    )
    .orderBy(desc(brokenLinks.reportedAt))
    .all();

  return c.json({ findings: rows });
});

/**
 * Manually trigger a full KB sweep. Same work the scheduler does nightly,
 * but lets the curator rebuild after bulk edits without waiting for the
 * next scheduled pass.
 */
lintRoutes.post('/knowledge-bases/:kbId/link-check/rescan', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

  const summary = await runFullLinkCheck(trail, tenant.id, kbId);
  return c.json(summary);
});

/**
 * Dismiss a broken-link finding — curator confirmed the dead link is
 * intentional (target Neuron not yet created, or the [[link]] is a
 * placeholder). The row stays in the table so a future scan doesn't
 * re-open it; dismissing is a signal, not a delete.
 */
lintRoutes.post('/link-check/:id/dismiss', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const id = c.req.param('id');

  const row = await trail.db
    .select({ id: brokenLinks.id, fromDocumentId: brokenLinks.fromDocumentId })
    .from(brokenLinks)
    .where(and(eq(brokenLinks.id, id), eq(brokenLinks.tenantId, tenant.id)))
    .get();
  if (!row) return c.json({ error: 'Finding not found' }, 404);

  await trail.db
    .update(brokenLinks)
    .set({ status: 'dismissed', fixedAt: new Date().toISOString() })
    .where(eq(brokenLinks.id, id))
    .run();

  return c.json({ dismissed: true });
});

/**
 * Re-open a previously dismissed finding. Useful if the curator dismissed
 * by mistake, or the target Neuron was finally created and they want the
 * next scan to verify.
 */
lintRoutes.post('/link-check/:id/reopen', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const id = c.req.param('id');

  const row = await trail.db
    .select({ id: brokenLinks.id, fromDocumentId: brokenLinks.fromDocumentId })
    .from(brokenLinks)
    .where(and(eq(brokenLinks.id, id), eq(brokenLinks.tenantId, tenant.id)))
    .get();
  if (!row) return c.json({ error: 'Finding not found' }, 404);

  // Rescan the source doc rather than just flipping the flag — if the
  // target now exists, the scan will clear the row automatically.
  await rescanDocLinks(trail, row.fromDocumentId);
  return c.json({ reopened: true });
});
