import { Hono } from 'hono';
import { db, users, documents, tenants } from '@trail/db';
import { eq, and, sql } from 'drizzle-orm';
import { requireAuth, getUser, getTenant } from '../middleware/auth.js';

export const userRoutes = new Hono();

userRoutes.use('*', requireAuth);

userRoutes.get('/me', (c) => {
  const user = getUser(c);

  const fullUser = db
    .select({
      id: users.id,
      tenantId: users.tenantId,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: users.role,
      onboarded: users.onboarded,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
      tenantPlan: tenants.plan,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(eq(users.id, user.id))
    .get();

  return c.json(fullUser);
});

userRoutes.post('/onboarding/complete', (c) => {
  const user = getUser(c);
  db.update(users)
    .set({ onboarded: true, updatedAt: new Date().toISOString() })
    .where(eq(users.id, user.id))
    .run();
  return c.body(null, 204);
});

userRoutes.get('/usage', (c) => {
  const tenant = getTenant(c);

  const stats = db
    .select({
      totalPages: sql<number>`COALESCE(SUM(${documents.pageCount}), 0)`,
      totalStorageBytes: sql<number>`COALESCE(SUM(${documents.fileSize}), 0)`,
      sourceCount: sql<number>`COUNT(CASE WHEN ${documents.kind} = 'source' THEN 1 END)`,
      wikiPageCount: sql<number>`COUNT(CASE WHEN ${documents.kind} = 'wiki' THEN 1 END)`,
    })
    .from(documents)
    .where(and(eq(documents.tenantId, tenant.id), eq(documents.archived, false)))
    .get();

  // Plan-based limits live on the tenant (Phase 2 will make these configurable).
  const planLimits: Record<string, { maxPages: number; maxStorageBytes: number }> = {
    hobby: { maxPages: 500, maxStorageBytes: 1_073_741_824 }, // 1 GB
    pro: { maxPages: 5_000, maxStorageBytes: 10_737_418_240 }, // 10 GB
    business: { maxPages: 50_000, maxStorageBytes: 107_374_182_400 }, // 100 GB
    enterprise: { maxPages: Number.MAX_SAFE_INTEGER, maxStorageBytes: Number.MAX_SAFE_INTEGER },
  };
  const limits = planLimits[tenant.plan] ?? planLimits.hobby!;

  return c.json({
    totalPages: stats?.totalPages ?? 0,
    totalStorageBytes: stats?.totalStorageBytes ?? 0,
    sourceCount: stats?.sourceCount ?? 0,
    wikiPageCount: stats?.wikiPageCount ?? 0,
    maxPages: limits.maxPages,
    maxStorageBytes: limits.maxStorageBytes,
    plan: tenant.plan,
  });
});
