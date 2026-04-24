import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { readFile, mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '../../.env') });

import { listRuns, getRun, getTurnLogs, getQualityScores, insertRun, updateRunCompleted, insertTurnLog, insertQualityScore } from './db-node';
import { AVAILABLE_MODELS, runAgenticLoop } from './openrouter';
import { createSimulatedKB, initKB, createToolExecutor, collectKBOutput, cleanupKB, buildToolDefinitions } from './tools';
import { buildIngestPrompt } from './prompt';
import { scoreRun } from './scorer';

process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err.message));
process.on('unhandledRejection', (r) => console.error('[UNHANDLED]', r));

const app = new Hono();

app.use('/api/*', cors());

app.get('/api/v1/models', (c) => {
  const pricing: Record<string, { input: number; output: number; label: string }> = {
    'google/gemini-2.5-flash': { input: 0.30, output: 2.50, label: 'Gemini 2.5 Flash' },
    'qwen/qwen3-8b': { input: 0.05, output: 0.40, label: 'Qwen3 8B' },
    'qwen/qwen3.6-plus': { input: 0.325, output: 1.95, label: 'Qwen3.6 Plus' },
    'z-ai/glm-5.1': { input: 1.05, output: 3.50, label: 'GLM-5.1' },
    'anthropic/claude-sonnet-4-6': { input: 3.0, output: 15.0, label: 'Claude Sonnet 4.6' },
    'anthropic/claude-haiku-4-5-20251001': { input: 0.80, output: 4.0, label: 'Claude Haiku 4.5' },
  };
  return c.json({ models: AVAILABLE_MODELS.map((id) => ({ id, ...(pricing[id] ?? { input: 0, output: 0, label: id }) })) });
});

app.get('/api/v1/runs', (c) => c.json({ runs: listRuns() }));
app.get('/api/v1/runs/:id', (c) => { const r = getRun(c.req.param('id')); return r ? c.json({ run: r }) : c.json({ error: 'not found' }, 404); });
app.get('/api/v1/runs/:id/turns', (c) => c.json({ turns: getTurnLogs(c.req.param('id')) }));
app.get('/api/v1/runs/:id/scores', (c) => c.json({ scores: getQualityScores(c.req.param('id')) }));

app.post('/api/v1/runs', async (c) => {
  const body = await c.req.json<{ model?: string; models?: string[]; sourceFilePath: string; maxTurns?: number; temperature?: number }>();
  if (!body.sourceFilePath) return c.json({ error: 'sourceFilePath required' }, 400);

  const models = body.models ?? (body.model ? [body.model] : null);
  if (!models) return c.json({ error: 'model or models required' }, 400);

  const runIds: string[] = [];
  for (const model of models) {
    const runId = 'run_' + crypto.randomUUID().slice(0, 12);
    const sourceContent = await readFile(body.sourceFilePath, 'utf-8');
    const sourceFilename = body.sourceFilePath.split('/').pop() ?? 'source.md';
    const sourcePath = '/sources/' + sourceFilename;

    insertRun({
      id: runId,
      model,
      source_file: sourceFilename,
      source_size_bytes: Buffer.byteLength(sourceContent),
      status: 'running',
      started_at: new Date().toISOString(),
      max_turns: body.maxTurns ?? 200,
      temperature: body.temperature ?? 0.3,
    });

    runIds.push(runId);
    executeRun(runId, model, sourceContent, sourceFilename, sourcePath, body.maxTurns ?? 200, body.temperature ?? 0.3).catch((err) => console.error('[run] Fatal:', err.message));
  }

  return c.json({ runIds }, 201);
});

app.post('/api/v1/upload', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ error: 'No file' }, 400);

  const uploadDir = join(__dirname, '../../data/uploads');
  await mkdir(uploadDir, { recursive: true });
  const filename = Date.now() + '-' + file.name;
  const filePath = join(uploadDir, filename);
  const bytes = await file.arrayBuffer();
  await writeFile(filePath, Buffer.from(bytes));
  return c.json({ path: filePath, filename, size: file.size }, 201);
});

async function executeRun(runId: string, model: string, sourceContent: string, sourceFilename: string, sourcePath: string, maxTurns: number, temperature: number) {
  console.log('[run] Starting', runId, model);
  const kbRoot = join(__dirname, '../../data/kbs', runId);
  const kb = createSimulatedKB(kbRoot, sourcePath, sourceContent);

  try {
    await initKB(kb);
    const { systemPrompt, userPrompt, tools } = buildIngestPrompt({ kb, sourceFilename, sourcePath });
    const executeTool = createToolExecutor(kb);
    let turnCounter = 0;

    const result = await runAgenticLoop({ model, systemPrompt, userPrompt, tools, maxTurns, temperature }, executeTool, (turn) => {
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
      } catch (e) { console.error('[run] turn log error:', e); }
    });

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
      for (const s of scores) insertQualityScore({ run_id: runId, scorer: s.scorer, score: s.score, details: s.details });
    }

    await cleanupKB(kb);
    console.log('[run] DONE', runId, result.totalTurns, 'turns', '$' + result.totalCostUsd.toFixed(4));
  } catch (err) {
    console.error('[run] ERROR', runId, err);
    try { updateRunCompleted(runId, { status: 'failed', completed_at: new Date().toISOString(), error: String(err), total_tokens_in: 0, total_tokens_out: 0, total_cost_usd: 0, total_turns: 0, duration_ms: 0 }); } catch {}
    try { await cleanupKB(kb); } catch {}
  }
}

const PORT = Number(process.env.PORT ?? 3032);
console.log(`[model-lab] Starting on port ${PORT}, API key: ${process.env.OPENROUTER_API_KEY ? 'SET' : 'MISSING'}`);
serve({ fetch: app.fetch, port: PORT });
