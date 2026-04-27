/**
 * F161 — persist image-metadata to `document_images` from pipeline
 * extraction results.
 *
 * The PDF pipeline (and the standalone image-pipeline) writes image
 * bytes to storage and returns an `ExtractedImage[]` array. Pre-F161
 * that array got embedded as alt-text in the compiled wiki-Neuron's
 * markdown and then forgotten. This service is the bridge that turns
 * the in-memory array into structured rows so /retrieve, image-search,
 * Vision-rerun, and audience-filter can all work off a single source
 * of truth.
 *
 * Idempotent per (document_id, filename): if the upload re-fires
 * (e.g. after a pipeline retry), we delete prior rows for the doc
 * before inserting fresh ones. Avoids duplicate rows on re-ingest
 * without making callers think about it.
 */

import { createHash } from 'node:crypto';
import { documentImages, type TrailDatabase } from '@trail/db';
import { eq } from 'drizzle-orm';
import { storage } from '../lib/storage.js';

export interface ExtractedImageRow {
  filename: string;
  storagePath: string;
  page?: number;
  width: number;
  height: number;
  description?: string;
}

export async function persistImagesFromExtraction(
  trail: TrailDatabase,
  docId: string,
  tenantId: string,
  kbId: string,
  extracted: ExtractedImageRow[],
  visionModel: string | null,
): Promise<{ inserted: number; skipped: number }> {
  if (extracted.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  // Re-running the same upload (manual reingest, recover-pending-sources
  // etc.) shouldn't multiply rows. Drop any prior rows for this doc and
  // insert fresh — the delete is FK-cascade-safe because no other table
  // references document_images.
  await trail.db.delete(documentImages).where(eq(documentImages.documentId, docId)).run();

  let inserted = 0;
  let skipped = 0;
  const visionAt = new Date().toISOString();

  for (const img of extracted) {
    try {
      const bytes = await storage.get(img.storagePath);
      if (!bytes) {
        skipped += 1;
        console.warn(`[F161] persist skip — no bytes at ${img.storagePath}`);
        continue;
      }
      const contentHash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
      await trail.db
        .insert(documentImages)
        .values({
          id: `dim_${crypto.randomUUID().slice(0, 12)}`,
          documentId: docId,
          tenantId,
          knowledgeBaseId: kbId,
          filename: img.filename,
          storagePath: img.storagePath,
          contentHash,
          sizeBytes: bytes.length,
          page: img.page ?? null,
          width: img.width,
          height: img.height,
          visionDescription: img.description?.trim() ?? null,
          visionModel: img.description ? visionModel : null,
          visionAt: img.description ? visionAt : null,
        })
        .run();
      inserted += 1;
    } catch (err) {
      skipped += 1;
      console.warn(
        `[F161] persist failed for ${img.filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { inserted, skipped };
}
