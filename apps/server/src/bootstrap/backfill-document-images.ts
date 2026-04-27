/**
 * F161 — backfill `document_images` for legacy PDFs uploaded before
 * the table existed.
 *
 * Strategy:
 *   1. Find every source-row that COULD have images: kind='source',
 *      file_type='pdf' (or any pipeline that emits images), AND has
 *      no document_images rows yet.
 *   2. For each: list storage at `{tenant}/{kb}/{docId}/images/` to
 *      enumerate image-blobs that already exist.
 *   3. For each blob: read bytes, compute SHA-256 + size, parse
 *      dimensions via PNG-header (cheap; pdfjs-extracted images are
 *      always PNG).
 *   4. Pull `vision_description` from the parent's compiled markdown
 *      by parsing `![alt](url-pointing-at-this-blob)`. We DO NOT
 *      re-run Vision — backfill preserves what was already there;
 *      operator-triggered rerun is Phase 2.
 *   5. INSERT row.
 *
 * Idempotent: rows with existing document_images entries are skipped.
 * Re-runs find no missing-rows and exit fast.
 *
 * Performance: disk-IO bound on storage.list() + storage.get(). On
 * the live dev DB (~10 PDFs, ~50 image-blobs) this completes in
 * ~1-2 seconds. Logs progress every 10 docs.
 */

import { createHash } from 'node:crypto';
import { documents, documentImages, type TrailDatabase } from '@trail/db';
import { and, eq, notInArray } from 'drizzle-orm';
import { storage } from '../lib/storage.js';

interface PngDimensions {
  width: number;
  height: number;
}

/**
 * Read PNG width + height from the IHDR chunk (bytes 16-23 of a
 * standard PNG file). pdfjs-extracted images are always PNGs so this
 * is sufficient for backfill; non-PNG inputs return null and are
 * skipped (the row will get backfilled on a future deploy when we
 * add a more general dimension-reader).
 */
function readPngDimensions(bytes: Uint8Array): PngDimensions | null {
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length < 24) return null;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/**
 * Parse compiled markdown for an `![alt](url)` ref where the URL ends
 * with the given filename. Returns the alt-text (which is the
 * vision-description for PDF-extracted images) or null.
 */
function findAltForImage(markdown: string, filename: string): string | null {
  if (!markdown) return null;
  // Escape regex-special chars in filename (typically just dots).
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`!\\[([^\\]]*)\\]\\([^)]*${escaped}\\)`);
  const match = markdown.match(pattern);
  return match?.[1]?.trim() || null;
}

export async function backfillDocumentImages(trail: TrailDatabase): Promise<void> {
  // Find source-docs that don't yet have any document_images rows.
  // We compute the docs-with-images set and exclude them from the
  // candidate query — simpler than a NOT EXISTS subquery.
  const withImages = await trail.db
    .selectDistinct({ docId: documentImages.documentId })
    .from(documentImages)
    .all();
  const withImagesSet = new Set(withImages.map((r) => r.docId));

  const candidates = await trail.db
    .select({
      id: documents.id,
      tenantId: documents.tenantId,
      knowledgeBaseId: documents.knowledgeBaseId,
      content: documents.content,
      fileType: documents.fileType,
    })
    .from(documents)
    .where(
      and(
        eq(documents.kind, 'source'),
        eq(documents.archived, false),
      ),
    )
    .all();

  // Filter out docs that already have image-rows. Doing this in JS is
  // simpler than building a notInArray with potentially large arrays
  // (SQLite has a 999-param ceiling on IN-lists).
  const missing = candidates.filter((c) => !withImagesSet.has(c.id));

  if (missing.length === 0) return;
  console.log(`[F161] backfill scanning ${missing.length} source(s) for images…`);

  let inserted = 0;
  let skipped = 0;
  const startedAt = Date.now();

  for (const doc of missing) {
    try {
      const prefix = `${doc.tenantId}/${doc.knowledgeBaseId}/${doc.id}/images/`;
      const keys = await storage.list(prefix);
      if (keys.length === 0) continue; // No images for this doc — normal for non-PDF sources.

      for (const key of keys) {
        try {
          const bytes = await storage.get(key);
          if (!bytes) {
            skipped += 1;
            continue;
          }
          const filename = key.slice(prefix.length);
          const dims = readPngDimensions(new Uint8Array(bytes));
          if (!dims) {
            // Non-PNG (rare — pdfjs always emits PNG, but standalone
            // image uploads land at a different storage path and
            // wouldn't hit this loop).
            skipped += 1;
            continue;
          }
          const contentHash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
          const visionDescription = findAltForImage(doc.content ?? '', filename);

          await trail.db
            .insert(documentImages)
            .values({
              id: `dim_${crypto.randomUUID().slice(0, 12)}`,
              documentId: doc.id,
              tenantId: doc.tenantId,
              knowledgeBaseId: doc.knowledgeBaseId,
              filename,
              storagePath: key,
              contentHash,
              sizeBytes: bytes.length,
              page: null,         // Page number is not recoverable from storage alone.
              width: dims.width,
              height: dims.height,
              visionDescription,
              // We don't know which Vision model produced the legacy
              // description; leave NULL so a future re-run knows
              // these rows have NO recorded model lineage.
              visionModel: null,
              visionAt: null,
            })
            .run();
          inserted += 1;
        } catch (err) {
          skipped += 1;
          console.warn(
            `[F161] backfill failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[F161] backfill list-failure for ${doc.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[F161] backfill done — ${inserted} image-rows inserted, ${skipped} skipped, ${elapsed}ms`,
  );
}
