CREATE TABLE `api_keys` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `user_id` text NOT NULL,
  `name` text NOT NULL,
  `key_hash` text NOT NULL,
  `last_used_at` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `revoked_at` text,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade
);
CREATE UNIQUE INDEX `idx_api_keys_user_name` ON `api_keys` (`user_id`, `name`);
CREATE INDEX `idx_api_keys_hash` ON `api_keys` (`key_hash`);
