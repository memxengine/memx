import type { Pipeline, PipelineInput, PipelineResult } from './interface.js';

/**
 * F28 — module-level registry. Pipeline implementations register
 * themselves at import time (see `index.ts`); the orchestrator calls
 * `dispatch()` to route a source to the highest-scoring pipeline.
 */

const registry: Pipeline[] = [];

export function registerPipeline(pipeline: Pipeline): void {
  // Idempotent — re-registering the same name replaces the old. Useful
  // for tests that swap a pipeline's `handle` with a stub.
  const existingIdx = registry.findIndex((p) => p.name === pipeline.name);
  if (existingIdx >= 0) {
    registry[existingIdx] = pipeline;
  } else {
    registry.push(pipeline);
  }
}

export function listPipelines(): readonly Pipeline[] {
  return registry;
}

export function clearPipelines(): void {
  // Test-only helper. Production code never clears.
  registry.length = 0;
}

export interface DispatchResult {
  pipeline: Pipeline;
  result: PipelineResult;
}

/**
 * Run the highest-scoring registered pipeline for `input`. Throws if no
 * pipeline accepts the source.
 */
export async function dispatch(input: PipelineInput): Promise<DispatchResult> {
  const winner = pickPipeline(input.filename, input.mime);
  if (!winner) {
    throw new Error(
      `No pipeline registered for "${input.filename}" (mime=${input.mime ?? 'unknown'})`,
    );
  }
  const result = await winner.handle(input);
  return { pipeline: winner, result };
}

/** Pick the pipeline that would run, without executing it. Useful for
 *  upload-time decisions (skip dispatch when no pipeline matches the ext). */
export function pickPipeline(filename: string, mime?: string): Pipeline | null {
  const scored = registry
    .map((p) => ({ p, score: p.accepts(filename, mime) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.p ?? null;
}
