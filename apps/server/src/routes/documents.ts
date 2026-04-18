import { Hono } from 'hono';
import { documents, knowledgeBases, documentChunks, wikiEvents, queueCandidates } from '@trail/db';
import {
  CreateNoteSchema,
  UpdateDocumentSchema,
  UpdateContentSchema,
  BulkDeleteSchema,
  DocumentKindEnum,
} from '@trail/shared';
import { eq, and, inArray, asc, desc, type SQL } from 'drizzle-orm';
import { submitCuratorEdit, VersionConflictError } from '@trail/core';
import { requireAuth, getUser, getTenant, getTrail } from '../middleware/auth.js';
import { chunkText, storeChunks } from '../services/chunker.js';
import { processPdfAsync, processDocxAsync } from './uploads.js';
import { triggerIngest } from '../services/ingest.js';
import { storage, sourcePath } from '../lib/storage.js';

/**
 * Order-clause builder for the documents list. Keeps the route handler
 * readable and the sort vocabulary centralized — if a new option ships,
 * it lands here and the API query param picks it up without further
 * plumbing. Falls back to `newest` when the client passes an unknown
 * value rather than erroring: unknown input = reasonable default.
 */
function orderClauseFor(sort: string): SQL[] {
  switch (sort) {
    case 'oldest':
      return [asc(documents.createdAt)];
    case 'title':
      return [asc(documents.title), asc(documents.createdAt)];
    case 'updated':
    case 'newest':
    default:
      return [desc(documents.updatedAt), desc(documents.createdAt)];
  }
}

export const documentRoutes = new Hono();

documentRoutes.use('*', requireAuth);

documentRoutes.get('/knowledge-bases/:kbId/documents', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = c.req.param('kbId');
  const path = c.req.query('path');
  const kindParam = c.req.query('kind');
  const archivedParam = c.req.query('archived'); // 'true' | 'false' | 'all'
  // Sort preference. Default 'newest' (updatedAt DESC) — the most
  // useful order for a living knowledge base is "what changed most
  // recently". `oldest` keeps the previous default behaviour for
  // callers that want it; `title` is alphabetical by title.
  const sortParam = c.req.query('sort') ?? 'newest';

  const conditions = [
    eq(documents.tenantId, tenant.id),
    eq(documents.knowledgeBaseId, kbId),
  ];

  // Archive filter. Default (no param) = active only (archived=false) so
  // existing callers don't need to change. Explicit 'all' skips the
  // filter; 'true' shows only archived docs.
  if (archivedParam !== 'all') {
    conditions.push(eq(documents.archived, archivedParam === 'true'));
  }

  if (path) conditions.push(eq(documents.path, path));

  if (kindParam) {
    const kind = DocumentKindEnum.safeParse(kindParam);
    if (!kind.success) return c.json({ error: 'Invalid kind' }, 400);
    conditions.push(eq(documents.kind, kind.data));
  }

  const rows = await trail.db
    .select({
      id: documents.id,
      tenantId: documents.tenantId,
      knowledgeBaseId: documents.knowledgeBaseId,
      userId: documents.userId,
      kind: documents.kind,
      filename: documents.filename,
      title: documents.title,
      path: documents.path,
      fileType: documents.fileType,
      fileSize: documents.fileSize,
      status: documents.status,
      pageCount: documents.pageCount,
      tags: documents.tags,
      date: documents.date,
      metadata: documents.metadata,
      errorMessage: documents.errorMessage,
      version: documents.version,
      sortOrder: documents.sortOrder,
      archived: documents.archived,
      isCanonical: documents.isCanonical,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(and(...conditions))
    .orderBy(...orderClauseFor(sortParam))
    .all();

  return c.json(rows);
});

documentRoutes.get('/documents/:docId', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const docId = c.req.param('docId');

  const doc = await trail.db
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();

  if (!doc) return c.json({ error: 'Not found' }, 404);
  return c.json(doc);
});

/**
 * F95 — Neuron provenance lookup. Returns the ingestion connector that
 * produced this Neuron, plus the first candidate + creation timestamp.
 * Walks `wiki_events` back to the initial `created` event, reads its
 * `sourceCandidateId`, then reads that candidate's metadata.connector.
 *
 * Surfaces in the admin's Neuron reader as a "Created via" panel under
 * the tag row. Missing data (e.g. legacy Neurons without a source
 * candidate) degrades to `connector: null` rather than erroring.
 */
