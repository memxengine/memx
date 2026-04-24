import { config } from 'dotenv';
config({ path: import.meta.dir + '/../../.env' });

import { insertRun, updateRunCompleted, insertTurnLog, insertQualityScore, getRun } from './db';
import { runAgenticLoop } from './openrouter';
import { createSimulatedKB, initKB, createToolExecutor, collectKBOutput, cleanupKB } from './tools';
import { buildIngestPrompt } from './prompt';
import { scoreRun } from './scorer';
import { readFile } from 'node:fs/promises';

const model = process.argv[2];
const sourcePath = process.argv[3];
const maxTurns = Number(process.argv[4] ?? 200);

if (!model || !sourcePath) {
  console.error('Usage: bun run src/server/cli.ts <model> <source-file> [max-turns]');
  console.error('Models: qwen/qwen3-8b, qwen/qwen3.6-plus, google/gemini-2.5-flash, z-ai/glm-5.1');
  process.exit(1);
}

const runId = 'run_' + crypto.randomUUID().slice(0, 12);
const sourceContent = await readFile(sourcePath, 'utf-8');
const sourceFilename = sourcePath.split('/').pop() ?? 'source.md';
const sourceFileKBPath = '/sources/' + sourceFilename;
const kbRoot = import.meta.dir + '/../../data/kbs/' + runId;

console.log(`[cli] Run ${runId}: ${model} on ${sourceFilename} (${(sourceContent.length / 1024).toFixed(1)} KB), max ${maxTurns} turns`);

insertRun({
  id: runId,
  model,
  source_file: sourceFilename,
  source_size_bytes: Buffer.byteLength(sourceContent),
  status: 'running',
  started_at: new Date().toISOString(),
  max_turns: maxTurns,
  temperature: 0.3,
});

const kb = createSimulatedKB(kbRoot, sourceFileKBPath, sourceContent);
await initKB(kb);

const { systemPrompt, userPrompt, tools } = buildIngestPrompt({
  kb,
  sourceFilename,
  sourcePath: sourceFileKBPath,
});

const executeTool = createToolExecutor(kb);
let turnCounter = 0;

const result = await runAgenticLoop(
  { model, systemPrompt, userPrompt, tools, maxTurns, temperature: 0.3 },
  executeTool,
  (turn) => {
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
    const toolInfo = turn.tool_calls ? ' tools=' + turn.tool_calls.map((t) => t.function.name).join(',') : '';
    const tokenInfo = turn.tokensIn ? ` ${turn.tokensIn}/${turn.tokensOut}tok ${turn.latencyMs}ms` : '';
    console.log(`[turn ${turnCounter}] ${turn.role}${toolInfo}${tokenInfo}`);
  },
);

let kbOutput: Record<string, string> = {};
try { kbOutput = await collectKBOutput(kb); } catch {}

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

const run = getRun(runId);
if (run) {
  const scores = scoreRun(run);
  for (const s of scores) {
    insertQualityScore({ run_id: runId, scorer: s.scorer, score: s.score, details: s.details });
    console.log(`[score] ${s.scorer}: ${(s.score * 100).toFixed(0)}% — ${s.details}`);
  }
}

await cleanupKB(kb);

console.log(`\n[cli] DONE: ${runId}`);
console.log(`  Status: ${result.error ? 'failed' : 'done'}`);
console.log(`  Turns: ${result.totalTurns}`);
console.log(`  Cost: $${result.totalCostUsd.toFixed(4)}`);
console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
console.log(`  Tokens: ${result.totalTokensIn} in / ${result.totalTokensOut} out`);
console.log(`  Files created: ${Object.keys(kbOutput).length}`);
if (result.error) console.log(`  Error: ${result.error}`);
