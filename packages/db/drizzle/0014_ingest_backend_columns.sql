-- F149 Fase 1b — Pluggable Ingest Backends schema-extensions.
--
-- Additive columns on ingest_jobs (per-run cost + backend + model-trail
-- audit) and knowledge_bases (per-KB backend/model/fallback-chain
-- overrides). All nullable except cost_cents which defaults to 0 so
-- pre-F149 rows stay legal.
--
-- Rows pre-F149 will have:
--   ingest_jobs.cost_cents = 0           (legal, rendered as "—" or
--                                         "gratis (Max)" based on backend)
--   ingest_jobs.backend = NULL           (rendered as "claude-cli" legacy)
--   ingest_jobs.model_trail = NULL
--   knowledge_bases.ingest_backend = NULL (runner falls back to env default)
--   knowledge_bases.ingest_model = NULL
--   knowledge_bases.ingest_fallback_chain = NULL
--
-- The runner's resolveIngestChain(kb, env) handles NULLs as "use
-- hardcoded defaults" — no data-migration required.

ALTER TABLE `ingest_jobs` ADD COLUMN `cost_cents` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `ingest_jobs` ADD COLUMN `backend` text;
--> statement-breakpoint
ALTER TABLE `ingest_jobs` ADD COLUMN `model_trail` text;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `ingest_backend` text;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `ingest_model` text;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `ingest_fallback_chain` text;
