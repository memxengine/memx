/**
 * F149 — Ingest runner with live fallback-chain execution.
 *
 * Given a chain of {backend, model} steps, try each in order. On
 * failure catch the error, record the failed step in model_trail,
 * advance to the next step. When a step succeeds return the
 * accumulated result (successful-step modelTrail + any failed-step
 * entries so the curator can audit what happened).
 *
 * Partial progress is preserved across step boundaries because both
 * backends write to the same Candidate Queue (via MCP for claude-cli,
 * via in-process CandidateQueueAPI for openrouter). A mid-job crash
 * on Flash leaves 3 Neurons already in the queue — GLM picks up from
 * the current wiki state on its first `search` call.
 *
 * When the whole chain is exhausted we rethrow the last error so the
 * caller (ingest.ts runJob) marks the job failed. Intentionally no
 * silent success-with-warnings: a failed ingest MUST be visible.
 */

import type {
  IngestBackend,
  IngestBackendInput,
  IngestBackendResult,
} from './backend.js';
import type { ChainStep } from './chain.js';
import { ClaudeCLIBackend } from './claude-cli-backend.js';

const BACKENDS: Record<string, IngestBackend> = {
  'claude-cli': new ClaudeCLIBackend(),
  // 'openrouter': new OpenRouterBackend(),  // F149 Phase 2
};

export interface RunnerResult extends IngestBackendResult {
  /** Backend that produced the successful result (last step in chain). */
  backend: string;
  /** Model from the same successful step. */
  model: string;
  /** Full record of every step tried, including failed ones. */
  attempts: Array<{
    backend: string;
    model: string;
    success: boolean;
    error?: string;
    durationMs?: number;
  }>;
}

export async function runWithFallback(
  chain: ChainStep[],
  baseInput: Omit<IngestBackendInput, 'model' | 'translationModel'>,
): Promise<RunnerResult> {
  if (chain.length === 0) {
    throw new Error('ingest chain is empty — no backend to try');
  }

  const attempts: RunnerResult['attempts'] = [];
  const combinedTrail: Array<{ turn: number; model: string }> = [];
  let lastError: Error | null = null;

  for (const step of chain) {
    const backend = BACKENDS[step.backend];
    if (!backend) {
      attempts.push({
        backend: step.backend,
        model: step.model,
        success: false,
        error: `backend "${step.backend}" not registered`,
      });
      lastError = new Error(`backend "${step.backend}" not registered`);
      continue;
    }

    const input: IngestBackendInput = {
      ...baseInput,
      model: step.model,
      translationModel: step.translationModel,
    };

    const stepStart = Date.now();
    try {
      const result = await backend.run(input);
      const stepDuration = Date.now() - stepStart;
      attempts.push({
        backend: step.backend,
        model: step.model,
        success: true,
        durationMs: stepDuration,
      });
      // Prepend any prior failed-step markers to the model-trail so the
      // audit shows "tried flash (failed), tried glm (ok)".
      combinedTrail.push(...result.modelTrail);
      return {
        ...result,
        backend: step.backend,
        model: step.model,
        modelTrail: combinedTrail,
        attempts,
      };
    } catch (err) {
      const stepDuration = Date.now() - stepStart;
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({
        backend: step.backend,
        model: step.model,
        success: false,
        error: msg,
        durationMs: stepDuration,
      });
      // Record the failed step in the trail so F151 quality-dashboard
      // can show "attempted flash, fell back to glm".
      combinedTrail.push({ turn: -1, model: `${step.backend}:${step.model} (failed)` });
      lastError = err instanceof Error ? err : new Error(msg);
      console.warn(
        `[ingest-runner] step ${step.backend}/${step.model} failed after ${stepDuration}ms — advancing chain`,
        msg,
      );
      // Don't sleep between steps; backend-side retries already
      // absorbed transient failures. The chain represents semantic
      // alternatives, not retry-the-same.
    }
  }

  throw new Error(
    `ingest chain exhausted (${chain.length} step(s)); last error: ${lastError?.message ?? 'unknown'}`,
  );
}

/** Exposed for testing + F152 UI preview. */
export function getBackendIds(): string[] {
  return Object.keys(BACKENDS);
}