documentRoutes.get('/documents/:docId/provenance', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const docId = c.req.param('docId');

  const doc = await trail.db
    .select({ id: documents.id, createdAt: documents.createdAt, userId: documents.userId })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();
  if (!doc) return c.json({ error: 'Not found' }, 404);

  const firstEvent = await trail.db
    .select({
      sourceCandidateId: wikiEvents.sourceCandidateId,
      actorKind: wikiEvents.actorKind,
      actorId: wikiEvents.actorId,
      createdAt: wikiEvents.createdAt,
    })
    .from(wikiEvents)
    .where(
      and(
        eq(wikiEvents.tenantId, tenant.id),
        eq(wikiEvents.documentId, docId),
        eq(wikiEvents.eventType, 'created'),
      ),
    )
    .orderBy(asc(wikiEvents.createdAt))
    .limit(1)
    .get();

  let connector: string | null = null;
  let candidateId: string | null = null;
  let confidence: number | null = null;

  if (firstEvent?.sourceCandidateId) {
    candidateId = firstEvent.sourceCandidateId;
    const candidate = await trail.db
      .select({
        metadata: queueCandidates.metadata,
        confidence: queueCandidates.confidence,
      })
      .from(queueCandidates)
      .where(
        and(
          eq(queueCandidates.id, firstEvent.sourceCandidateId),
          eq(queueCandidates.tenantId, tenant.id),
        ),
      )
      .get();
    if (candidate?.metadata) {
      try {
        const parsed = JSON.parse(candidate.metadata) as { connector?: unknown };
        if (typeof parsed.connector === 'string') connector = parsed.connector;
      } catch {
        // fall through — connector stays null
      }
    }
    confidence = candidate?.confidence ?? null;
  }

  return c.json({
    documentId: doc.id,
    connector,
    candidateId,
    confidence,
    createdAt: firstEvent?.createdAt ?? doc.createdAt,
    actorKind: firstEvent?.actorKind ?? null,
    actorId: firstEvent?.actorId ?? doc.userId,
  });
});

documentRoutes.get('/documents/:docId/content', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const docId = c.req.param('docId');

  const doc = await trail.db
    .select({ id: documents.id, content: documents.content, version: documents.version })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();

  if (!doc) return c.json({ error: 'Not found' }, 404);
  return c.json(doc);
});

// NOTE (F17): this endpoint currently writes directly to documents where
// kind='wiki'. It is not exercised by any active caller today. When the admin
// UI (F18 Session 2) starts using it, re-route through the queue's
// createCandidate + auto-approve path so the "sole wiki write path" invariant
// is enforced from this endpoint too.
documentRoutes.post('/knowledge-bases/:kbId/documents/note', async (c) => {
  const trail = getTrail(c);
  const user = getUser(c);
  const tenant = getTenant(c);
  const kbId = c.req.param('kbId');
  const body = CreateNoteSchema.parse(await c.req.json());

  const kb = await trail.db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .get();
  if (!kb) return c.json({ error: 'Knowledge base not found' }, 404);

  const id = crypto.randomUUID();
  const title = extractTitle(body.content) ?? body.filename.replace(/\.md$/, '');

  await trail.db
    .insert(documents)
    .values({
      id,
      tenantId: tenant.id,
      knowledgeBaseId: kbId,
      userId: user.id,
      kind: 'wiki',
      filename: body.filename,
      title,
      path: body.path,
      fileType: 'md',
      status: 'ready',
      content: body.content,
      version: 1,
    })
    .run();

  if (body.content.trim()) {
    const chunks = chunkText(body.content);
    await storeChunks(trail, id, tenant.id, kbId, chunks);
  }

  const doc = await trail.db.select().from(documents).where(eq(documents.id, id)).get();
  return c.json(doc, 201);
});

