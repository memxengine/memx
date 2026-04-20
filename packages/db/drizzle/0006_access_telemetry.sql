-- F141 — Neuron access telemetry.
-- Append-only document_access table records each Neuron read along with
-- source + actor-kind. A nightly rollup (F32 lint-scheduler dreaming-
-- pass) aggregates into document_access_rollup which callers read for
-- usage-weighting signals (graph node sizing, search tie-breaking,
-- chat-context bias, F139 heuristic last-read refresh).
--
-- LLM-initiated reads (compiler, lint detectors, automated passes)
-- should set actor_kind='llm' so the rollup filter can suppress them —
-- they'd otherwise inflate every Neuron the compiler touches during
-- ingest.
CREATE TABLE `document_access` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `knowledge_base_id` text NOT NULL,
  `document_id` text NOT NULL,
  `source` text NOT NULL,
  `actor_kind` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_access_doc` ON `document_access` (`document_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `idx_access_kb` ON `document_access` (`knowledge_base_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `document_access_rollup` (
  `document_id` text PRIMARY KEY NOT NULL,
  `knowledge_base_id` text NOT NULL,
  `reads_7d` integer DEFAULT 0 NOT NULL,
  `reads_30d` integer DEFAULT 0 NOT NULL,
  `reads_90d` integer DEFAULT 0 NOT NULL,
  `reads_total` integer DEFAULT 0 NOT NULL,
  `last_read_at` text,
  `usage_weight` real DEFAULT 0 NOT NULL,
  `rolled_up_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rollup_kb` ON `document_access_rollup` (`knowledge_base_id`);
--> statement-breakpoint
-- Per-KB toggle for access-tracking. Default on so the feature is
-- useful out of the box; curators that don't want tracking can flip
-- it off per Trail.
ALTER TABLE `knowledge_bases` ADD `track_access` integer DEFAULT 1 NOT NULL;
