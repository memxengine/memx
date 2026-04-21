import { Hono } from 'hono';
import { documents, type TrailDatabase } from '@trail/db';
import { eq, sql } from 'drizzle-orm';
import { requireAuth, getUser, getTenant, getTrail } from '../middleware/auth.js';
import { processPdf, processDocx, processPptx, processXlsx } from '@trail/pipelines';
import { storage, sourcePath } from '../lib/storage.js';
import { chunkText, storeChunks } from '../services/chunker.js';
import { triggerIngest } from '../services/ingest.js';
import { createVisionBackend } from '../services/vision.js';
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
  'png', 'jpg', 'jpeg', 'webp', 'gif',
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

  // PDF → async pipeline: extract text, write page-N-img-N.png via storage,
  // optionally annotate each image with vision. When the pipeline finishes,
  // the document goes ready and ingest is triggered.
  if (ext === 'pdf') {
    processPdfAsync(trail, docId, tenant.id, kbId, user.id, file.name, buffer).catch(async (err) => {
      console.error(`[pdf] pipeline failed for ${file.name}:`, err);
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

  // .docx → async text extraction via mammoth. No images or page count.
  // Converts Word's styled XML to markdown and flows through the same
  // chunk-then-ingest path as PDFs.
  if (ext === 'docx') {
    processDocxAsync(trail, docId, tenant.id, kbId, user.id, file.name, buffer).catch(async (err) => {
      console.error(`[docx] pipeline failed for ${file.name}:`, err);
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

  // .pptx → officeparser walks the OOXML slide tree, one markdown
  // section per slide. Images dropped for v1.
  if (ext === 'pptx') {
    processPptxAsync(trail, docId, tenant.id, kbId, user.id, file.name, buffer).catch(async (err) => {
      console.error(`[pptx] pipeline failed for ${file.name}:`, err);
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

  // .xlsx → SheetJS reads every sheet, converts to markdown tables.
  // Multi-sheet workbooks emit one `## Sheet: <name>` block per sheet.
  if (ext === 'xlsx') {
    processXlsxAsync(trail, docId, tenant.id, kbId, user.id, file.name, buffer).catch(async (err) => {
      console.error(`[xlsx] pipeline failed for ${file.name}:`, err);
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

  // Remaining binary types (doc/ppt legacy Office, xls, images, …)
  // still land with status='pending'. Legacy formats need separate
  // libraries; images need a vision pass that's not wired yet.

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

export async function processPdfAsync(
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

  console.log(`[pdf] processing ${filename}...`);
  const result = await withTimeout(
    processPdf({
      pdfBytes: buffer,
      storage,
      imagePrefix: `${tenantId}/${kbId}/${docId}/images`,
      imageUrlPrefix: `/api/v1/documents/${docId}/images`,
      describe: createVisionBackend() ?? undefined,
    }),
    PDF_TIMEOUT_MS,
    `pdf extract "${filename}"`,
  );
  const describedCount = result.images.filter((i) => i.description).length;
  console.log(
    `[pdf] ${filename}: ${result.pageCount} pages, ${result.images.length} images ` +
      `(${describedCount} described)`,
  );

  const title = filename.replace(/\.pdf$/i, '');
  await trail.db
    .update(documents)
    .set({
      content: result.markdown,
      title,
      pageCount: result.pageCount,
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

export async function processDocxAsync(
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

  console.log(`[docx] processing ${filename}...`);
  const result = await withTimeout(
    processDocx({ docxBytes: buffer }),
    DOCX_TIMEOUT_MS,
    `docx extract "${filename}"`,
  );
  if (result.warnings.length) {
    console.log(`[docx] ${filename}: ${result.warnings.length} conversion warnings`);
  }

  const title = result.title ?? filename.replace(/\.docx$/i, '');
  await trail.db
    .update(documents)
    .set({
      content: result.markdown,
      title,
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

export async function processPptxAsync(
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

  console.log(`[pptx] processing ${filename}...`);
  const result = await withTimeout(
    processPptx({ pptxBytes: buffer }),
    PPTX_TIMEOUT_MS,
    `pptx extract "${filename}"`,
  );
  console.log(`[pptx] ${filename}: ${result.slideCount} slide${result.slideCount === 1 ? '' : 's'} extracted`);

  const title = result.title ?? filename.replace(/\.pptx$/i, '');
  await trail.db
    .update(documents)
    .set({
      content: result.markdown,
      title,
      pageCount: result.slideCount,
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

export async function processXlsxAsync(
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

  console.log(`[xlsx] processing ${filename}...`);
  const result = await withTimeout(
    processXlsx({ xlsxBytes: buffer, filename }),
    XLSX_TIMEOUT_MS,
    `xlsx extract "${filename}"`,
  );
  console.log(`[xlsx] ${filename}: ${result.sheetCount} sheet${result.sheetCount === 1 ? '' : 's'} extracted`);

  const title = result.title ?? filename.replace(/\.xlsx$/i, '');
  await trail.db
    .update(documents)
    .set({
      content: result.markdown,
      title,
      pageCount: result.sheetCount,
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

function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
