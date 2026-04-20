-- F138 — Work Layer: tasks, bugs, milestones.
-- Work items live in the documents table as kind='work' rows so wiki-
-- links, backlinks, F99 graph, search and chat treat them as regular
-- documents with extra state. Dual-context inheritance (the reason
-- Work lives here, not in Linear/Notion) reuses F15 document_references
-- and wiki_backlinks — no new join table needed.
ALTER TABLE `documents` ADD `work_status` text;
--> statement-breakpoint
ALTER TABLE `documents` ADD `work_assignee` text;
--> statement-breakpoint
ALTER TABLE `documents` ADD `work_due_at` text;
--> statement-breakpoint
ALTER TABLE `documents` ADD `work_kind` text;
--> statement-breakpoint
CREATE INDEX `idx_docs_work_status` ON `documents` (`knowledge_base_id`, `work_status`);
--> statement-breakpoint
CREATE INDEX `idx_docs_work_assignee` ON `documents` (`knowledge_base_id`, `work_assignee`);
