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

  void (async () => {
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
        },
      );

      const kbOutput = await collectKBOutput(kb);

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

      const run = getRun(runId)!;
      const scores = scoreRun(run);
      for (const s of scores) {
        insertQualityScore({ run_id: runId, scorer: s.scorer, score: s.score, details: s.details });
      }

      await cleanupKB(kb);
    } catch (err) {
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
      await cleanupKB(kb);
    }
  })();

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
