/**
 * F164 Phase 2 — vision-rerun job handler.
 *
 * Generalises the synchronous loop that lived in
 * `routes/documents.ts:/rerun-vision` into a background-job handler.
 * Per-image concurrency = 4 via pLimit so 224 images take ~56s instead
 * of ~750s sequential. Progress reported per-image so the SSE channel
 * (and admin progress modal in Phase 4) sees live updates.
 *
 * Idempotency: filters on `vision_description IS NULL` — already-
 * described rows are skipped. Resume after crash picks up where it
 * left off automatically.
 *
 * Failure semantics:
 *   - Per-image failures stamp `vision_at` (mark scanned) but leave
 *     description NULL. They count toward `failed`. Operator can re-
 *     run; the NULL-filter still picks them up because vision_at-set-
 *     but-description-NULL means "tried but failed", and we do NOT
 *     skip those — only `vision_description IS NOT NULL` skips.
 *   - "Decorative" sentinel from Vision (model says "this image has no
 *     content worth describing") stamps vision_at + vision_model
 *     without description and counts toward `decorative`. NULL-filter
 *     would re-process these on re-run; that's fine — same answer.
 *
 * Cost tracking: not implemented in Phase 2 (Anthropic primary lands
 * in Phase 3 with proper token-based cost computation). For now, cost
 * is null and the progress modal shows "—" instead of $X.
 */

import { documentImages, documents, type TrailDatabase } from '@trail/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { storage } from '../../../lib/storage.js';
import { createVisionBackend, getActiveVisionModel } from '../../vision.js';
import type { JobContext, JobHandler } from '../types.js';

export interface VisionRerunPayload {
  /** One or many docs. Bulk path passes all KB sources here. */
  documentIds: string[];
  /** 'null-only' = only re-vision NULL rows (default). 'all' = re-vision everything. */
  filter?: 'null-only' | 'all';
}

export interface VisionRerunResult {
  total: number;
  described: number;
  decorative: number;
  failed: number;
  model: string;
  /** Up to 6 random described rows for the visual-verification grid (Phase 5). */
  sampleImages: Array<{
    id: string;
    documentId: string;
    filename: string;
    description: string;
  }>;
}

const PER_IMAGE_CONCURRENCY = Number(process.env.TRAIL_VISION_CONCURRENCY ?? 4);

export const visionRerunHandler: JobHandler<VisionRerunPayload, VisionRerunResult> = async (ctx) => {
  const payload = ctx.payload as VisionRerunPayload | null;
  if (!payload?.documentIds?.length) {
    throw new Error('vision-rerun: payload.documentIds[] required');
  }

  const filter = payload.filter ?? 'null-only';
  const backend = createVisionBackend();
  if (!backend) {
    throw new Error(
      'No Vision backend configured (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY)',
    );
  }
  const model = getActiveVisionModel();

  // Validate all docs belong to this tenant + are sources.
  const docs = await ctx.trail.db
    .select({ id: documents.id, tenantId: documents.tenantId, kind: documents.kind })
    .from(documents)
    .where(inArray(documents.id, payload.documentIds))
    .all();
  for (const d of docs) {
    if (d.tenantId !== ctx.tenantId) {
      throw new Error(`vision-rerun: doc ${d.id} not in tenant ${ctx.tenantId}`);
    }
    if (d.kind !== 'source') {
      throw new Error(`vision-rerun: doc ${d.id} is not a source`);
    }
  }

  const candidatesQuery = ctx.trail.db
    .select({
      id: documentImages.id,
      documentId: documentImages.documentId,
      storagePath: documentImages.storagePath,
      filename: documentImages.filename,
      page: documentImages.page,
      width: documentImages.width,
      height: documentImages.height,
    })
    .from(documentImages);

  const candidates = await (filter === 'all'
    ? candidatesQuery.where(inArray(documentImages.documentId, payload.documentIds)).all()
    : candidatesQuery
        .where(
          and(
            inArray(documentImages.documentId, payload.documentIds),
            isNull(documentImages.visionDescription),
          ),
        )
        .all());

  const total = candidates.length;
  if (total === 0) {
    await ctx.report({ current: 0, total: 0, etaMs: null, phase: 'no-candidates' });
    return {
      result: { total: 0, described: 0, decorative: 0, failed: 0, model, sampleImages: [] },
    };
  }

  let described = 0;
  let decorative = 0;
  let failed = 0;
  const start = Date.now();

  const reportNow = async (phase: string) => {
    const done = described + decorative + failed;
    const elapsed = Date.now() - start;
    const rate = elapsed > 0 ? done / elapsed : 0;
    const remaining = total - done;
    const etaMs = rate > 0 ? Math.round(remaining / rate) : null;
    await ctx.report({
      current: done,
      total,
      etaMs,
      phase,
      extra: { described, decorative, failed },
    });
  };

  await reportNow('starting');

  const limit = pLimit(PER_IMAGE_CONCURRENCY);
  const tasks = candidates.map((row) =>
    limit(async () => {
      if (ctx.signal.aborted) return;
      try {
        const bytes = await storage.get(row.storagePath);
        if (!bytes) {
          failed += 1;
          return;
        }
        const description = await backend(new Uint8Array(bytes), {
          page: row.page ?? 0,
          width: row.width,
          height: row.height,
          filename: row.filename,
        });
        const visionAt = new Date().toISOString();
        if (!description) {
          // Decorative sentinel — mark as scanned so NULL-filter
          // still re-tries IF curator wants to retry, but vision_at
          // gives an audit trail of "we tried, model said decorative".
          await ctx.trail.db
            .update(documentImages)
            .set({ visionAt, visionModel: model, updatedAt: visionAt })
            .where(eq(documentImages.id, row.id))
            .run();
          decorative += 1;
          return;
        }
        await ctx.trail.db
          .update(documentImages)
          .set({
            visionDescription: description,
            visionModel: model,
            visionAt,
            updatedAt: visionAt,
          })
          .where(eq(documentImages.id, row.id))
          .run();
        described += 1;
      } catch (err) {
        failed += 1;
        console.warn(
          `[vision-rerun job=${ctx.jobId}] image=${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        await reportNow('describing');
      }
    }),
  );

  await Promise.all(tasks);

  // Sample-grid for visual verification (Phase 5 modal): up to 6 random
  // newly-described images. RANDOM() at SQLite-level keeps it cheap.
  const samples = await ctx.trail.execute(
    `
    SELECT id, document_id, filename, vision_description
      FROM document_images
     WHERE document_id IN (${payload.documentIds.map(() => '?').join(',')})
       AND vision_description IS NOT NULL
     ORDER BY RANDOM()
     LIMIT 6
    `,
    payload.documentIds,
  );

  const sampleImages = (samples.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    documentId: String(r.document_id),
    filename: String(r.filename),
    description: String(r.vision_description ?? ''),
  }));

  return {
    result: {
      total,
      described,
      decorative,
      failed,
      model,
      sampleImages,
    },
  };
};
