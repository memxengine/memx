/**
 * F156 Phase 0 — credits service.
 *
 * Single source of truth for reading + mutating tenant_credits +
 * credit_transactions. All callers (chat persist, ingest job complete,
 * lint pass complete, future Stripe webhook) go through this module
 * so the audit trail in credit_transactions stays trustworthy.
 *
 * Phase 0 scope (this file):
 *   - getCreditBalance(tenantId)            — read current balance
 *   - consumeCredits(...)                   — deduct + log 'consume'
 *   - refillCredits(...)                    — add + log 'monthly_topup' /
 *                                             'purchase' / 'adjustment'
 *   - seedDevCredits(tenantId, balance)     — boot-time helper, idempotent.
 *
 * Out of scope until Phase 2/3:
 *   - Stripe Checkout webhook hooks (Phase 2)
 *   - Hard-cap enforcement (Phase 4) — Phase 0 lets balance go negative;
 *     callers can choose to gate on `balance < 0` but no error is thrown.
 *   - Low-balance alert dedupe (Phase 3 reads tenantCredits.lowBalanceAlertedAt).
 *
 * Atomicity contract:
 *   consume + refill always run inside trail.db.transaction so the
 *   balance update + transaction-row insert are committed together.
 *   A crashed write produces neither — never just one half.
 *
 * Cost-to-credits rule:
 *   1 credit = 1¢ USD measured cost. costCents <= 0 means "no consume"
 *   (Claude-CLI Max-Plan rows have costCents=NULL → 0 → no-op).
 *
 * See docs/features/F156-credits-based-llm-metering.md.
 */

import { eq, sql } from 'drizzle-orm';
import {
  tenantCredits,
  creditTransactions,
  type TrailDatabase,
} from '@trail/db';

export type ConsumeFeature = 'ingest' | 'chat' | 'lint' | 'extract';

export type RefillKind = 'monthly_topup' | 'purchase' | 'adjustment' | 'refund';

export interface ConsumeOptions {
  /** Must be > 0. costCents <= 0 → caller should not call us at all (no-op for safety). */
  costCents: number;
  feature: ConsumeFeature;
  /** One of these — never both. */
  relatedIngestJobId?: string | null;
  relatedChatTurnId?: string | null;
  /** Operator note for adjustment/refund rows. Ignored on consume. */
  note?: string | null;
}

export interface RefillOptions {
  amount: number;
  kind: RefillKind;
  relatedStripeId?: string | null;
  note?: string | null;
}

/**
 * 1 credit per measured ¢. Round up so a $0.001 LLM call still
 * costs the tenant 1 credit (the minimum unit) — F156 plan-doc's
 * "tæl-aldrig-mindre-end-faktisk"-rule.
 */
export function computeCreditsForCost(costCents: number): number {
  if (!Number.isFinite(costCents) || costCents <= 0) return 0;
  return Math.ceil(costCents);
}

/**
 * Read current balance. Returns 0 if the tenant has no row yet — a
 * tenant that's never consumed credits is implicitly at 0 (the seed
 * function lifts that to a positive starting balance).
 */
export async function getCreditBalance(
  trail: TrailDatabase,
  tenantId: string,
): Promise<number> {
  const row = await trail.db
    .select({ balance: tenantCredits.balance })
    .from(tenantCredits)
    .where(eq(tenantCredits.tenantId, tenantId))
    .get();
  return row?.balance ?? 0;
}

/**
 * Deduct `costCents` (rounded-up to credits) from a tenant's balance and
 * append a `kind='consume'` transaction. Atomic. Returns the new balance
 * + the credits actually deducted.
 *
 * No-op when costCents <= 0 — Claude-CLI Max-Plan turns and Whisper-free
 * extracts hit this path. Returns the existing balance unchanged.
 *
 * Will UPSERT the tenant_credits row if missing (a tenant's first
 * consume creates their row; balance starts at 0 → goes negative).
 * Phase 4 will gate on negative balance; Phase 0 logs and proceeds.
 */
