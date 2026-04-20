-- F137 — Typed Neuron Relationships
-- Add edge_type to wiki_backlinks so every [[link]] can carry a
-- semantic relation: is-a, part-of, contradicts, supersedes,
-- example-of, caused-by. Default 'cites' for bare [[link]]s and
-- for all rows that existed before this migration — strictly
-- backward-compatible.
ALTER TABLE `wiki_backlinks` ADD `edge_type` text DEFAULT 'cites' NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_backlinks_edge_type` ON `wiki_backlinks` (`edge_type`);
