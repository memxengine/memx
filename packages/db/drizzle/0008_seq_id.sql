-- F145 — Per-KB sequence IDs on documents.
-- Every document (Neuron, Source, Work) gets a monotone integer per KB so
-- cross-session references can use a stable, human-readable handle like
-- `buddy_00000219` instead of UUIDs. Buddy's intercom IDs are not KB-aware
-- and drift when Neurons are re-compiled; this is Trail-owned + durable.
--
-- Backfill existing rows by creation order within each KB. New rows get
-- their seq computed in-transaction at insert time (see
-- packages/core/src/queue/candidates.ts).
ALTER TABLE `documents` ADD `seq` integer;
--> statement-breakpoint
UPDATE `documents`
SET `seq` = (
  SELECT COUNT(*)
  FROM `documents` AS d2
  WHERE d2.`knowledge_base_id` = `documents`.`knowledge_base_id`
    AND d2.`created_at` <= `documents`.`created_at`
    AND d2.`id` <= `documents`.`id`
)
WHERE `seq` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_docs_kb_seq` ON `documents` (`knowledge_base_id`, `seq`);