// F91 — curator Neuron edit. Routes through the queue via
// `submitCuratorEdit` so F17's "queue is the sole wiki write path"
// invariant holds. See packages/core/src/queue/candidates.ts for the
// full rationale on why this is NOT an F19 auto-approval.
documentRoutes.put('/documents/:docId/content', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const docId = c.req.param('docId');
  const body = UpdateContentSchema.parse(await c.req.json());

  try {
    const result = await submitCuratorEdit(
      trail,
      tenant.id,
      docId,
      {
        content: body.content,
        title: body.title,
        tags: body.tags,
        expectedVersion: body.expectedVersion,
      },
      { id: user.id, kind: 'user' },
    );

    // Chunk-rebuild for search. Kept outside the tx because chunking
    // can be slow and the write must be durable whether or not chunks
    // repopulate; a failed chunk rebuild only hurts search, not data.
    await trail.db.delete(documentChunks).where(eq(documentChunks.documentId, docId)).run();
    if (body.content.trim()) {
      const doc = await trail.db
        .select({ knowledgeBaseId: documents.knowledgeBaseId })
        .from(documents)
        .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
        .get();
      if (doc) {
        const chunks = chunkText(body.content);
        await storeChunks(trail, docId, tenant.id, doc.knowledgeBaseId, chunks);
      }
    }

    return c.json({
      id: docId,
      version: result.documentId ? await currentVersion(trail, docId) : body.expectedVersion + 1,
      wikiEventId: result.wikiEventId,
    });
  } catch (err) {
    if (err instanceof VersionConflictError) {
      return c.json(
        {
          error: 'version_conflict',
          message: err.message,
          currentVersion: err.currentVersion,
          expectedVersion: err.expectedVersion,
        },
        409,
      );
    }
    if (err instanceof Error && /not found/i.test(err.message)) {
      return c.json({ error: 'Not found' }, 404);
    }
    throw err;
  }
});

async function currentVersion(
  trail: ReturnType<typeof getTrail>,
  docId: string,
): Promise<number> {
  const row = await trail.db
    .select({ version: documents.version })
    .from(documents)
    .where(eq(documents.id, docId))
    .get();
  return row?.version ?? 0;
}

documentRoutes.patch('/documents/:docId', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const docId = c.req.param('docId');
  const body = UpdateDocumentSchema.parse(await c.req.json());

  const existing = await trail.db
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.filename !== undefined) updates.filename = body.filename;
  if (body.path !== undefined) updates.path = body.path;
  if (body.title !== undefined) updates.title = body.title;
  if (body.tags !== undefined) updates.tags = body.tags;
  if (body.date !== undefined) updates.date = body.date;
  if (body.metadata !== undefined) updates.metadata = body.metadata;

  await trail.db.update(documents).set(updates).where(eq(documents.id, docId)).run();

  const doc = await trail.db.select().from(documents).where(eq(documents.id, docId)).get();
  return c.json(doc);
});

documentRoutes.delete('/documents/:docId', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const docId = c.req.param('docId');

  await trail.db
    .update(documents)
    .set({ archived: true, status: 'archived', updatedAt: new Date().toISOString() })
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .run();

  return c.body(null, 204);
});

/**
 * Restore an archived document — inverse of DELETE /documents/:docId.
 * Flips `archived=false` + resets status back to 'ready'. The curator's
 * undo path when they archived something by mistake; the archive row
 * reappears in the normal Sources list and is editable/indexable again.
 *
 * No-op for already-unarchived docs (idempotent) — safer than 409 when
 * two tabs race on the same row.
 */
documentRoutes.post('/documents/:docId/restore', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const docId = c.req.param('docId');

  const doc = await trail.db
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();
  if (!doc) return c.json({ error: 'Document not found' }, 404);

  await trail.db
    .update(documents)
    .set({ archived: false, status: 'ready', updatedAt: new Date().toISOString() })
    .where(eq(documents.id, docId))
    .run();

  return c.json({ id: docId, archived: false, status: 'ready' });
});

/**
 * Reprocess a source document — re-runs the appropriate ingest pipeline
 * against the already-uploaded bytes in storage. Useful when the original
 * ingest failed (engine died mid-compile, LLM error, etc.) and the curator
 * wants to retry without re-uploading.
 *
 * Text-only types (md/txt/html/csv) land status='ready' straight from the
 * first upload, so they never fail — they're not accepted here.
 */
