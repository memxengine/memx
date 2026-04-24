import { Hono } from 'hono';
import { documents, type TrailDatabase } from '@trail/db';
import { eq, sql } from 'drizzle-orm';
import { requireAuth, getUser, getTenant, getTrail } from '../middleware/auth.js';
import { processPdf, processDocx, processPptx, processXlsx, dispatch, pickPipeline } from '@trail/pipelines';
import { storage, sourcePath } from '../lib/storage.js';
import { chunkText, storeChunks } from '../services/chunker.js';
import { triggerIngest } from '../services/ingest.js';
import { createVisionBackend, describeImageAsSource } from '../services/vision.js';
import { resolveKbId } from '@trail/core';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
// Silent hangs in pdfjs-dist on malformed PDFs are the single worst failure
// mode — status='processing' forever, no error, no log, no exit. Cap the
// extraction step so a wedged PDF produces a normal 'failed' row the
// curator can retry or archive. Env overridable if someone legit has a
// 500-page PDF.
const PDF_TIMEOUT_MS = Number(process.env.TRAIL_PDF_TIMEOUT_MS ?? 120_000);
const DOCX_TIMEOUT_MS = Number(process.env.TRAIL_DOCX_TIMEOUT_MS ?? 60_000);
const PPTX_TIMEOUT_MS = Number(process.env.TRAIL_PPTX_TIMEOUT_MS ?? 90_000);
const XLSX_TIMEOUT_MS = Number(process.env.TRAIL_XLSX_TIMEOUT_MS ?? 60_000);
const IMAGE_TIMEOUT_MS = Number(process.env.TRAIL_IMAGE_TIMEOUT_MS ?? 30_000);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s — file may be malformed or too complex`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'docx', 'pptx', 'doc', 'ppt',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
  'html', 'htm', 'xlsx', 'xls', 'csv',
  'md', 'txt',
]);
const TEXT_EXTENSIONS = new Set(['md', 'txt', 'html', 'htm', 'csv']);

export const uploadRoutes = new Hono();

uploadRoutes.use('*', requireAuth);

uploadRoutes.post('/knowledge-bases/:kbId/documents/upload', async (c) => {
  const trail = getTrail(c);
  const user = getUser(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  const path = (formData.get('path') as string) ?? '/';
  const metadataRaw = formData.get('metadata') as string | null;

  let connector: string | undefined;
  let sourceUrl: string | undefined;
  let uploadTags: string[] | undefined;

  if (metadataRaw) {
    try {
      const meta = JSON.parse(metadataRaw);
      connector = meta.connector;
      sourceUrl = meta.sourceUrl;
      uploadTags = meta.tags;
    } catch {
      // Ignore malformed metadata
    }
  }

  if (!file) return c.json({ error: 'No file provided' }, 400);
  if (file.size > MAX_FILE_SIZE) return c.json({ error: 'File too large (max 100MB)' }, 413);

  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return c.json({ error: `File type .${ext} not allowed` }, 400);
  }

  const docId = crypto.randomUUID();
  const buffer = Buffer.from(await file.arrayBuffer());
  await storage.put(sourcePath(tenant.id, kbId, docId, ext), buffer, file.type);

  const isText = TEXT_EXTENSIONS.has(ext);
  const initialStatus = isText ? 'ready' : 'pending';

  await trail.db
    .insert(documents)
    .values({
      id: docId,
      tenantId: tenant.id,
      knowledgeBaseId: kbId,
      userId: user.id,
      kind: 'source',
      filename: file.name,
      path,
      fileType: ext,
      fileSize: file.size,
      status: initialStatus,
      tags: uploadTags?.join(', ') ?? null,
      metadata: connector ? JSON.stringify({ connector, sourceUrl }) : null,
      // F145 — inline per-KB seq (see candidates.ts for the same pattern).
      seq: sql<number>`COALESCE((SELECT MAX(${documents.seq}) FROM ${documents} WHERE ${documents.knowledgeBaseId} = ${kbId}), 0) + 1`,
    })
    .run();

  if (isText) {
    const content = new TextDecoder().decode(buffer);
    const title = ext === 'md' ? extractTitle(content) ?? file.name : file.name;
    // NOTE: we store the extracted content but leave status='processing'
    // (set below) rather than jumping straight to 'ready'. Text files
    // have no file-format-extract step so the row could technically
    // be 'ready' from upload, but the LLM compile (runIngest) still
    // has to fire and that's queued per-KB — with many uploads
    // landing at once, a curator would see "ready" on doc #65 while
    // its compile is still 30 minutes away in the queue. Status
    // 'processing' surfaces that honestly: runIngest transitions to
    // 'ready' when the compile actually completes.
    await trail.db
      .update(documents)
      .set({ content, title, status: 'processing', version: 1 })
      .where(eq(documents.id, docId))
      .run();

    if (content.trim()) {
      const chunks = chunkText(content);
      await storeChunks(trail, docId, tenant.id, kbId, chunks);
    }
  }

  // F28 — single dispatch call replaces the previous 4 ext-specific
  // if-blocks. Adding a new format (image, audio, video, email) is now
  // "register a Pipeline in @trail/pipelines"; uploads.ts doesn't change.
  // Legacy binary formats with no registered pipeline (xls, doc, raw
  // images pre-F25) still land status='pending' until handled.
  if (!isText && pickPipeline(file.name) !== null) {
    processFileAsync(trail, docId, tenant.id, kbId, user.id, file.name, buffer).catch(async (err) => {
      console.error(`[pipeline] failed for ${file.name}:`, err);
      await trail.db
        .update(documents)
        .set({
          status: 'failed',
          errorMessage: String(err).slice(0, 1000),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(documents.id, docId))
        .run();
    });
  }

  const doc = await trail.db
    .select()
    .from(documents)
    .where(eq(documents.id, docId))
    .get();

  // Auto-trigger wiki ingest for text sources that are ready to compile.
  if (isText) {
    triggerIngest({ trail, docId, kbId, tenantId: tenant.id, userId: user.id });
  }

  return c.json(doc, 201);
});

/**
 * F28 — unified file orchestrator. Replaces the per-format
 * `processPdfAsync` / `processDocxAsync` / `processPptxAsync` /
 * `processXlsxAsync` helpers — they all did the same status →
 * extract → store-chunks → trigger-ingest dance, just with different
 * extractors. Now the dispatch picks the right pipeline and the
 * shared body handles the rest.
 *
 * Adding a new format (F24 image, F47 audio, F46 video) means
 * registering a Pipeline in @trail/pipelines — no changes here.
 */
export async function processFileAsync(
  trail: TrailDatabase,
  docId: string,
  tenantId: string,
  kbId: string,
  userId: string,
  filename: string,
  buffer: Buffer,
): Promise<void> {
  await trail.db
    .update(documents)
    .set({ status: 'processing', updatedAt: new Date().toISOString() })
    .where(eq(documents.id, docId))
    .run();

  // PDF needs storage + describe; image-pipeline needs describeImageAsSource;
  // other formats ignore those fields.
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const timeoutMs = ext === 'pdf'
    ? PDF_TIMEOUT_MS
    : ext === 'pptx'
      ? PPTX_TIMEOUT_MS
      : ext === 'xlsx'
        ? XLSX_TIMEOUT_MS
        : ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif' || ext === 'svg'
          ? IMAGE_TIMEOUT_MS
          : DOCX_TIMEOUT_MS;

  const { pipeline, result } = await withTimeout(
    dispatch({
      buffer,
      filename,
      storage,
      imagePrefix: `${tenantId}/${kbId}/${docId}/images`,
      imageUrlPrefix: `/api/v1/documents/${docId}/images`,
      describeImage: createVisionBackend() ?? undefined,
      describeImageAsSource,
    }),
    timeoutMs,
    `${ext} extract "${filename}"`,
  );

  // Format-specific summary log. The pipeline.name lets us keep the
  // format prefix consistent with pre-F28 logs ("[pdf] foo.pdf: ...").
  if (pipeline.name === 'pdf' && result.images) {
    const describedCount = result.images.filter((i) => i.description).length;
    console.log(
      `[pdf] ${filename}: ${result.pageCount} pages, ${result.images.length} images ` +
        `(${describedCount} described)`,
    );
  } else if (pipeline.name === 'docx') {
    if (result.warnings.length) {
      console.log(`[docx] ${filename}: ${result.warnings.length} conversion warnings`);
    }
  } else if (pipeline.name === 'pptx') {
    console.log(`[pptx] ${filename}: ${result.slideCount} slide${result.slideCount === 1 ? '' : 's'} extracted`);
  } else if (pipeline.name === 'xlsx') {
    console.log(`[xlsx] ${filename}: ${result.sheetCount} sheet${result.sheetCount === 1 ? '' : 's'} extracted`);
  } else if (pipeline.name === 'image') {
    const cost = result.extractCostCents ?? 0;
    console.log(
      `[image] ${filename}: ${result.markdown.length} chars described, cost=${cost}¢` +
        (result.extractModel ? ` (${result.extractModel})` : ''),
    );
  }

  // Title — pipeline result first, then strip extension from filename.
  const stem = filename.replace(/\.[a-z0-9]+$/i, '');
  const title = result.title ?? stem;
  // pageCount column doubles as slideCount/sheetCount for non-PDF.
  const pageCount = result.pageCount ?? result.slideCount ?? result.sheetCount ?? null;
  // F25/F156 — stamp extract cost so credits-tracking can sum it later.
  const extractCostCents = result.extractCostCents ?? 0;

  await trail.db
    .update(documents)
    .set({
      content: result.markdown,
      title,
      ...(pageCount !== null ? { pageCount } : {}),
      ...(extractCostCents > 0 ? { extractCostCents } : {}),
      status: 'ready',
      version: 1,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(documents.id, docId))
    .run();

  if (result.markdown.trim()) {
    const chunks = chunkText(result.markdown);
    await storeChunks(trail, docId, tenantId, kbId, chunks);
  }

  triggerIngest({ trail, docId, kbId, tenantId, userId });
}

// ── Legacy shims (back-compat for recover-pending-sources.ts) ─────────
// All four helpers now route through processFileAsync; kept under the
// old names so existing callers don't break. Will be deleted once
// recover-pending-sources.ts is updated to call processFileAsync.

export const processPdfAsync = processFileAsync;
export const processDocxAsync = processFileAsync;
export const processPptxAsync = processFileAsync;
export const processXlsxAsync = processFileAsync;

function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
