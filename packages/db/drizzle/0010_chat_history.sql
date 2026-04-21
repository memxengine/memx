-- F144 — Chat history persistence.
-- Replaces the useState-only chat feed with durable per-KB sessions so
-- curators can revisit answers and citations survive slug-drift.
CREATE TABLE `chat_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `knowledge_base_id` text NOT NULL,
  `tenant_id` text NOT NULL,
  `user_id` text NOT NULL,
  `title` text,
  `archived` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_chat_sessions_kb` ON `chat_sessions` (`knowledge_base_id`, `archived`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_chat_sessions_user` ON `chat_sessions` (`user_id`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `chat_turns` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `role` text NOT NULL,
  `content` text NOT NULL,
  `citations` text,
  `tokens_in` integer,
  `tokens_out` integer,
  `latency_ms` integer,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_turns_session` ON `chat_turns` (`session_id`, `created_at`);
