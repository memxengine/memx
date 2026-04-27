-- F161 — Inline media in retrieval responses (image-database approach).
--
-- New first-class table for images extracted from PDFs (F08) and uploaded
-- standalone (F25). Vision-generated descriptions persist as structured
-- data — not just alt-text in compiled wiki-Neurons — so we can:
--   • return images[] in /retrieve responses (no markdown-parse needed)
--   • re-run Vision with a newer model via UPDATE (no full re-ingest)
--   • search images by description (FTS5 over vision_description)
--   • dedup identical bytes (content_hash, F162 pattern)
--   • audit-trail vision_model + vision_at + vision_cost_cents
--
-- Indexes: (document_id) for "all images for this Neuron", (tenant_id,
-- knowledge_base_id) for KB-scoped queries, (tenant_id, kb_id,
-- content_hash) for dedup-lookup. No unique on hash — same logo across
-- two PDFs = two rows that point at two storage-blobs (storage-level
-- CAS deferred to Phase 2 of this feature).
--
-- FTS5 contentless-mode virtual table + sync triggers keep
-- vision_description searchable per KB without double-storing the text.

CREATE TABLE `document_images` (
  `id` text PRIMARY KEY NOT NULL,
  `document_id` text NOT NULL REFERENCES `documents`(`id`) ON DELETE CASCADE,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `knowledge_base_id` text NOT NULL REFERENCES `knowledge_bases`(`id`) ON DELETE CASCADE,
  `filename` text NOT NULL,
  `storage_path` text NOT NULL,
  `content_hash` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `page` integer,
  `width` integer NOT NULL,
  `height` integer NOT NULL,
  `vision_description` text,
  `vision_model` text,
  `vision_at` text,
  `vision_cost_cents` integer,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_doc_images_document` ON `document_images`(`document_id`);
--> statement-breakpoint
CREATE INDEX `idx_doc_images_kb` ON `document_images`(`tenant_id`, `knowledge_base_id`);
--> statement-breakpoint
CREATE INDEX `idx_doc_images_hash` ON `document_images`(`tenant_id`, `knowledge_base_id`, `content_hash`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `document_images_fts` USING fts5(
  `vision_description`,
  content='document_images',
  content_rowid='rowid'
);
--> statement-breakpoint
CREATE TRIGGER `document_images_fts_insert` AFTER INSERT ON `document_images` BEGIN
  INSERT INTO `document_images_fts`(`rowid`, `vision_description`)
  VALUES (new.rowid, new.vision_description);
END;
--> statement-breakpoint
CREATE TRIGGER `document_images_fts_delete` AFTER DELETE ON `document_images` BEGIN
  INSERT INTO `document_images_fts`(`document_images_fts`, `rowid`, `vision_description`)
  VALUES ('delete', old.rowid, old.vision_description);
END;
--> statement-breakpoint
CREATE TRIGGER `document_images_fts_update` AFTER UPDATE ON `document_images` BEGIN
  INSERT INTO `document_images_fts`(`document_images_fts`, `rowid`, `vision_description`)
  VALUES ('delete', old.rowid, old.vision_description);
  INSERT INTO `document_images_fts`(`rowid`, `vision_description`)
  VALUES (new.rowid, new.vision_description);
END;
