import { join } from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { runAgenticLoop, type TurnResult, AVAILABLE_MODELS } from './openrouter';
import { createSimulatedKB, initKB, createToolExecutor, collectKBOutput, cleanupKB } from './tools';
import { buildIngestPrompt } from './prompt';
import { insertRun, updateRunCompleted, insertTurnLog, insertQualityScore, getRun } from './db';
import { scoreRun } from './scorer';

export { AVAILABLE_MODELS };

export interface StartRunOptions {
  model: string;
  sourceFilePath: string;
  maxTurns?: number;
  temperature?: number;
}

const activeRuns = new Map<string, Promise<void>>();

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

export async function startRun(opts: StartRunOptions): Promise<string> {
  const runId = `run_${crypto.randomUUID().slice(0, 12)}`;
  const sourceContent = await readFile(opts.sourceFilePath, 'utf-8');
  const sourceFilename = opts.sourceFilePath.split('/').pop() ?? 'source.md';
  const sourcePath = `/sources/${sourceFilename}`;
  const kbRoot = join(import.meta.dir, '../../data/kbs', runId);

  const kb = createSimulatedKB(kbRoot, sourcePath, sourceContent);
  await initKB(kb);

  insertRun({
    id: runId,
    model: opts.model,
    source_file: sourceFilename,
    source_size_bytes: Buffer.byteLength(sourceContent),
    status: 'running',
    started_at: new Date().toISOString(),
    max_turns: opts.maxTurns ?? 200,
    temperature: opts.temperature ?? 0.3,
  });

  const { systemPrompt, userPrompt, tools } = buildIngestPrompt({
    kb,
    sourceFilename,
    sourcePath,
  });

  const executeTool = createToolExecutor(kb);
  let turnCounter = 0;

  const runPromise = (async () => {
    try {
      const result = await runAgenticLoop(
        {
          model: opts.model,
          systemPrompt,
          userPrompt,
          tools,
          maxTurns: opts.maxTurns ?? 200,
          temperature: opts.temperature ?? 0.3,
        },
        executeTool,
        (turn: TurnResult) => {
          turnCounter++;
          try {
            insertTurnLog({
              run_id: runId,
              turn_number: turnCounter,
              role: turn.role,
              content: turn.content?.slice(0, 100000) ?? null,
              tool_calls: turn.tool_calls ? JSON.stringify(turn.tool_calls) : null,
              tool_call_id: turn.tool_call_id ?? null,
              tokens_in: turn.tokensIn,
              tokens_out: turn.tokensOut,
              cost_usd: turn.costUsd,
              latency_ms: turn.latencyMs,
            });
          } catch (logErr) {
            console.error(`[runner] Failed to log turn ${turnCounter}:`, logErr);
          }
        },
      );

      let kbOutput: Record<string, string> = {};
      try {
        kbOutput = await collectKBOutput(kb);
      } catch (collectErr) {
        console.error(`[runner] Failed to collect KB output:`, collectErr);
      }

      updateRunCompleted(runId, {
        status: result.error ? 'failed' : 'done',
        completed_at: new Date().toISOString(),
        error: result.error,
        total_tokens_in: result.totalTokensIn,
        total_tokens_out: result.totalTokensOut,
        total_cost_usd: result.totalCostUsd,
        total_turns: result.totalTurns,
        duration_ms: result.durationMs,
        final_content: result.finalContent?.slice(0, 50000) ?? null,
        kb_output: JSON.stringify(kbOutput),
      });

      try {
        const run = getRun(runId);
        if (run) {
          const scores = scoreRun(run);
          for (const s of scores) {
            insertQualityScore({ run_id: runId, scorer: s.scorer, score: s.score, details: s.details });
          }
        }
      } catch (scoreErr) {
        console.error(`[runner] Failed to score run:`, scoreErr);
      }

      try {
        await cleanupKB(kb);
      } catch (cleanErr) {
        console.error(`[runner] Failed to cleanup KB:`, cleanErr);
      }

      console.log(`[runner] Run ${runId} completed: ${result.error ? 'failed' : 'done'}, ${result.totalTurns} turns, $${result.totalCostUsd.toFixed(4)}`);
    } catch (err) {
      console.error(`[runner] Run ${runId} crashed:`, err);
      try {
        updateRunCompleted(runId, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
          total_tokens_in: 0,
          total_tokens_out: 0,
          total_cost_usd: 0,
          total_turns: 0,
          duration_ms: 0,
        });
      } catch {}
      try {
        await cleanupKB(kb);
      } catch {}
    } finally {
      activeRuns.delete(runId);
    }
  })();

  activeRuns.set(runId, runPromise);
  return runId;
}

export interface BatchRunOptions {
  models: string[];
  sourceFilePath: string;
  maxTurns?: number;
  temperature?: number;
}

export async function startBatchRun(opts: BatchRunOptions): Promise<string[]> {
  const runIds: string[] = [];
  for (const model of opts.models) {
    const runId = await startRun({
      model,
      sourceFilePath: opts.sourceFilePath,
      maxTurns: opts.maxTurns,
      temperature: opts.temperature,
    });
    runIds.push(runId);
  }
  return runIds;
}
