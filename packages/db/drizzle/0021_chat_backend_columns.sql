-- F159 Phase 3 — Pluggable chat backend schema extensions.
--
-- Mirror of F149's 0014_ingest_backend_columns.sql, applied to the
-- chat path. Per-KB backend/model/fallback-chain override columns on
-- knowledge_bases; per-turn cost + backend + model audit on chat_turns.
--
-- All nullable. Pre-F159 rows stay legal:
--   chat_turns.cost_cents = NULL          (rendered as "—" / Max-Plan flat fee)
--   chat_turns.backend_used = NULL        (rendered as "claude-cli" legacy)
--   chat_turns.model_used = NULL          (rendered as "default" / from env)
--   knowledge_bases.chat_backend = NULL   (resolveChatChain falls back to env)
--   knowledge_bases.chat_model = NULL
--   knowledge_bases.chat_fallback_chain = NULL
--
-- The runner's resolveChatChain(kb, env) handles NULLs as "use
-- hardcoded defaults" — no data-migration required.

ALTER TABLE `knowledge_bases` ADD COLUMN `chat_backend` text;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `chat_model` text;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `chat_fallback_chain` text;
--> statement-breakpoint
ALTER TABLE `chat_turns` ADD COLUMN `cost_cents` integer;
--> statement-breakpoint
ALTER TABLE `chat_turns` ADD COLUMN `backend_used` text;
--> statement-breakpoint
ALTER TABLE `chat_turns` ADD COLUMN `model_used` text;
