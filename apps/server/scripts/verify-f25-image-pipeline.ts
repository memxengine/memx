/**
 * F25 — end-to-end verification of the image + SVG pipeline.
 *
 * Two scenarios:
 *
 *  1. PNG upload → vision-LLM describe → markdown source + cost stamped
 *     on documents.extract_cost_cents. Uses Trail's own logo as the
 *     test image so the script is self-contained.
 *
 *  2. SVG upload → passthrough → markdown wraps the raw markup. Cost = 0
 *     (no LLM call). Uses one of Trail's diagram SVGs as the test asset.
 *
 * Probes the upload route directly via fetch instead of going through
 * the file picker. Cleans up the inserted test docs afterwards.
 *
 * Run: bun run apps/server/scripts/verify-f25-image-pipeline.ts
 *
 * Requires: trail engine running on :58021 with ANTHROPIC_API_KEY set.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLibsqlDatabase, DEFAULT_DB_PATH, documents } from '@trail/db';
import { eq, and, like } from 'drizzle-orm';

const ENGINE_URL = process.env.ENGINE_URL ?? 'http://127.0.0.1:58021';
const SESSION = process.env.TRAIL_SESSION ?? 'dev';
const KB_SLUG = process.env.PROBE_KB ?? 'development-tester';

let failures = 0;
function assert(label: string, cond: unknown, detail?: string): void {
  if (!cond) {
    failures++;
    console.error(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

const trail = await createLibsqlDatabase({ path: DEFAULT_DB_PATH });

async function uploadFile(path: string, mime: string, kbSlug: string): Promise<{ id: string; status: number }> {
  const buffer = readFileSync(path);
  const filename = path.split('/').pop()!;
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: mime }), filename);
  formData.append('tags', 'f25-probe');

  const res = await fetch(`${ENGINE_URL}/api/v1/knowledge-bases/${kbSlug}/documents/upload`, {
    method: 'POST',
    headers: { Cookie: `session=${SESSION}` },
    body: formData,
  });
  const data = (await res.json()) as { id?: string; error?: string };
  if (res.status !== 201 || !data.id) {
    throw new Error(`upload failed (${res.status}): ${data.error ?? 'unknown'}`);
  }
  return { id: data.id, status: res.status };
}

async function pollStatus(docId: string, target: 'ready' | 'failed', timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await trail.db
      .select({ status: documents.status, errorMessage: documents.errorMessage })
      .from(documents)
      .where(eq(documents.id, docId))
      .get();
    if (row?.status === target) return;
    if (row?.status === 'failed' && target !== 'failed') {
      throw new Error(`doc ${docId} went failed: ${row.errorMessage ?? 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`doc ${docId} did not reach ${target} within ${timeoutMs}ms`);
}

// ── Test 1: PNG upload + vision describe ──────────────────────────────
console.log('\n── Test 1: PNG upload (Trail logo) ──');
let pngDocId: string | null = null;
try {
  const pngPath = resolve(import.meta.dir, '../../../docs/assets/trail-logo-256.png');
  const { id } = await uploadFile(pngPath, 'image/png', KB_SLUG);
  pngDocId = id;
  console.log(`  uploaded → ${id}`);

  await pollStatus(id, 'ready', 60_000);

  const row = await trail.db
    .select({
      content: documents.content,
      title: documents.title,
      fileType: documents.fileType,
      extractCostCents: documents.extractCostCents,
    })
    .from(documents)
    .where(eq(documents.id, id))
    .get();

  assert('PNG reached status=ready', row !== undefined);
  assert('fileType = png', row?.fileType === 'png');
  assert('content contains markdown description', (row?.content?.length ?? 0) > 50,
    `got ${row?.content?.length ?? 0} chars`);
  assert('content has H1 title', /^#\s+/m.test(row?.content ?? ''));
  assert('extract_cost_cents recorded (>0)',
    (row?.extractCostCents ?? 0) > 0,
    `got ${row?.extractCostCents}¢`);
  assert('extract cost is sensible (1-50¢ for one image)',
    (row?.extractCostCents ?? 0) >= 1 && (row?.extractCostCents ?? 0) <= 50,
    `got ${row?.extractCostCents}¢ — outside 1-50¢ range`);
  console.log(`  cost: ${row?.extractCostCents}¢, content: ${row?.content?.length} chars, title: "${row?.title}"`);
} catch (err) {
  failures++;
  console.error('✗ PNG test failed:', err instanceof Error ? err.message : err);
}

// ── Test 2: SVG passthrough ───────────────────────────────────────────
console.log('\n── Test 2: SVG upload (passthrough) ──');
let svgDocId: string | null = null;
try {
  const svgPath = resolve(import.meta.dir, '../../../docs/assets/tree_vs_associative_graph.svg');
  const { id } = await uploadFile(svgPath, 'image/svg+xml', KB_SLUG);
  svgDocId = id;
  console.log(`  uploaded → ${id}`);

  await pollStatus(id, 'ready', 30_000);

  const row = await trail.db
    .select({
      content: documents.content,
      fileType: documents.fileType,
      extractCostCents: documents.extractCostCents,
    })
    .from(documents)
    .where(eq(documents.id, id))
    .get();

  assert('SVG reached status=ready', row !== undefined);
  assert('fileType = svg', row?.fileType === 'svg');
  assert('content contains <svg> tag', (row?.content ?? '').includes('<svg'));
  assert('content has H1 title above SVG', /^#\s+/m.test(row?.content ?? ''));
  assert('extract_cost_cents = 0 (passthrough, no LLM)', (row?.extractCostCents ?? -1) === 0,
    `got ${row?.extractCostCents}¢ — should be 0`);
  console.log(`  cost: ${row?.extractCostCents}¢, content: ${row?.content?.length} chars`);
} catch (err) {
  failures++;
  console.error('✗ SVG test failed:', err instanceof Error ? err.message : err);
}

// ── Cleanup ───────────────────────────────────────────────────────────
console.log('\n── Cleanup ──');
const probeIds = [pngDocId, svgDocId].filter((x): x is string => x !== null);
if (probeIds.length > 0) {
  // Soft-archive instead of hard-delete so any cascade-creating
  // candidates aren't orphaned. Mark archived=1; the curator can
  // hard-delete via UI if desired.
  for (const id of probeIds) {
    await trail.db
      .update(documents)
      .set({ archived: true, updatedAt: new Date().toISOString() })
      .where(eq(documents.id, id))
      .run();
  }
  console.log(`  archived ${probeIds.length} probe doc(s)`);
}

await trail.close();

console.log(`\n${failures === 0 ? '✓ all passed' : `✗ ${failures} failures`}`);
if (failures > 0) process.exit(1);
