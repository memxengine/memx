-- F164 — Background jobs framework.
--
-- Generic table for long-running operations: vision-rerun (first
-- consumer), bulk-vision-rerun (multi-doc), and future kinds (ingest
-- via this layer once F143's ingest_jobs is unified, contradiction-
-- scan, embed-recompute, batch-tagging). Per F164 plan: separate from
-- ingest_jobs to avoid polymorphing domain-specific columns into a
-- generic surface — F143's ingest_jobs has file-format/page-count
-- columns that don't translate.
--
-- Crash-recovery contract:
--   - last_heartbeat_at updated by handler every ~5s during work
--   - on engine boot, status='running' AND last_heartbeat_at <
--     now()-60s → reset to 'pending' for re-pickup (F143 zombie pattern)
--   - handlers MUST be idempotent (resume from mid-execution)
--
-- Abort contract:
--   - abort_requested=1 + AbortController signal → handler checkpoints
--     between sub-tasks, persists progress, sets status='aborted'
--   - already-completed sub-tasks (e.g. described images) stay done
--
-- Cost-tracking:
--   - cost_cents_estimated set at submit-time (pre-flight)
--   - cost_cents_actual updated incrementally as sub-tasks complete
--   - mid-job warning at actual >= estimated*1.5
--
-- Parent-job linkage (parent_job_id) reserved for v2 — bulk-jobs
-- spawning per-doc sub-jobs. v1 keeps bulk-Vision flat (one row,
-- many images) but the column is here so we don't migrate later.

CREATE TABLE `jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `knowledge_base_id` text REFERENCES `knowledge_bases`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `payload` text NOT NULL,
  `progress` text,
  `result` text,
  `error_message` text,
  `parent_job_id` text REFERENCES `jobs`(`id`) ON DELETE CASCADE,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `started_at` text,
  `finished_at` text,
  `last_heartbeat_at` text,
  `abort_requested` integer NOT NULL DEFAULT 0,
  `cost_cents_estimated` integer,
  `cost_cents_actual` integer
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_tenant_status` ON `jobs`(`tenant_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_jobs_kb_status` ON `jobs`(`knowledge_base_id`, `status`) WHERE `knowledge_base_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_jobs_parent` ON `jobs`(`parent_job_id`) WHERE `parent_job_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_jobs_running_heartbeat` ON `jobs`(`status`, `last_heartbeat_at`) WHERE `status` = 'running';