export async function consumeCredits(
  trail: TrailDatabase,
  tenantId: string,
  opts: ConsumeOptions,
): Promise<{ deducted: number; balanceAfter: number; wentNegative: boolean }> {
  const credits = computeCreditsForCost(opts.costCents);
  if (credits === 0) {
    const balance = await getCreditBalance(trail, tenantId);
    return { deducted: 0, balanceAfter: balance, wentNegative: balance < 0 };
  }

  if (opts.relatedIngestJobId && opts.relatedChatTurnId) {
    throw new Error(
      'consumeCredits: pass relatedIngestJobId OR relatedChatTurnId, not both',
    );
  }

  return trail.db.transaction(async (tx) => {
    // UPSERT shape: insert with balance=-credits OR add to existing
    // balance. SQLite ON CONFLICT lets us do this in one statement so
    // there's no read-modify-write race between the SELECT and UPDATE.
    await tx
      .insert(tenantCredits)
      .values({
        tenantId,
        balance: -credits,
        monthlyIncluded: 0,
      })
      .onConflictDoUpdate({
        target: tenantCredits.tenantId,
        set: {
          balance: sql`${tenantCredits.balance} - ${credits}`,
          updatedAt: sql`(datetime('now'))`,
        },
      })
      .run();

    const after = await tx
      .select({ balance: tenantCredits.balance })
      .from(tenantCredits)
      .where(eq(tenantCredits.tenantId, tenantId))
      .get();
    const balanceAfter = after?.balance ?? -credits;

    await tx
      .insert(creditTransactions)
      .values({
        id: `ctx_${crypto.randomUUID().slice(0, 12)}`,
        tenantId,
        kind: 'consume',
        amount: -credits,
        balanceAfter,
        feature: opts.feature,
        relatedIngestJobId: opts.relatedIngestJobId ?? null,
        relatedChatTurnId: opts.relatedChatTurnId ?? null,
        relatedStripeId: null,
        note: null,
      })
      .run();

    return {
      deducted: credits,
      balanceAfter,
      wentNegative: balanceAfter < 0,
    };
  });
}

/**
 * Add credits to a tenant. Used by the dev seeder, the future monthly
 * top-up scheduler, and (Phase 2) Stripe Checkout webhooks. Atomic.
 */
export async function refillCredits(
  trail: TrailDatabase,
  tenantId: string,
  opts: RefillOptions,
): Promise<{ balanceAfter: number }> {
  if (opts.amount <= 0) {
    throw new Error(`refillCredits: amount must be > 0 (got ${opts.amount})`);
  }

  return trail.db.transaction(async (tx) => {
    const lastTopupAt =
      opts.kind === 'monthly_topup' ? sql`(datetime('now'))` : sql`last_topup_at`;

    await tx
      .insert(tenantCredits)
      .values({
        tenantId,
        balance: opts.amount,
        monthlyIncluded: 0,
        lastTopupAt: opts.kind === 'monthly_topup' ? new Date().toISOString() : null,
      })
      .onConflictDoUpdate({
        target: tenantCredits.tenantId,
        set: {
          balance: sql`${tenantCredits.balance} + ${opts.amount}`,
          lastTopupAt,
          updatedAt: sql`(datetime('now'))`,
        },
      })
      .run();

    const after = await tx
      .select({ balance: tenantCredits.balance })
      .from(tenantCredits)
      .where(eq(tenantCredits.tenantId, tenantId))
      .get();
    const balanceAfter = after?.balance ?? opts.amount;

    await tx
      .insert(creditTransactions)
      .values({
        id: `ctx_${crypto.randomUUID().slice(0, 12)}`,
        tenantId,
        kind: opts.kind,
        amount: opts.amount,
        balanceAfter,
        feature: null,
        relatedIngestJobId: null,
        relatedChatTurnId: null,
        relatedStripeId: opts.relatedStripeId ?? null,
        note: opts.note ?? null,
      })
      .run();

    return { balanceAfter };
  });
}

/**
 * Idempotent boot helper: ensure every tenant has at least
 * `targetBalance` credits. If the row is missing, create it with that
 * balance + log an 'adjustment' transaction. If the row exists with a
 * lower balance, top up the delta. Never decreases an existing balance.
 *
 * Driven by TRAIL_DEV_CREDITS env-var on boot. Production tenants will
 * be seeded via Stripe Checkout (Phase 2), not this path.
 */
export async function seedDevCredits(
  trail: TrailDatabase,
  tenantId: string,
  targetBalance: number,
): Promise<{ seeded: boolean; balanceAfter: number }> {
  if (targetBalance <= 0) {
    const balance = await getCreditBalance(trail, tenantId);
    return { seeded: false, balanceAfter: balance };
  }

  const current = await getCreditBalance(trail, tenantId);
  if (current >= targetBalance) {
    return { seeded: false, balanceAfter: current };
  }

  const delta = targetBalance - current;
  const { balanceAfter } = await refillCredits(trail, tenantId, {
    amount: delta,
    kind: 'adjustment',
    note: `dev-seed: top up to ${targetBalance}`,
  });
  return { seeded: true, balanceAfter };
}
