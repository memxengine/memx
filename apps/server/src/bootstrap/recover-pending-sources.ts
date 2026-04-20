/**
 * Boot-time recovery for source documents stuck in `status='pending'`.
 *
 * Two ways a source ends up here:
 *
 *  1. Uploaded before the extractor for its file type existed (e.g. a
 *     PPTX uploaded before the PPTX pipeline shipped). `status` stays
 *     `pending` forever because nothing picks it up post-upload.
 *
 *  2. The server crashed mid-extraction after accepting the upload but
 *     before `status` transitioned to `processing`. Rare, but survives
 *     a volume restore so worth covering.
 *
 * This bootstrap walks every `status='pending'` source with a supported
 * file type and re-runs the appropriate `process{X}Async` helper in the
 * background. Fire-and-forget — the helpers themselves handle error →
 * status='failed' transitions. Safe to run every boot: once all docs
 * are `ready` / `failed` this is a no-op.
 *
 * Unsupported types (doc/ppt legacy Office, xls, png/jpg, ...) stay
 * pending — they have no pipeline to invoke. Surface to the curator
 * via the source-panel's status badge.
 */
import { documents, type TrailDatabase } from '@trail/db';
import { and, eq, inArray } from 'drizzle-orm';
import {
  processPdfAsync,
  processDocxAsync,
  processPptxAsync,
  processXlsxAsync,
} from '../routes/uploads.js';
import { storage, sourcePath } from '../lib/storage.js';

// Extensions whose extraction helpers exist. Adding a new pipeline
// means adding its ext here + the dispatcher branch below. Keep both
// lists in sync.
const RECOVERABLE_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx'] as const;

export async function recoverPendingSources(trail: TrailDatabase): Promise<void> {
  const rows = await trail.db
    .select({
      id: documents.id,
      tenantId: documents.tenantId,
      knowledgeBaseId: documents.knowledgeBaseId,
      userId: documents.userId,
      filename: documents.filename,
      fileType: documents.fileType,
    })
    .from(documents)
    .where(
      and(
        eq(documents.kind, 'source'),
        eq(documents.status, 'pending'),
        eq(documents.archived, false),
        inArray(documents.fileType, RECOVERABLE_EXTENSIONS as unknown as string[]),
      ),
    )
    .all();

  if (rows.length === 0) return;

  console.log(
    `  recover-pending-sources: ${rows.length} source${rows.length === 1 ? '' : 's'} in pending state with supported extractor — triggering`,
  );

  for (const r of rows) {
    const bytes = await storage.get(
      sourcePath(r.tenantId, r.knowledgeBaseId, r.id, r.fileType),
    );
    if (!bytes) {
      console.warn(
        `  recover-pending-sources: bytes missing for ${r.filename} (${r.id.slice(0, 8)}…) — marking failed`,
      );
      await trail.db
        .update(documents)
        .set({
          status: 'failed',
          errorMessage: 'Source bytes not found in storage during boot recovery',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(documents.id, r.id))
        .run();
      continue;
    }
    const buffer = Buffer.from(bytes);
    // The UserId column is nullable on legacy rows — fall back to
    // r.tenantId as the closest available actor id so the downstream
    // candidate-creation step doesn't choke on null. A real curator
    // UID isn't available at boot without guessing.
    const userId = r.userId ?? r.tenantId;
    const args = [trail, r.id, r.tenantId, r.knowledgeBaseId, userId, r.filename, buffer] as const;

    const dispatch = (): Promise<void> => {
      switch (r.fileType) {
        case 'pdf':
          return processPdfAsync(...args);
        case 'docx':
          return processDocxAsync(...args);
        case 'pptx':
          return processPptxAsync(...args);
        case 'xlsx':
          return processXlsxAsync(...args);
        default:
          return Promise.resolve();
      }
    };

    // Fire-and-forget. Each helper already sets status='failed' with
    // errorMessage on its own catch path. We just log here so a boot
    // log sweep shows exactly what recovered.
    dispatch().catch((err) => {
      console.error(
        `  recover-pending-sources: ${r.filename} failed during recovery:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
}
