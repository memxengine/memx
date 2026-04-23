import { config } from 'dotenv';
config({ path: import.meta.dir + '/../../.env' });

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { startRun, startBatchRun, AVAILABLE_MODELS } from './runner';
import { listRuns, getRun, getTurnLogs, getQualityScores, getRunsBySource } from './db';

const app = new Hono();

app.use('/api/*', cors());

app.get('/api/v1/models', (c) => {
  return c.json({
    models: AVAILABLE_MODELS.map((id) => {
      const pricing: Record<string, { input: number; output: number; label: string }> = {
        'google/gemini-2.5-flash': { input: 0.30, output: 2.50, label: 'Gemini 2.5 Flash' },
        'qwen/qwen3-8b': { input: 0.05, output: 0.40, label: 'Qwen3 8B' },
        'qwen/qwen3.6-plus': { input: 0.325, output: 1.95, label: 'Qwen3.6 Plus' },
        'z-ai/glm-5.1': { input: 1.05, output: 3.50, label: 'GLM-5.1' },
        'anthropic/claude-sonnet-4-6': { input: 3.0, output: 15.0, label: 'Claude Sonnet 4.6' },
        'anthropic/claude-haiku-4-5-20251001': { input: 0.80, output: 4.0, label: 'Claude Haiku 4.5' },
      };
      const p = pricing[id] ?? { input: 0, output: 0, label: id };
      return { id, ...p };
    }),
  });
});

app.post('/api/v1/runs', async (c) => {
  const body = await c.req.json<{
    model?: string;
    models?: string[];
    sourceFilePath: string;
    maxTurns?: number;
    temperature?: number;
  }>();

  if (!body.sourceFilePath) {
    return c.json({ error: 'sourceFilePath is required' }, 400);
  }

  if (body.models && Array.isArray(body.models)) {
    const runIds = await startBatchRun({
      models: body.models,
      sourceFilePath: body.sourceFilePath,
      maxTurns: body.maxTurns,
      temperature: body.temperature,
    });
    return c.json({ runIds }, 201);
  }

  if (!body.model) {
    return c.json({ error: 'model or models is required' }, 400);
  }

  const runId = await startRun({
    model: body.model,
    sourceFilePath: body.sourceFilePath,
    maxTurns: body.maxTurns,
    temperature: body.temperature,
  });
  return c.json({ runId }, 201);
});

app.get('/api/v1/runs', (c) => {
  const limit = Number(c.req.query('limit') ?? 50);
  const runs = listRuns(limit);
  return c.json({ runs });
});

app.get('/api/v1/runs/compare', (c) => {
  const source = c.req.query('source');
  if (!source) return c.json({ error: 'source query param required' }, 400);
  const runs = getRunsBySource(source);
  return c.json({ runs });
});

app.get('/api/v1/runs/:id', (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json({ run });
});

app.get('/api/v1/runs/:id/turns', (c) => {
  const turns = getTurnLogs(c.req.param('id'));
  return c.json({ turns });
});

app.get('/api/v1/runs/:id/scores', (c) => {
  const scores = getQualityScores(c.req.param('id'));
  return c.json({ scores });
});

app.post('/api/v1/upload', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ error: 'No file uploaded' }, 400);

  const uploadDir = `${import.meta.dir}/../../data/uploads`;
  const { mkdir } = await import('node:fs/promises');
  await mkdir(uploadDir, { recursive: true });

  const filename = `${Date.now()}-${file.name}`;
  const filePath = `${uploadDir}/${filename}`;
  await Bun.write(filePath, file);

  return c.json({ path: filePath, filename, size: file.size }, 201);
});

process.on('uncaughtException', (err) => {
  console.error('[model-lab] UNCAUGHT:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[model-lab] UNHANDLED REJECTION:', err);
});

const PORT = Number(process.env.PORT ?? 3032);

console.log(`[model-lab] Starting on port ${PORT}`);
console.log(`[model-lab] OpenRouter API key: ${process.env.OPENROUTER_API_KEY ? 'configured' : 'MISSING'}`);

Bun.serve({ port: PORT, fetch: app.fetch });
