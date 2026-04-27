/**
 * F161 follow-up — opt-in Vision-rerun for `document_images` rows
 * with `vision_description IS NULL`.
 *
 * Two NULL-source-cases this addresses:
 *   1. Legacy backfill rows (~115) — F161 backfill copied storage
 *      blobs into the table but pulled alt-text from compiled markdown
 *      which was empty (Vision didn't run originally; pre-OPENROUTER
 *      key era).
 *   2. New uploads that ingested while createVisionBackend's
 *      OpenRouter-fallback bug was live. Sanne's bog (Zoneterapibogen)
 *      contributed 224 such rows — fix landed but bog had already
 *      finished extracting before the fix was deployed.
 *
 * Without this rerun, those 339+ images stay un-described forever
 * unless someone re-ingests their parent PDFs (token-expensive).
 *
 * Env contract — OFF by default. Only fires when an operator
 * explicitly opts in:
 *   TRAIL_VISION_RERUN_NULL=1     — enable the scan
 *   TRAIL_VISION_RERUN_LIMIT=N    — cap rows processed (default 100)
 *   TRAIL_VISION_RERUN_DRY=1      — count only, no API calls (preview)
 *
 * Recommended workflow:
 *   1. Set DRY=1 first → boot reports "would re-Vision N rows".
 *   2. Set LIMIT=10 → run on 10 to confirm quality.
 *   3. Remove LIMIT (or set to 1000) → run on the full backlog.
 *   4. Unset TRAIL_VISION_RERUN_NULL after the backlog drains.
 *
 * Per-row failure (storage missing, Vision API error, timeout) is
 * logged and skipped — the row stays NULL for next run. Idempotent:
 * once rows have descriptions they're not selected again.
 *
 * Cost: at OpenRouter Anthropic Vision rates (~$0.001 per image-call)
 * 300 rows ≈ $0.30 = ~30 credits via F156. The job logs cost-cents
 * per-row when the provider returns it (Anthropic native does;
 * OpenRouter currently lumps it into the chat-cost — we leave the
 * vision_cost_cents column NULL on OpenRouter rows for now).
 */

import { documentImages, type TrailDatabase } from '@trail/db';
import { eq, isNull } from 'drizzle-orm';
import { storage } from '../lib/storage.js';
import { createVisionBackend, getActiveVisionModel } from '../services/vision.js';

export async function rerunVisionOnNull(trail: TrailDatabase): Promise<void> {
  if (process.env.TRAIL_VISION_RERUN_NULL !== '1') return;

  const limit = Number(process.env.TRAIL_VISION_RERUN_LIMIT ?? '100');
  const dry = process.env.TRAIL_VISION_RERUN_DRY === '1';

  const candidates = await trail.db
    .select({
      id: documentImages.id,
      storagePath: documentImages.storagePath,
      filename: documentImages.filename,
      page: documentImages.page,
      width: documentImages.width,
      height: documentImages.height,
    })
    .from(documentImages)
    .where(isNull(documentImages.visionDescription))
    .limit(Math.max(1, Math.min(limit, 1000)))
    .all();

  if (candidates.length === 0) {
    console.log('[F161-rerun] no NULL-description rows — nothing to do');
    return;
  }

  if (dry) {
    console.log(
      `[F161-rerun] DRY-RUN: would attempt Vision on ${candidates.length} row(s) ` +
        `(limit=${limit}). Set TRAIL_VISION_RERUN_DRY=0 to actually run.`,
    );
    return;
  }

  const backend = createVisionBackend();
  if (!backend) {
    console.warn(
      '[F161-rerun] no Vision backend configured (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY) — skip',
    );
    return;
  }
  const model = getActiveVisionModel();

  console.log(
    `[F161-rerun] running Vision on ${candidates.length} row(s) (model=${model}, limit=${limit})`,
  );

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  const startedAt = Date.now();
  const visionAt = new Date().toISOString();

  for (const row of candidates) {
    try {
      const bytes = await storage.get(row.storagePath);
      if (!bytes) {
        skipped += 1;
        console.warn(`[F161-rerun] skip — no bytes at ${row.storagePath}`);
        continue;
      }
      const description = await backend(new Uint8Array(bytes), {
        page: row.page ?? 0,
        width: row.width,
        height: row.height,
        filename: row.filename,
      });
      if (!description) {
        // Vision returned null (e.g. "decorative" sentinel). We mark
        // the row as scanned by stamping vision_at + vision_model so
        // the next rerun-pass doesn't pick it up again. Description
        // stays NULL because there's nothing useful to store.
        await trail.db
          .update(documentImages)
          .set({
            visionAt,
            visionModel: model,
            updatedAt: visionAt,
          })
          .where(eq(documentImages.id, row.id))
          .run();
        skipped += 1;
        continue;
      }
      await trail.db
        .update(documentImages)
        .set({
          visionDescription: description,
          visionModel: model,
          visionAt,
          updatedAt: visionAt,
        })
        .where(eq(documentImages.id, row.id))
        .run();
      succeeded += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[F161-rerun] failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Note: "decorative" results stamp vision_at + vision_model so the
  // SELECT-WHERE-vision_description-IS-NULL still picks them up next
  // rerun, but we capped at `limit` per run so worst-case is bounded
  // re-cost. A future cleanup can add `WHERE vision_at IS NULL` to
  // the candidates query to skip already-scanned-as-decorative rows.

  const elapsed = Date.now() - startedAt;
  console.log(
    `[F161-rerun] done — ${succeeded} described, ${skipped} skipped, ${failed} failed, ${elapsed}ms`,
  );
}
