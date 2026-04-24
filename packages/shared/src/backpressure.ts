/**
 * F21 — Ingest backpressure config. Plain constants + types shared
 * between server (enforcement) and admin (status messaging).
 *
 * Design: per-KB concurrency stays at 1 (F143 design — protects
 * `/neurons/overview.md` from concurrent compile-cascade conflicts).
 * F21 adds two additional layers:
 *
 *  1. **Global concurrency cap** — max N ingests running across the
 *     whole engine. Defaults to 5; one Fly performance-2x can run
 *     ~5 Claude/OpenRouter subprocesses (~200MB each = 1GB) without
 *     stress.
 *  2. **Per-tenant rate cap** — sliding hourly window. Prevents one
 *     tenant uploading a 65-file batch from blocking sister tenants
 *     on the same shared pool node. Default 60/h ≈ 1 ingest per
 *     minute steady-state.
 *
 * When a job hits either cap, it stays `status='queued'` in
 * ingest_jobs and the periodic scheduler picks it up when capacity
 * frees. No new schema; no `pending_ingestion` enum value (the
 * original plan-doc predates F143's queue table).
 */

export interface BackpressureConfig {
  /** Max ingests running concurrently across the whole engine. */
  maxConcurrentGlobal: number;
  /** Max ingests started per tenant in the trailing 60 minutes. */
  maxPerHourPerTenant: number;
  /** Interval at which the scheduler scans for queued work to drain. */
  schedulerIntervalMs: number;
}

export const DEFAULT_BACKPRESSURE: BackpressureConfig = {
  maxConcurrentGlobal: 5,
  maxPerHourPerTenant: 60,
  schedulerIntervalMs: 30_000,
};

/** Read overrides from env at boot time. Out-of-range values fall back to defaults. */
export function backpressureFromEnv(env: Record<string, string | undefined>): BackpressureConfig {
  const global = Number(env.TRAIL_INGEST_MAX_CONCURRENT ?? DEFAULT_BACKPRESSURE.maxConcurrentGlobal);
  const perTenant = Number(env.TRAIL_INGEST_MAX_PER_HOUR_PER_TENANT ?? DEFAULT_BACKPRESSURE.maxPerHourPerTenant);
  const interval = Number(env.TRAIL_INGEST_SCHEDULER_INTERVAL_MS ?? DEFAULT_BACKPRESSURE.schedulerIntervalMs);
  return {
    maxConcurrentGlobal: Number.isFinite(global) && global > 0 ? Math.floor(global) : DEFAULT_BACKPRESSURE.maxConcurrentGlobal,
    maxPerHourPerTenant: Number.isFinite(perTenant) && perTenant > 0 ? Math.floor(perTenant) : DEFAULT_BACKPRESSURE.maxPerHourPerTenant,
    schedulerIntervalMs: Number.isFinite(interval) && interval >= 1000 ? Math.floor(interval) : DEFAULT_BACKPRESSURE.schedulerIntervalMs,
  };
}

export type BackpressureBlockReason =
  | 'global-concurrency'   // global cap hit; another KB is using the slot
  | 'tenant-rate'          // tenant's hourly window is full
  | 'kb-busy';             // KB already has a job running (pre-F21 behaviour)

export interface BackpressureDecision {
  allowed: boolean;
  reason?: BackpressureBlockReason;
  /** When `allowed` is false, ms until earliest opportunity to retry.
   *  For 'global-concurrency' / 'kb-busy' this is "as soon as the
   *  current job completes" — caller should rely on the post-finish
   *  tick. For 'tenant-rate' it's the rolling-window expiry of the
   *  oldest counted job. */
  retryAfterMs?: number;
}
