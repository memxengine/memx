-- F143 — Persistent ingest queue.
-- Moves the per-KB serialiser from module-scoped JS Maps into SQLite so
-- a restart doesn't orphan 60 queued uploads. See
-- docs/features/F143-persistent-ingest-queue.md for the full design.
CREATE TABLE `ingest_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `knowledge_base_id` text NOT NULL,
  `document_id` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `prompt_options` text,
  `error_message` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `started_at` text,
  `completed_at` text,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ingest_jobs_kb_status` ON `ingest_jobs` (`knowledge_base_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_ingest_jobs_doc` ON `ingest_jobs` (`document_id`);
