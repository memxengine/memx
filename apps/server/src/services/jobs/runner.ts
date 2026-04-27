/**
 * F164 — Background JobRunner.
 *
 * Singleton mounted at engine boot (after migrations, before HTTP-server
 * accepts). Polls the `jobs` table for pending rows, dispatches them to
 * registered handlers, persists progress + cost incrementally, and
 * stamps final status. Each handler runs in its own AbortController so
 * cooperative cancel is a single `abort()` call away.
 *
 * Crash-recovery contract:
 *   - At boot, `recoverZombies()` scans `status='running' AND
 *     last_heartbeat_at < now()-60s` and resets to 'pending'. Handlers
 *     are required to be idempotent; resume is automatic via the
 *     handler's own filter logic (e.g. Vision-rerun's NULL-only filter).
 *
 * Concurrency:
 *   - Global cap = MAX_CONCURRENT_JOBS (default 4). Per-handler sub-task
 *     concurrency is the handler's responsibility (e.g. Vision-rerun
 *     uses pLimit(4) over Vision API calls within one job).
 *
 * SSE:
 *   - `report()` emits a 'progress' event on the per-job channel via
 *     `jobsBroadcast`. Subscribers (admin progress modal) receive
 *     EventSource updates without polling jitter.
 */

import { jobs, type TrailDatabase } from '@trail/db';
import { and, eq, lt, sql } from 'drizzle-orm';
import { jobsBroadcast } from './broadcast.js';
import type {
  JobContext,
  JobHandler,
  JobKind,
  JobProgress,
  JobResult,
  JobStatus,
} from './types.js';

const HEARTBEAT_GRACE_MS = 60_000; // zombie threshold
const TICK_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CONCURRENT = 4;

export interface SubmitArgs<TPayload = unknown> {
  kind: JobKind;
  tenantId: string;
  knowledgeBaseId?: string | null;
  userId: string;
  payload: TPayload;
  costCentsEstimated?: number;
  parentJobId?: string;
}

export class JobRunner {
  private trail: TrailDatabase;
  private handlers = new Map<JobKind, JobHandler>();
  private active = new Map<string, AbortController>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxConcurrent: number;

  constructor(trail: TrailDatabase, opts: { maxConcurrent?: number } = {}) {
    this.trail = trail;
    this.maxConcurrent =
      opts.maxConcurrent ?? Number(process.env.TRAIL_MAX_CONCURRENT_JOBS ?? DEFAULT_MAX_CONCURRENT);
  }

  register<P, R>(kind: JobKind, handler: JobHandler<P, R>): void {
    this.handlers.set(kind, handler as JobHandler);
  }

  async start(): Promise<void> {
    await this.recoverZombies();
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    // Abort all in-flight; each handler should checkpoint and return.
    for (const ctrl of this.active.values()) ctrl.abort();
    this.active.clear();
  }

