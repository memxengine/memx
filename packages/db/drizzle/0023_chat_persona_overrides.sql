-- F160 Phase 2 — per-KB chat persona overrides for audience-aware chat.
--
-- Two new nullable text columns on knowledge_bases. Both null is the
-- default and means "use the base template only" — same prompt all
-- tenants would have got pre-F160. The override (when set) is appended
-- to the base persona-template under a "## KB-specific persona" header
-- so curators can sharpen tone without rewriting the whole template.
--
--   chat_persona_tool   — appended to the `tool`-audience template
--                         (site-LLM-orchestrators). Typical content:
--                         "ALWAYS speak about [domain] from a clinical-
--                         neutral position; never recommend booking."
--   chat_persona_public — appended to the `public`-audience template
--                         (direct customer-facing chat). Typical
--                         content: "Du er Sanne Andersen, zoneterapeut
--                         i Aalborg. Booking: sanne-andersen.dk/book."
--
-- `curator` audience has no per-KB override — admin tone is shared
-- across all KBs the curator owns.

ALTER TABLE `knowledge_bases` ADD COLUMN `chat_persona_tool` text;
--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD COLUMN `chat_persona_public` text;
