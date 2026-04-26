/**
 * F156 Phase 0 — credits read endpoints.
 *
 * Read-only for now. Phase 2 adds POST endpoints for Stripe Checkout
 * + the webhook receiver. Phase 0 keeps it to:
 *
 *   GET /api/v1/credits           — current tenant's balance + recent
 *                                   transactions for the cost panel card
 *
 * Mutating endpoints (top-up, adjustment) live behind admin/operator
 * auth and are not exposed in v1 — operators run the seedDevCredits
 * function directly via boot env-var or a future ops CLI.
 */

import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { creditTransactions, tenantCredits } from '@trail/db';
import { requireAuth, getTenant, getTrail } from '../middleware/auth.js';

export const creditsRoutes = new Hono();

creditsRoutes.use('*', requireAuth);

creditsRoutes.get('/credits', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);

  const balanceRow = await trail.db
    .select({
      balance: tenantCredits.balance,
      monthlyIncluded: tenantCredits.monthlyIncluded,
      lastTopupAt: tenantCredits.lastTopupAt,
      updatedAt: tenantCredits.updatedAt,
    })
    .from(tenantCredits)
    .where(eq(tenantCredits.tenantId, tenant.id))
    .get();

  const recent = await trail.db
    .select({
      id: creditTransactions.id,
      kind: creditTransactions.kind,
      amount: creditTransactions.amount,
      balanceAfter: creditTransactions.balanceAfter,
      feature: creditTransactions.feature,
      relatedIngestJobId: creditTransactions.relatedIngestJobId,
      relatedChatTurnId: creditTransactions.relatedChatTurnId,
      note: creditTransactions.note,
      createdAt: creditTransactions.createdAt,
    })
    .from(creditTransactions)
    .where(eq(creditTransactions.tenantId, tenant.id))
    .orderBy(desc(creditTransactions.createdAt))
    .limit(20)
    .all();

  return c.json({
    balance: balanceRow?.balance ?? 0,
    monthlyIncluded: balanceRow?.monthlyIncluded ?? 0,
    lastTopupAt: balanceRow?.lastTopupAt ?? null,
    updatedAt: balanceRow?.updatedAt ?? null,
    recent,
  });
});
