-- F162 — Source dedup via SHA-256 content hash.
--
-- One nullable text column on documents + a non-unique partial index
-- for lookup performance. Uniqueness is enforced in app code (upload
-- route) so force=true uploads can bypass cleanly without schema
-- gymnastics.
--
-- content_hash is hex-encoded SHA-256 of the original file bytes,
-- computed at upload time. NULL on pre-F162 rows; a backfill bootstrap
-- (apps/server/src/bootstrap/backfill-content-hash.ts) populates them
-- on the next server start.
--
-- The partial index is only on rows where content_hash is set, so the
-- backfill window has zero index pressure.

ALTER TABLE `documents` ADD COLUMN `content_hash` text;
--> statement-breakpoint
CREATE INDEX `idx_documents_content_hash`
  ON `documents`(`tenant_id`, `knowledge_base_id`, `content_hash`)
  WHERE `kind` = 'source' AND `content_hash` IS NOT NULL;
