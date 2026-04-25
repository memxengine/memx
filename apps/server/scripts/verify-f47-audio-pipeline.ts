/**
 * F47 — end-to-end verification of the audio transcription pipeline.
 *
 * Uploads Sanne's `Dit_3_minutters_pusterum.wav` (3 minutes of Danish
 * guided-meditation audio), polls until the doc reaches `ready`,
 * then asserts:
 *
 *   - Whisper transcription happened (content > 500 chars)
 *   - Auto-detected language is Danish
 *   - extract_cost_cents lands in [1, 5]¢ range (3 min × 0.6¢/min ≈ 2¢)
 *   - F28's processFileAsync reached the audio branch
 *
 * Fixture lookup order:
 *   1. apps/server/test-fixtures/sanne-pusterum.wav (copy in repo)
 *   2. ~/Documents/Projects/Sanne Andersen/SOUND/Dit_3_minutters_pusterum.wav
 *      (Christian's source — gitignored, machine-specific)
 *
 * Run: bun run apps/server/scripts/verify-f47-audio-pipeline.ts
 *
 * Requires: trail engine running on :58021 with OPENAI_API_KEY set.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createLibsqlDatabase, DEFAULT_DB_PATH, documents } from '@trail/db';
import { eq } from 'drizzle-orm';

const ENGINE_URL = process.env.ENGINE_URL ?? 'http://127.0.0.1:58021';
const SESSION = process.env.TRAIL_SESSION ?? 'dev';
const KB_SLUG = process.env.PROBE_KB ?? 'development-tester';

const FIXTURE_LOCAL = resolve(import.meta.dir, '../test-fixtures/sanne-pusterum.wav');
const FIXTURE_FALLBACK = resolve(
  homedir(),
  'Documents/Projects/Sanne Andersen/SOUND/Dit_3_minutters_pusterum.wav',
);

let failures = 0;
function assert(label: string, cond: unknown, detail?: string): void {
  if (!cond) {
    failures++;
    console.error(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

const fixturePath = existsSync(FIXTURE_LOCAL)
  ? FIXTURE_LOCAL
  : existsSync(FIXTURE_FALLBACK)
    ? FIXTURE_FALLBACK
    : null;

if (!fixturePath) {
  console.error(
    `✗ test fixture not found.\n` +
      `  Expected at:\n    ${FIXTURE_LOCAL}\n  or:\n    ${FIXTURE_FALLBACK}\n` +
      `  Either copy your test WAV to the repo path, or run from a machine that has Sanne's source folder.`,
  );
  process.exit(1);
}
console.log(`fixture: ${fixturePath}`);

const trail = await createLibsqlDatabase({ path: DEFAULT_DB_PATH });

async function uploadFile(path: string, mime: string, kbSlug: string): Promise<string> {
  const buffer = readFileSync(path);
  const filename = path.split('/').pop()!;
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: mime }), filename);
  formData.append('tags', 'f47-probe');

  const res = await fetch(`${ENGINE_URL}/api/v1/knowledge-bases/${kbSlug}/documents/upload`, {
    method: 'POST',
    headers: { Cookie: `session=${SESSION}` },
    body: formData,
  });
  const data = (await res.json()) as { id?: string; error?: string };
  if (res.status !== 201 || !data.id) {
    throw new Error(`upload failed (${res.status}): ${data.error ?? 'unknown'}`);
  }
  return data.id;
}

/**
 * Poll until extract phase completes (extract_cost_cents > 0 means
 * Whisper finished and stamped the cost). We don't wait for the full
 * ingest compile because that's F06's territory, not F47's — and
 * compiling 1200+ chars of Danish meditation text into Neurons takes
 * 30-90s which would bloat this probe unnecessarily.
 */
async function pollExtractDone(docId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await trail.db
      .select({
        status: documents.status,
        errorMessage: documents.errorMessage,
        extractCostCents: documents.extractCostCents,
      })
      .from(documents)
      .where(eq(documents.id, docId))
      .get();
    if (row?.status === 'failed') {
      throw new Error(`doc ${docId} went failed: ${row.errorMessage ?? 'unknown'}`);
    }
    // extract_cost_cents > 0 = Whisper completed and stamped cost.
    // status may now be 'processing' (ingest running) or 'ready'
    // (full pipeline done) — either way the audio extract is done.
    if ((row?.extractCostCents ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`doc ${docId} extract did not complete within ${timeoutMs}ms`);
}

console.log('\n── Test: 3-min Danish WAV transcription ──');
let docId: string | null = null;
try {
  console.log('  uploading...');
  docId = await uploadFile(fixturePath, 'audio/wav', KB_SLUG);
  console.log(`  doc=${docId}, polling for extract completion (Whisper takes ~5-15s for 3-min audio)...`);

  await pollExtractDone(docId, 60_000);

  const row = await trail.db
    .select({
      status: documents.status,
      content: documents.content,
      title: documents.title,
      fileType: documents.fileType,
      extractCostCents: documents.extractCostCents,
    })
    .from(documents)
    .where(eq(documents.id, docId))
    .get();

  assert('extract phase completed', row !== undefined);
  assert('fileType = wav', row?.fileType === 'wav');
  assert('status is processing or ready (not failed)',
    row?.status === 'processing' || row?.status === 'ready',
    `got status=${row?.status}`);
  assert('content > 500 chars (Danish transcription)',
    (row?.content?.length ?? 0) > 500,
    `got ${row?.content?.length ?? 0} chars`);
  assert('content has H1 title', /^#\s+/m.test(row?.content ?? ''));
  assert('content has language preamble (Sprog: danish/da/dansk)',
    /Sprog:\*{0,2}\s*(danish|da|dansk)/i.test(row?.content ?? ''),
    `language preamble missing — got first 200 chars: "${(row?.content ?? '').slice(0, 200)}"`);
  assert('extract_cost_cents in [1, 5]¢ range',
    (row?.extractCostCents ?? 0) >= 1 && (row?.extractCostCents ?? 0) <= 5,
    `got ${row?.extractCostCents}¢ — expected ~2¢ for 3 min × $0.006/min`);
  console.log(
    `  cost: ${row?.extractCostCents}¢, content: ${row?.content?.length} chars, title: "${row?.title}"`,
  );
  console.log(`  first 300 chars of transcription:\n    ${(row?.content ?? '').slice(0, 300).replace(/\n/g, '\n    ')}`);
} catch (err) {
  failures++;
  console.error('✗ test failed:', err instanceof Error ? err.message : err);
}

// Cleanup
if (docId) {
  await trail.db
    .update(documents)
    .set({ archived: true, updatedAt: new Date().toISOString() })
    .where(eq(documents.id, docId))
    .run();
  console.log('  archived probe doc');
}
await trail.close();

console.log(`\n${failures === 0 ? '✓ all passed' : `✗ ${failures} failures`}`);
if (failures > 0) process.exit(1);