  async submit<P>(args: SubmitArgs<P>): Promise<string> {
    const id = `job_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await this.trail.db
      .insert(jobs)
      .values({
        id,
        tenantId: args.tenantId,
        knowledgeBaseId: args.knowledgeBaseId ?? null,
        userId: args.userId,
        kind: args.kind,
        status: 'pending',
        payload: JSON.stringify(args.payload),
        createdAt: now,
        costCentsEstimated: args.costCentsEstimated ?? null,
        parentJobId: args.parentJobId ?? null,
      })
      .run();
    return id;
  }

  async abort(jobId: string): Promise<void> {
    await this.trail.db
      .update(jobs)
      .set({ abortRequested: 1 })
      .where(eq(jobs.id, jobId))
      .run();
    this.active.get(jobId)?.abort();
  }

  /**
   * Reset zombie rows so the next tick picks them back up.
   * Handler-side idempotency is the contract.
   */
  async recoverZombies(): Promise<void> {
    const cutoff = new Date(Date.now() - HEARTBEAT_GRACE_MS).toISOString();
    const result = await this.trail.db
      .update(jobs)
      .set({ status: 'pending' })
      .where(and(eq(jobs.status, 'running'), lt(jobs.lastHeartbeatAt, cutoff)))
      .run();
    const changed = (result as { rowsAffected?: number; changes?: number }).rowsAffected
      ?? (result as { changes?: number }).changes
      ?? 0;
    if (changed > 0) {
      console.log(`[jobs] recovered ${changed} zombie job(s)`);
    }
  }

  private async tick(): Promise<void> {
    const slots = this.maxConcurrent - this.active.size;
    if (slots <= 0) return;

    // Claim up to N pending rows atomically. We use a single UPDATE …
    // RETURNING so two ticks (or two engines, eventually) can't double-
    // pick. SQLite supports RETURNING from 3.35+; libsql ships with it.
    // CTE selects N candidate ids, the UPDATE flips status='running'
    // and stamps started_at + heartbeat in one go.
    const claimedAt = new Date().toISOString();
    const result = await this.trail.execute(
      `
      UPDATE jobs
         SET status = 'running',
             started_at = COALESCE(started_at, ?),
             last_heartbeat_at = ?
       WHERE id IN (
         SELECT id FROM jobs
          WHERE status = 'pending'
          ORDER BY created_at ASC
          LIMIT ?
       )
       RETURNING id, kind, payload, tenant_id, knowledge_base_id, user_id, abort_requested
      `,
      [claimedAt, claimedAt, slots],
    );

    const rows = result.rows as Array<{
      id: unknown;
      kind: unknown;
      payload: unknown;
      tenant_id: unknown;
      knowledge_base_id: unknown;
      user_id: unknown;
      abort_requested: unknown;
    }>;

    for (const row of rows) {
      const id = String(row.id);
      const kind = String(row.kind) as JobKind;
      // Spawn — don't await, parallelism is the point.
      void this.runJob({
        id,
        kind,
        payload: String(row.payload),
        tenantId: String(row.tenant_id),
        knowledgeBaseId: row.knowledge_base_id == null ? null : String(row.knowledge_base_id),
        userId: String(row.user_id),
        abortRequested: Number(row.abort_requested ?? 0) === 1,
      });
    }
  }

  private async runJob(claim: {
    id: string;
    kind: JobKind;
    payload: string;
    tenantId: string;
    knowledgeBaseId: string | null;
    userId: string;
    abortRequested: boolean;
  }): Promise<void> {
    const handler = this.handlers.get(claim.kind);
    if (!handler) {
      await this.finalize(claim.id, 'failed', null, `No handler registered for kind '${claim.kind}'`);
      return;
    }

    const ctrl = new AbortController();
    this.active.set(claim.id, ctrl);
    if (claim.abortRequested) ctrl.abort();

    let costAccum = 0;

    const ctx: JobContext = {
      jobId: claim.id,
      tenantId: claim.tenantId,
      knowledgeBaseId: claim.knowledgeBaseId,
      userId: claim.userId,
      payload: safeJsonParse(claim.payload),
      signal: ctrl.signal,
      trail: this.trail,
      report: async (progress: JobProgress, partialCostCents?: number) => {
        if (typeof partialCostCents === 'number') costAccum += partialCostCents;
        await this.trail.db
          .update(jobs)
          .set({
            progress: JSON.stringify(progress),
            lastHeartbeatAt: new Date().toISOString(),
            costCentsActual: costAccum > 0 ? Math.round(costAccum) : null,
          })
          .where(eq(jobs.id, claim.id))
          .run();
        jobsBroadcast.emit(claim.id, 'progress', progress);
      },
    };

    try {
      const out: JobResult = await handler(ctx);
      const finalStatus: JobStatus = ctrl.signal.aborted ? 'aborted' : 'completed';
      await this.finalize(
        claim.id,
        finalStatus,
        out.result ?? null,
        null,
        out.costCentsActual ?? (costAccum > 0 ? Math.round(costAccum) : undefined),
      );
      jobsBroadcast.emit(claim.id, finalStatus === 'completed' ? 'completed' : 'aborted', out.result ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status: JobStatus = ctrl.signal.aborted ? 'aborted' : 'failed';
      await this.finalize(claim.id, status, null, message, costAccum > 0 ? Math.round(costAccum) : undefined);
      jobsBroadcast.emit(claim.id, status === 'aborted' ? 'aborted' : 'error', { message });
    } finally {
      this.active.delete(claim.id);
    }
  }

  private async finalize(
    id: string,
    status: JobStatus,
    result: unknown,
    errorMessage: string | null,
    costCentsActual?: number,
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    await this.trail.db
      .update(jobs)
      .set({
        status,
        finishedAt,
        result: result == null ? null : JSON.stringify(result),
        errorMessage,
        costCentsActual: costCentsActual ?? null,
        lastHeartbeatAt: finishedAt,
      })
      .where(eq(jobs.id, id))
      .run();
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

let singleton: JobRunner | null = null;

export function getJobRunner(): JobRunner {
  if (!singleton) throw new Error('JobRunner not initialised — call initJobRunner() first');
  return singleton;
}

export function initJobRunner(trail: TrailDatabase): JobRunner {
  if (singleton) return singleton;
  singleton = new JobRunner(trail);
  return singleton;
}
