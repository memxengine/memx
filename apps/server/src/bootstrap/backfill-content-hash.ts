/**
 * F162 — backfill `documents.content_hash` for source-rows that
 * don't have one yet.
 *
 * Runs at boot, AFTER migrations have applied (so the column exists)
 * and BEFORE the HTTP server starts accepting requests (so a fresh
 * upload doesn't race the backfill on the same row).
 *
 * Idempotent: re-run on a fully-backfilled DB selects 0 rows and
 * exits in a single query. The first run after migration 0024 deploy
 * walks every legacy source-row and computes SHA-256 from storage.
 *
 * Performance: disk-IO bound on `storage.get()`, not CPU. Bun's
 * native crypto.createHash hits ~1 GB/s on Apple Silicon; storage
 * reads are sub-10ms per file from local disk. 100 sources × 50ms
 * worst-case = ~5 seconds. We log the count up-front so the
 * operator knows what's happening if startup pauses briefly.
 *
 * Failure mode: if `storage.get()` throws (file missing / permission)
 * we log + skip, leaving content_hash NULL. Next boot will retry. We
 * never block boot on a single broken row.
 */

import { createHash } from 'node:crypto';
import { documents, type TrailDatabase } from '@trail/db';
import { and, eq, isNull } from 'drizzle-orm';
import { storage, sourcePath } from '../lib/storage.js';

export async function backfillContentHash(trail: TrailDatabase): Promise<void> {
  const rows = await trail.db
    .select({
      id: documents.id,
      tenantId: documents.tenantId,
      knowledgeBaseId: documents.knowledgeBaseId,
      filename: documents.filename,
      fileType: documents.fileType,
    })
    .from(documents)
    .where(
      and(
        eq(documents.kind, 'source'),
        isNull(documents.contentHash),
        eq(documents.archived, false),
      ),
    )
    .all();

  if (rows.length === 0) return;
  console.log(`[F162] backfilling content_hash for ${rows.length} source(s)…`);

  let done = 0;
  let skipped = 0;
  const startedAt = Date.now();

  for (const row of rows) {
    try {
      // The source-blob path mirrors what uploads.ts wrote:
      // `{tenant}/{kb}/{docId}/source.{ext}`. fileType is the ext
      // column saved at upload time. If it's null on a legacy row
      // we fall back to parsing the filename.
      const ext =
        row.fileType ?? row.filename.split('.').pop()?.toLowerCase() ?? '';
      const path = sourcePath(row.tenantId, row.knowledgeBaseId, row.id, ext);
      const bytes = await storage.get(path);
      if (!bytes) {
        skipped += 1;
        console.warn(`[F162] backfill skip — no bytes at ${path} for ${row.id}`);
        continue;
      }
      const hash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
      await trail.db
        .update(documents)
        .set({ contentHash: hash })
        .where(eq(documents.id, row.id))
        .run();
      done += 1;
    } catch (err) {
      skipped += 1;
      console.warn(
        `[F162] backfill failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[F162] backfill done — ${done} hashed, ${skipped} skipped, ${elapsed}ms`,
  );
}
