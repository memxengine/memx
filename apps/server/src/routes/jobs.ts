/**
 * F164 — Jobs HTTP API.
 *
 * Generic surface for the background-job framework. Phase 1 ships:
 *   POST   /jobs              — submit a new job (kind+payload)
 *   GET    /jobs              — list jobs for current tenant (filter by status/kind/kb)
 *   GET    /jobs/:id          — fetch single job snapshot
 *   GET    /jobs/:id/stream   — SSE channel for live progress updates
 *   POST   /jobs/:id/abort    — request cooperative cancel
 *
 * Auth: same session-cookie or Bearer as the rest of /api/v1. Tenant
 * scoping is enforced on every read — a curator from tenant A can't
 * see jobs of tenant B even if they guess an id.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { jobs, type TrailDatabase } from '@trail/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import { getJobRunner } from '../services/jobs/runner.js';
import { jobsBroadcast } from '../services/jobs/broadcast.js';
import type { JobKind } from '../services/jobs/types.js';

export const jobRoutes = new Hono();
jobRoutes.use('*', requireAuth);

const KNOWN_KINDS: ReadonlySet<JobKind> = new Set<JobKind>([
  'noop',
  'vision-rerun',
  'bulk-vision-rerun',
]);

jobRoutes.post('/jobs', async (c) => {
  const tenant = getTenant(c);
  const user = getUser(c);
  const body = (await c.req.json().catch(() => null)) as
    | {
        kind?: string;
        payload?: unknown;
        knowledgeBaseId?: string | null;
        costCentsEstimated?: number;
      }
    | null;
  if (!body?.kind) return c.json({ error: 'Missing kind' }, 400);
  if (!KNOWN_KINDS.has(body.kind as JobKind)) {
    return c.json({ error: `Unknown kind '${body.kind}'` }, 400);
  }

  // Phase 1 only allows 'noop' when explicitly opted-in via env. Real
  // handlers (vision-rerun, bulk-vision-rerun) ship later phases.
  if (body.kind === 'noop' && process.env.TRAIL_JOBS_NOOP_HANDLER !== '1') {
    return c.json({ error: 'noop handler disabled' }, 404);
  }

  const runner = getJobRunner();
  const id = await runner.submit({
    kind: body.kind as JobKind,
    tenantId: tenant.id,
    knowledgeBaseId: body.knowledgeBaseId ?? null,
    userId: user.id,
    payload: body.payload ?? {},
    costCentsEstimated: body.costCentsEstimated,
  });
  return c.json({ id }, 201);
});

jobRoutes.get('/jobs', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const status = c.req.query('status');
  const kind = c.req.query('kind');
  const kbId = c.req.query('knowledgeBaseId');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const filters = [eq(jobs.tenantId, tenant.id)];
  if (status) {
    const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 1) filters.push(eq(jobs.status, statuses[0]! as never));
    else if (statuses.length > 1) filters.push(inArray(jobs.status, statuses as never[]));
  }
  if (kind) filters.push(eq(jobs.kind, kind));
  if (kbId) filters.push(eq(jobs.knowledgeBaseId, kbId));

  const rows = await trail.db
    .select()
    .from(jobs)
    .where(and(...filters))
    .orderBy(desc(jobs.createdAt))
    .limit(limit)
    .all();

  return c.json({ jobs: rows.map(serializeJob) });
});

jobRoutes.get('/jobs/:id', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const job = await loadJob(trail, tenant.id, c.req.param('id'));
  if (!job) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeJob(job));
});

jobRoutes.post('/jobs/:id/abort', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const id = c.req.param('id');
  const job = await loadJob(trail, tenant.id, id);
  if (!job) return c.json({ error: 'Not found' }, 404);
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'aborted') {
    return c.json({ error: `Cannot abort job in status '${job.status}'` }, 409);
  }
  const runner = getJobRunner();
  await runner.abort(id);
  return c.json({ ok: true });
});

jobRoutes.get('/jobs/:id/stream', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const id = c.req.param('id');
  const job = await loadJob(trail, tenant.id, id);
  if (!job) return c.json({ error: 'Not found' }, 404);

  return streamSSE(c, async (stream) => {
    let seq = 0;

    // Replay snapshot first so a re-attaching client picks up where
    // it left off (admin tab refresh during a 5-min job).
    await stream.writeSSE({
      data: JSON.stringify(serializeJob(job)),
      event: 'snapshot',
      id: String(seq++),
    });

    // If the job already finished, emit terminal event + close.
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'aborted') {
      await stream.writeSSE({
        data: JSON.stringify({ status: job.status, result: parseMaybe(job.result), errorMessage: job.errorMessage }),
        event: job.status,
        id: String(seq++),
      });
      return;
    }

    const queue: Array<{ type: string; payload: unknown }> = [];
    let resolveWait: (() => void) | null = null;
    const unsubscribe = jobsBroadcast.subscribe(id, (ev) => {
      queue.push(ev);
      resolveWait?.();
    });
    stream.onAbort(() => {
      unsubscribe();
      resolveWait?.();
    });

    const pinger = setInterval(() => {
      queue.push({ type: 'ping', payload: null });
      resolveWait?.();
    }, 30_000);

    try {
      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
          resolveWait = null;
          continue;
        }
        const ev = queue.shift()!;
        await stream.writeSSE({
          data: JSON.stringify(ev.payload),
          event: ev.type,
          id: String(seq++),
        });
        if (ev.type === 'completed' || ev.type === 'aborted' || ev.type === 'error') {
          break;
        }
      }
    } finally {
      clearInterval(pinger);
      unsubscribe();
    }
  });
});

async function loadJob(trail: TrailDatabase, tenantId: string, id: string) {
  return trail.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.tenantId, tenantId)))
    .get();
}

function serializeJob(j: typeof jobs.$inferSelect) {
  return {
    id: j.id,
    tenantId: j.tenantId,
    knowledgeBaseId: j.knowledgeBaseId,
    userId: j.userId,
    kind: j.kind,
    status: j.status,
    payload: parseMaybe(j.payload),
    progress: parseMaybe(j.progress),
    result: parseMaybe(j.result),
    errorMessage: j.errorMessage,
    parentJobId: j.parentJobId,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    lastHeartbeatAt: j.lastHeartbeatAt,
    abortRequested: j.abortRequested === 1,
    costCentsEstimated: j.costCentsEstimated,
    costCentsActual: j.costCentsActual,
  };
}

function parseMaybe(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
