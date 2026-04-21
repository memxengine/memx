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
-- Use ROW_NUMBER() over (kb, created_at, id) for a total ordering. The
-- naive COUNT-based rank over (created_at<=X AND id<=Y) double-filters —
-- rows with smaller id but earlier created_at get skipped, producing
-- duplicate ranks that violate the unique index below. ROW_NUMBER sees
-- each row exactly once.
UPDATE `documents`
SET `seq` = (
  SELECT rn FROM (
    SELECT `id`,
           ROW_NUMBER() OVER (
             PARTITION BY `knowledge_base_id`
             ORDER BY `created_at`, `id`
           ) AS rn
      FROM `documents`
  ) AS ranked
  WHERE ranked.`id` = `documents`.`id`
)
WHERE `seq` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_docs_kb_seq` ON `documents` (`knowledge_base_id`, `seq`);