documentRoutes.post('/documents/:docId/reprocess', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const docId = c.req.param('docId');

  const doc = await trail.db
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();

  if (!doc) return c.json({ error: 'Document not found' }, 404);
  if (doc.kind !== 'source') {
    return c.json({ error: 'Only source documents can be reprocessed' }, 400);
  }

  const bytes = await storage.get(sourcePath(doc.tenantId, doc.knowledgeBaseId, doc.id, doc.fileType));
  if (!bytes) {
    return c.json({ error: 'Source bytes not found in storage — re-upload instead' }, 404);
  }
  const buffer = Buffer.from(bytes);

  // Reset status so the admin badge and Sources UI reflect "in progress"
  // before the async pipeline kicks off.
  await trail.db
    .update(documents)
    .set({ status: 'processing', errorMessage: null, updatedAt: new Date().toISOString() })
    .where(eq(documents.id, doc.id))
    .run();

  // Fire and forget — don't hold the HTTP connection for the LLM compile.
  const onFail = async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reprocess] pipeline failed for ${doc.filename}:`, msg);
    await trail.db
      .update(documents)
      .set({ status: 'failed', errorMessage: msg.slice(0, 1000), updatedAt: new Date().toISOString() })
      .where(eq(documents.id, doc.id))
      .run();
  };

  if (doc.fileType === 'pdf') {
    processPdfAsync(trail, doc.id, doc.tenantId, doc.knowledgeBaseId, user.id, doc.filename, buffer).catch(onFail);
  } else if (doc.fileType === 'docx') {
    processDocxAsync(trail, doc.id, doc.tenantId, doc.knowledgeBaseId, user.id, doc.filename, buffer).catch(onFail);
  } else {
    return c.json(
      { error: `No reprocess pipeline for .${doc.fileType}. Supported: pdf, docx.` },
      400,
    );
  }

  return c.json({ id: doc.id, status: 'processing' }, 202);
});

/**
 * Re-run ONLY the ingest step — the LLM-compile-to-wiki phase — without
 * re-running the file-format extract pipeline. Useful when extract
 * already produced good markdown (status was 'ready' at some point) but
 * wiki-compile failed or was interrupted (MCP entry missing, LLM rate
 * limit, engine restart mid-job, etc.). Re-extracting a big PDF when
 * only the ingest leg failed is wasted time + vision-API budget.
 *
 * Sibling of `/reprocess`. Same auth, same eventing. Differs in that
 * it doesn't touch `content`, `page_count`, or `file_size` — those
 * reflect the existing extract. Status flips to 'processing' while
 * triggerIngest runs async.
 */
documentRoutes.post('/documents/:docId/reingest', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const docId = c.req.param('docId');

  const doc = await trail.db
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();

  if (!doc) return c.json({ error: 'Document not found' }, 404);
  if (doc.kind !== 'source') {
    return c.json({ error: 'Only source documents can be reingested' }, 400);
  }
  if (!doc.content || !doc.content.trim()) {
    return c.json(
      { error: 'No extracted content to ingest — run /reprocess first' },
      400,
    );
  }
  // Idempotency — if a pipeline is already in flight for this source,
  // don't spawn a second. Rapid clicks on the "reingest" button would
  // otherwise double the LLM work + race on wiki writes.
  if (doc.status === 'processing') {
    return c.json({ id: doc.id, status: 'processing', alreadyRunning: true }, 202);
  }

  await trail.db
    .update(documents)
    .set({ status: 'processing', errorMessage: null, updatedAt: new Date().toISOString() })
    .where(eq(documents.id, doc.id))
    .run();

  triggerIngest({
    trail,
    docId: doc.id,
    kbId: doc.knowledgeBaseId,
    tenantId: doc.tenantId,
    userId: user.id,
  });

  return c.json({ id: doc.id, status: 'processing' }, 202);
});

documentRoutes.post('/documents/bulk-delete', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const body = BulkDeleteSchema.parse(await c.req.json());

  await trail.db
    .update(documents)
    .set({ archived: true, status: 'archived', updatedAt: new Date().toISOString() })
    .where(and(inArray(documents.id, body.ids), eq(documents.tenantId, tenant.id)))
    .run();

  return c.body(null, 204);
});

function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
