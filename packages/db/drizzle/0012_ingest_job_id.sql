-- F111.2 — Deterministic source→Neuron attribution.
-- Stamps every wiki doc with the ingest job that created/last updated it so
-- wireSourceRefs can query `WHERE ingest_job_id = :jobId` instead of the
-- `created_at > jobStartedAt` timing boundary (which only caught new creates,
-- missing updates to existing concept/entity Neurons in mature KBs).
ALTER TABLE `documents` ADD COLUMN `ingest_job_id` text;
--> statement-breakpoint
CREATE INDEX `idx_docs_ingest_job` ON `documents` (`ingest_job_id`);
