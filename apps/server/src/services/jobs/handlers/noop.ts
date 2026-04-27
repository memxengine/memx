/**
 * F164 Phase 1 — verification stub handler.
 *
 * Reports tick-progress every 200ms for `payload.ticks` iterations,
 * then returns. Used by `verify-f164-jobs-runner.ts` to assert that:
 *   1. Submit → SSE 'progress' events stream live
 *   2. Abort during run → handler exits cooperatively
 *   3. Crash + resume → recoverZombies + tick re-picks-up
 *
 * NOT exposed as a public job-kind in the admin UI — only registered
 * when TRAIL_JOBS_NOOP_HANDLER=1 (default off in prod).
 */

import type { JobHandler } from '../types.js';

interface NoopPayload {
  ticks: number;
  /** ms between ticks. Default 200. */
  intervalMs?: number;
}

interface NoopResult {
  completedTicks: number;
}

export const noopHandler: JobHandler<NoopPayload, NoopResult> = async (ctx) => {
  const total = Math.max(1, ctx.payload?.ticks ?? 5);
  const interval = ctx.payload?.intervalMs ?? 200;
  const start = Date.now();
  let completed = 0;

  for (let i = 1; i <= total; i++) {
    if (ctx.signal.aborted) break;
    await sleep(interval);
    completed = i;
    const elapsed = Date.now() - start;
    const rate = completed / elapsed;
    const remaining = total - completed;
    const etaMs = rate > 0 ? remaining / rate : null;
    await ctx.report({ current: completed, total, etaMs, phase: 'ticking' });
  }

  return { result: { completedTicks: completed } };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
