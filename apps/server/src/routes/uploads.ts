import { Hono } from 'hono';
import { documents, knowledgeBases, type TrailDatabase } from '@trail/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth, getUser, getTenant, getTrail } from '../middleware/auth.js';
import { processPdf } from '@trail/pipelines';
import { storage, sourcePath } from '../lib/storage.js';
import { chunkText, storeChunks } from '../services/chunker.js';
import { triggerIngest } from '../services/ingest.js';
import { createVisionBackend } from '../services/vision.js';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
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
  const kbId = c.req.param('kbId');

  const kb = await trail.db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .get();
  if (!kb) return c.json({ error: 'Knowledge base not found' }, 404);

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
    })
    .run();

  if (isText) {
    const content = new TextDecoder().decode(buffer);
    const title = ext === 'md' ? extractTitle(content) ?? file.name : file.name;
    await trail.db
      .update(documents)
      .set({ content, title, status: 'ready', version: 1 })
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

  // Other binary uploads (office, images, …) land with status='pending' until
  // a pipeline picks them up.

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

async function processPdfAsync(
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
  const result = await processPdf({
    pdfBytes: buffer,
    storage,
    imagePrefix: `${tenantId}/${kbId}/${docId}/images`,
    imageUrlPrefix: `/api/v1/documents/${docId}/images`,
    describe: createVisionBackend() ?? undefined,
  });
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

function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
