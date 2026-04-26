-- F156 Phase 0 — dev-credits foundation.
--
-- Two new tables, additive, zero impact on existing rows:
--
--   tenant_credits         — current balance + monthly inclusion baseline
--                            per tenant. One row per tenant; created on
--                            first seed/consume. Phase 0 keeps this
--                            simple — Phase 2 layers Stripe Checkout
--                            on top + monthly auto-topup; Phase 4 adds
--                            hard-cap enforcement.
--
--   credit_transactions    — append-only audit log of every
--                            consume / refill / adjustment. Includes
--                            balance_after so a `SUM` query is never
--                            needed to compute current balance.
--                            Foreign keys are nullable because
--                            consume rows reference ingest_jobs OR
--                            chat_turns (only one at a time).
--
-- Migration 0021 (chat_backend_columns by trail-optimizer for F159)
-- already added chat_turns.cost_cents. F156 Phase 0 reads that column
-- to determine credit-burn per chat turn.

CREATE TABLE `tenant_credits` (
  `tenant_id` text PRIMARY KEY NOT NULL,
  `balance` integer NOT NULL DEFAULT 0,
  `monthly_included` integer NOT NULL DEFAULT 0,
  `last_topup_at` text,
  `low_balance_alerted_at` text,
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade
);

CREATE TABLE `credit_transactions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  -- 'consume' | 'monthly_topup' | 'purchase' | 'adjustment' | 'refund'
  `kind` text NOT NULL,
  -- Negative for consume, positive for top-ups. balance_after is the
  -- post-transaction balance so the UI doesn't have to roll up.
  `amount` integer NOT NULL,
  `balance_after` integer NOT NULL,
  -- For consume: which feature burned the credits. 'ingest' | 'chat'
  -- | 'lint' | 'extract' (image/audio). Null for non-consume rows.
  `feature` text,
  -- Source job/turn — only one is non-null per row.
  `related_ingest_job_id` text,
  `related_chat_turn_id` text,
  -- For 'purchase': Stripe Checkout session id. Future Phase 2.
  `related_stripe_id` text,
  -- Operator note for 'adjustment' (manual top-up, refund context).
  `note` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade
);

CREATE INDEX `idx_credit_tx_tenant` ON `credit_transactions`(`tenant_id`, `created_at` DESC);
CREATE INDEX `idx_credit_tx_kind` ON `credit_transactions`(`tenant_id`, `kind`, `created_at` DESC);
CREATE INDEX `idx_credit_tx_ingest` ON `credit_transactions`(`related_ingest_job_id`);
CREATE INDEX `idx_credit_tx_chat` ON `credit_transactions`(`related_chat_turn_id`);
