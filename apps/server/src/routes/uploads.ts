import { Hono } from 'hono';
import { db, documents, knowledgeBases } from '@memx/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth, getUser, getTenant } from '../middleware/auth.js';
import { storage, sourcePath } from '../lib/storage.js';
import { chunkText, storeChunks } from '../services/chunker.js';
import { triggerIngest } from '../services/ingest.js';

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
  const user = getUser(c);
  const tenant = getTenant(c);
  const kbId = c.req.param('kbId');

  const kb = db
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

  db.insert(documents)
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
    db.update(documents)
      .set({ content, title, status: 'ready', version: 1 })
      .where(eq(documents.id, docId))
      .run();

    if (content.trim()) {
      const chunks = chunkText(content);
      storeChunks(docId, tenant.id, kbId, chunks);
    }
  }

  // PDF / image / office extraction happens in the pipelines package (added in a
  // later task). Binary uploads land with status='pending' until a pipeline picks
  // them up.

  const doc = db.select().from(documents).where(eq(documents.id, docId)).get();

  // Auto-trigger wiki ingest for text sources that are ready to compile.
  if (isText) {
    triggerIngest({ docId, kbId, tenantId: tenant.id, userId: user.id });
  }

  return c.json(doc, 201);
});

function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
