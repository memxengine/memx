-- F149 Phase 2e — Per-tenant encrypted API-keys.
--
-- One row per tenant (PRIMARY KEY on tenant_id — idempotent upsert).
-- Each provider's key is stored as an encrypted blob in the shape
-- `nonce:ciphertext:tag` (all base64). AES-256-GCM auth-encryption
-- with a 32-byte master key loaded from TRAIL_SECRETS_MASTER_KEY env.
--
-- Null → tenant doesn't have a key configured; the runner falls back
-- to process env (Christian's personal key) and ultimately to error
-- if neither is present.
--
-- Only the ingest path reads this table; never exposed in any API
-- response (except boolean "is this key set" via the Phase F152
-- tenant-secrets-status endpoint).
CREATE TABLE `tenant_secrets` (
  `tenant_id` text PRIMARY KEY NOT NULL,
  `openrouter_api_key_encrypted` text,
  `anthropic_api_key_encrypted` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
