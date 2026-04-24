-- F148 Lag 3 — broken-link findings table.
--
-- One row per unresolvable [[wiki-link]] discovered by the link-checker
-- service. The checker runs on every candidate_approved event + a daily
-- full-KB sweep via lint-scheduler. Unique (from_document_id, link_text)
-- makes re-scans idempotent — the same broken link on the same doc won't
-- generate duplicate rows.
--
-- Lifecycle:
--   status='open'       — finding recorded, curator hasn't acted
--   status='auto_fixed' — content was rewritten to resolve via
--                         normalizedSlug fold (Lag 2) and the broken-link
--                         row is retained as an audit trail
--   status='dismissed'  — curator confirmed the link is intentional dead
--                         (e.g. Neuron not yet created) or meaningless
--
-- suggested_fix holds the proposed replacement link-text when the checker
-- found a single high-confidence candidate (Levenshtein ≤ 2 against an
-- existing Neuron title). Curator accepts via the /link-check/:id/accept
-- route; the route applies the rewrite and flips status to auto_fixed.
CREATE TABLE `broken_links` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `knowledge_base_id` text NOT NULL,
  `from_document_id` text NOT NULL,
  `link_text` text NOT NULL,
  `suggested_fix` text,
  `status` text DEFAULT 'open' NOT NULL,
  `reported_at` text DEFAULT (datetime('now')) NOT NULL,
  `fixed_at` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`from_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_broken_links_unique` ON `broken_links` (`from_document_id`, `link_text`);
--> statement-breakpoint
CREATE INDEX `idx_broken_links_kb_status` ON `broken_links` (`knowledge_base_id`, `status`);
