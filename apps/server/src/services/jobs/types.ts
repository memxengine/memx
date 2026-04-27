/**
 * F164 — Background jobs framework: shared types.
 *
 * The runner stays generic; each kind has its own handler module that
 * registers at boot and owns its payload/progress/result shape.
 */

import type { TrailDatabase } from '@trail/db';

export type JobStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted';

/**
 * Discriminated union of all known job kinds. Add a literal here when
 * registering a new handler so the type-system catches stale switch-
 * statements in admin UI / cost-display code.
 */
export type JobKind =
  | 'noop' // Phase 1 verification stub
  | 'vision-rerun' // Phase 2
  | 'bulk-vision-rerun'; // Phase 4

/**
 * Generic progress shape — every handler must conform so the SSE channel
 * + admin progress modal can render uniformly. Handler-specific extras
 * go in `extra` (opaque JSON).
 */
export interface JobProgress {
  current: number;
  total: number;
  /** ms; null when not enough data to estimate yet. */
  etaMs?: number | null;
  /** Free-form short label rendered above the progress bar. */
  phase?: string;
  /** Handler-specific counters (described, decorative, failed, ...). */
  extra?: Record<string, unknown>;
}

/**
 * Context passed into every handler invocation. The handler MUST:
 *   - Check `signal.aborted` between sub-tasks and exit cleanly.
 *   - Call `report()` periodically so heartbeat + UI stay alive.
 *   - Tolerate resume-from-mid-execution (idempotent sub-tasks).
 */
export interface JobContext<TPayload = unknown> {
  jobId: string;
  tenantId: string;
  knowledgeBaseId: string | null;
  userId: string;
  payload: TPayload;
  signal: AbortSignal;
  report: (progress: JobProgress, partialCostCents?: number) => Promise<void>;
  trail: TrailDatabase;
}

/**
 * Handler return value: the `result` JSON we persist + final cost.
 * Throwing inside the handler maps to status='failed' with the error
 * message stamped on `error_message`.
 */
export interface JobResult<TResult = unknown> {
  result: TResult;
  costCentsActual?: number;
}

export type JobHandler<TPayload = unknown, TResult = unknown> = (
  ctx: JobContext<TPayload>,
) => Promise<JobResult<TResult>>;
