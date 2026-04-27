-- F164 Phase 5 — Vision quality ratings (👍 / 👎).
--
-- Captures curator feedback on Vision-generated descriptions surfaced in
-- the JobProgressModal sample-grid + Lightbox. v1 collects data only;
-- v1.5 will use 👎-flagged images as input for prompt-tuning + model
-- comparison loops.
--
-- One row per (user, image) — unique constraint enforces "one rating
-- per curator per image". A re-vote upserts to flip the existing row.
--
-- Cascade-delete on document_images removal: if a source is archived
-- and its images garbage-collected, the orphan ratings go too.
-- Cascade on users so a deleted user's votes don't anchor disabled-
-- account state.
--
-- model column captures WHICH model produced the rated description so
-- when we eventually compare claude-haiku vs claude-sonnet vs gemini,
-- we can scope the analytics correctly. Same vision_model string the
-- handler stamped onto document_images.

CREATE TABLE `vision_quality_ratings` (
  `id` text PRIMARY KEY NOT NULL,
  `image_id` text NOT NULL REFERENCES `document_images`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `rating` text NOT NULL,
  `model` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vqr_user_image` ON `vision_quality_ratings`(`user_id`, `image_id`);
--> statement-breakpoint
CREATE INDEX `idx_vqr_image` ON `vision_quality_ratings`(`image_id`);
--> statement-breakpoint
CREATE INDEX `idx_vqr_tenant_rating` ON `vision_quality_ratings`(`tenant_id`, `rating`);
