/**
 * reprocess-source — re-run the pipeline on a source document.
 *
 * Mirrors what `POST /api/v1/documents/:docId/reprocess` does, but
 * callable from the command line. Useful when:
 *   - you fixed the pipeline and need to retry a previously failed source
 *     without clicking through the admin
 *   - you're debugging ingestion against a specific real document
 *
 * Pass either a docId or a filename-substring match. If the substring
 * matches more than one row the script lists them and exits — pick one.
 *
 *   bun run apps/server/scripts/reprocess-source.ts <docId>
 *   bun run apps/server/scripts/reprocess-source.ts Øreakupunktur_DIFZT_2025
 */
import { createLibsqlDatabase, DEFAULT_DB_PATH, documents } from '@trail/db';
import { eq, like, or } from 'drizzle-orm';
import { processPdfAsync, processDocxAsync } from '../src/routes/uploads.js';
import { storage, sourcePath } from '../src/lib/storage.js';

const needle = process.argv[2];
if (!needle) {
  console.error('Usage: bun run scripts/reprocess-source.ts <docId-or-filename-substring>');
  process.exit(1);
}

const trail = await createLibsqlDatabase({ path: DEFAULT_DB_PATH });

const matches = await trail.db
  .select()
  .from(documents)
  .where(
    or(
      eq(documents.id, needle),
      like(documents.filename, `%${needle}%`),
    ),
  )
  .all();

const sources = matches.filter((d) => d.kind === 'source');
if (sources.length === 0) {
  console.error(`No source documents match "${needle}".`);
  process.exit(1);
}
if (sources.length > 1) {
  console.error(`Ambiguous — ${sources.length} sources match "${needle}":`);
  for (const s of sources) {
    console.error(`  ${s.id}  ${s.filename}  [${s.status}]`);
  }
  process.exit(1);
}

const doc = sources[0]!;
console.log(`Reprocessing ${doc.id} — ${doc.filename} (was ${doc.status})`);

const bytes = await storage.get(sourcePath(doc.tenantId, doc.knowledgeBaseId, doc.id, doc.fileType));
if (!bytes) {
  console.error(`Source bytes missing from storage — re-upload required.`);
  process.exit(1);
}
const buffer = Buffer.from(bytes);

await trail.db
  .update(documents)
  .set({ status: 'processing', errorMessage: null, updatedAt: new Date().toISOString() })
  .where(eq(documents.id, doc.id))
  .run();

const started = Date.now();
try {
  if (doc.fileType === 'pdf') {
    await processPdfAsync(trail, doc.id, doc.tenantId, doc.knowledgeBaseId, doc.userId, doc.filename, buffer);
  } else if (doc.fileType === 'docx') {
    await processDocxAsync(trail, doc.id, doc.tenantId, doc.knowledgeBaseId, doc.userId, doc.filename, buffer);
  } else {
    console.error(`No reprocess pipeline for .${doc.fileType} (supported: pdf, docx).`);
    process.exit(1);
  }
  console.log(`Reprocessed in ${Date.now() - started}ms — status=ready`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Pipeline failed after ${Date.now() - started}ms: ${msg}`);
  await trail.db
    .update(documents)
    .set({ status: 'failed', errorMessage: msg.slice(0, 1000), updatedAt: new Date().toISOString() })
    .where(eq(documents.id, doc.id))
    .run();
  process.exit(1);
}
