CREATE TABLE `document_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`document_id` text NOT NULL,
	`knowledge_base_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`content` text NOT NULL,
	`page` integer,
	`start_char` integer,
	`token_count` integer NOT NULL,
	`header_breadcrumb` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chunks_doc_index` ON `document_chunks` (`document_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `idx_chunks_kb` ON `document_chunks` (`knowledge_base_id`);--> statement-breakpoint
CREATE TABLE `document_references` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`knowledge_base_id` text NOT NULL,
	`wiki_document_id` text NOT NULL,
	`source_document_id` text NOT NULL,
	`claim_anchor` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wiki_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_refs_wiki` ON `document_references` (`wiki_document_id`);--> statement-breakpoint
CREATE INDEX `idx_refs_source` ON `document_references` (`source_document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_refs_triple` ON `document_references` (`wiki_document_id`,`source_document_id`,`claim_anchor`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`knowledge_base_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`title` text,
	`path` text DEFAULT '/' NOT NULL,
	`file_type` text NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`page_count` integer,
	`content` text,
	`tags` text,
	`date` text,
	`metadata` text,
	`error_message` text,
	`version` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`is_canonical` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_docs_tenant` ON `documents` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_kb` ON `documents` (`knowledge_base_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_kb_kind` ON `documents` (`knowledge_base_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_docs_kb_path` ON `documents` (`knowledge_base_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_docs_status` ON `documents` (`knowledge_base_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_docs_kb_canonical` ON `documents` (`knowledge_base_id`,`is_canonical`);--> statement-breakpoint
CREATE TABLE `knowledge_bases` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`language` text DEFAULT 'da' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kb_tenant_slug` ON `knowledge_bases` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kb_tenant_name` ON `knowledge_bases` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `queue_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`knowledge_base_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text,
	`confidence` integer,
	`impact_estimate` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_by` text,
	`reviewed_by` text,
	`reviewed_at` text,
	`auto_approved_at` text,
	`rejection_reason` text,
	`resulting_document_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resulting_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_queue_kb_status` ON `queue_candidates` (`knowledge_base_id`,`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`plan` text DEFAULT 'hobby' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`role` text DEFAULT 'owner' NOT NULL,
	`onboarded` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_tenant_email` ON `users` (`tenant_id`,`email`);--> statement-breakpoint
CREATE TABLE `wiki_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`document_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_id` text,
	`actor_kind` text NOT NULL,
	`previous_version` integer,
	`new_version` integer,
	`summary` text,
	`metadata` text,
	`prev_event_id` text,
	`source_candidate_id` text,
	`content_snapshot` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_candidate_id`) REFERENCES `queue_candidates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_events_doc` ON `wiki_events` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_events_doc_prev` ON `wiki_events` (`document_id`,`prev_event_id`);