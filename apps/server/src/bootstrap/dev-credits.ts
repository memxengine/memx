/**
 * F156 Phase 0 — boot-time dev credits seed.
 *
 * Reads `TRAIL_DEV_CREDITS` (integer count, default 0). For every
 * tenant in the database, ensures balance >= TRAIL_DEV_CREDITS. Uses
 * `seedDevCredits` from the credits service so the existing balance is
 * never decreased — only topped up.
 *
 * Why this is here:
 *   - Phase 0 has no Stripe Checkout. Without a way to put credits on a
 *     tenant's balance, every consume goes negative immediately and the
 *     UI displays alarmist numbers during local dev.
 *   - On boot, we run `seedDevCredits` for every tenant. Idempotent —
 *     a re-boot with the same env-var is a no-op.
 *   - Production tenants will have TRAIL_DEV_CREDITS unset (or 0); the
 *     function returns early without touching the DB.
 *
 * Phase 2 replaces this with Stripe Checkout for self-serve top-up.
 */

import { tenants, type TrailDatabase } from '@trail/db';
import { seedDevCredits } from '../services/credits.js';

export async function seedDevCreditsOnBoot(trail: TrailDatabase): Promise<void> {
  const raw = process.env.TRAIL_DEV_CREDITS;
  if (!raw) return;
  const target = Number(raw);
  if (!Number.isFinite(target) || target <= 0) return;

  const allTenants = await trail.db
    .select({ id: tenants.id })
    .from(tenants)
    .all();

  let seeded = 0;
  for (const t of allTenants) {
    const result = await seedDevCredits(trail, t.id, target);
    if (result.seeded) seeded += 1;
  }

  if (seeded > 0) {
    console.log(
      `[F156 dev-credits] seeded ${seeded}/${allTenants.length} tenants to ${target} credits`,
    );
  }
}
