/**
 * Bootstrap the ingest service user.
 *
 * When `TRAIL_INGEST_TOKEN` is set, the engine accepts `Authorization: Bearer
 * <token>` on authenticated routes. Those requests still need a real row in
 * `users` — `queue_candidates.created_by` is a FK — so we idempotently seed
 * a single service user at boot.
 *
 * Scope: one service user, bound to one tenant. In v1 single-tenant that's
 * the only tenant; when multiple tenants exist, the operator must pick via
 * `TRAIL_INGEST_TENANT_SLUG`. Multi-tenant service auth (per-team tokens) is
 * F40.2 territory.
 */
import { tenants, users, type TrailDatabase } from '@trail/db';
import { eq } from 'drizzle-orm';

export const INGEST_USER_ID = 'service-ingest';

export async function ensureIngestUser(trail: TrailDatabase): Promise<void> {
  if (!process.env.TRAIL_INGEST_TOKEN) return;

  const slug = process.env.TRAIL_INGEST_TENANT_SLUG;
  const allTenants = await trail.db.select().from(tenants).all();

  let tenant;
  if (slug) {
    tenant = allTenants.find((t) => t.slug === slug);
    if (!tenant) {
      throw new Error(
        `TRAIL_INGEST_TENANT_SLUG="${slug}" not found — existing slugs: ${allTenants
          .map((t) => t.slug)
          .join(', ') || '(none)'}`,
      );
    }
  } else {
    if (allTenants.length === 0) {
      throw new Error(
        'TRAIL_INGEST_TOKEN set but no tenant exists yet — create one or unset the token',
      );
    }
    if (allTenants.length > 1) {
      throw new Error(
        `Multiple tenants exist (${allTenants.length}); set TRAIL_INGEST_TENANT_SLUG to pick one`,
      );
    }
    tenant = allTenants[0]!;
  }

  const existing = await trail.db
    .select({ id: users.id, tenantId: users.tenantId })
    .from(users)
    .where(eq(users.id, INGEST_USER_ID))
    .get();

  if (existing) {
    if (existing.tenantId !== tenant.id) {
      throw new Error(
        `Ingest user already bound to tenant ${existing.tenantId}, not ${tenant.id}. ` +
          `Change the slug back or delete the row to rebind.`,
      );
    }
    return;
  }

  await trail.db
    .insert(users)
    .values({
      id: INGEST_USER_ID,
      tenantId: tenant.id,
      email: 'ingest@trail.local',
      displayName: 'Ingest service',
      role: 'curator',
      onboarded: true,
    })
    .run();

  console.log(`  ingest user provisioned → tenant=${tenant.slug}`);
}
