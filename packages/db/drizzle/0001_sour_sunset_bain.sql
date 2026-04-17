CREATE TABLE `wiki_backlinks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`knowledge_base_id` text NOT NULL,
	`from_document_id` text NOT NULL,
	`to_document_id` text NOT NULL,
	`link_text` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_backlinks_from` ON `wiki_backlinks` (`from_document_id`);--> statement-breakpoint
CREATE INDEX `idx_backlinks_to` ON `wiki_backlinks` (`to_document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_backlinks_unique` ON `wiki_backlinks` (`from_document_id`,`to_document_id`,`link_text`);