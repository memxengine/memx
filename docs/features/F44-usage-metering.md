# F44 — Usage Metering

> Count ingests, queries, tokens, storage per tenant. Surfaces in customer dashboard, enforces plan quotas (soft then hard), feeds Stripe invoices on Business tier.

## Problem

Uden usage metering kan Trail ikke:
- Vise brugere hvor meget de har brugt (transparens)
- Håndhæve plan-grænser (100 sources på Hobby, 2k på Pro)
- Facturere korrekt på Business tier (metered billing)
- Identificere heavy users der skal opgraderes

I dag tracks ingenting systematisk. Hver operation (upload, query, ingest) sker uden at tælle med.

## Solution

En `logUsage(tenantId, metric, amount)` funktion der kaldes fra alle relevante endpoints. Data gemmes i en ny `usage_events` tabel med daglig aggregation til `usage_daily` for effektiv querying.

Plan-grænser håndhæves ved at checke `usage_daily` mod `tenants.plan_limits` før tunge operationer. Soft limit = warning i dashboard. Hard limit = operation blocked.

## Technical Design

### 1. Usage Events Schema

```typescript
// packages/db/src/schema.ts

export const usageEvents = sqliteTable('usage_events', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  /** Metric type: 'ingest', 'query', 'tokens_input', 'tokens_output', 'storage_bytes' */
  metric: text('metric').notNull(),
  /** Amount (tokens count, bytes, or 1 for count-based metrics) */
  amount: integer('amount').notNull(),
  /** Source document ID (for ingest/query traceability) */
  documentId: text('document_id'),
  /** Chat session ID (for query traceability) */
  sessionId: text('session_id'),
  createdAt: text('created_at').notNull(),
});

export const usageDaily = sqliteTable('usage_daily', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  date: text('date').notNull(), // YYYY-MM-DD
  metric: text('metric').notNull(),
  total: integer('total').notNull().default(0),
});
```

### 2. Usage Logging

```typescript
// packages/core/src/usage/logger.ts

import { usageEvents, usageDaily } from '@trail/db';
import { eq, and, sql } from 'drizzle-orm';

export type UsageMetric = 'ingest' | 'query' | 'tokens_input' | 'tokens_output' | 'storage_bytes';

export async function logUsage(
  trail: TrailDatabase,
  tenantId: string,
  metric: UsageMetric,
  amount: number,
  documentId?: string,
  sessionId?: string,
): Promise<void> {
  const now = new Date().toISOString();
  const today = now.slice(0, 10); // YYYY-MM-DD

  // Insert event (fire-and-forget — don't block the operation)
  trail.db.insert(usageEvents).values({
    id: crypto.randomUUID(),
    tenantId,
    metric,
    amount,
    documentId: documentId ?? null,
    sessionId: sessionId ?? null,
    createdAt: now,
  }).run().catch(() => {});

  // Update daily aggregate (upsert)
  await trail.db
    .insert(usageDaily)
    .values({
      id: `${tenantId}-${today}-${metric}`,
      tenantId,
      date: today,
      metric,
      total: amount,
    })
    .onConflictDoUpdate({
      target: usageDaily.id,
      set: { total: sql`${usageDaily.total} + ${amount}` },
    })
    .run();
}
```

### 3. Usage Check (Plan Limits)

```typescript
// packages/core/src/usage/check.ts

import { usageDaily } from '@trail/db';
import { eq, and, gt } from 'drizzle-orm';

export interface PlanLimits {
  maxSources: number;
  maxQueries: number;
  maxIngests: number;
  maxStorageBytes: number;
}

const PLAN_LIMITS: Record<string, PlanLimits> = {
  hobby: { maxSources: 100, maxQueries: 1000, maxIngests: 50, maxStorageBytes: 100 * 1024 * 1024 },
  pro: { maxSources: 2000, maxQueries: 50000, maxIngests: 500, maxStorageBytes: 5 * 1024 * 1024 * 1024 },
  business: { maxSources: 0, maxQueries: 0, maxIngests: 0, maxStorageBytes: 0 }, // unlimited
};

export interface UsageStatus {
  metric: UsageMetric;
  current: number;
  limit: number;
  percentage: number;
  exceeded: boolean;
  warning: boolean; // > 80% of limit
}

export async function checkUsage(
  trail: TrailDatabase,
  tenantId: string,
  plan: string,
): Promise<UsageStatus[]> {
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.hobby;
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01'; // YYYY-MM-01

  // Get monthly totals
  const monthlyUsage = await trail.db
    .select({ metric: usageDaily.metric, total: sql<number>`sum(${usageDaily.total})` })
    .from(usageDaily)
    .where(and(
      eq(usageDaily.tenantId, tenantId),
      gt(usageDaily.date, monthStart),
    ))
    .groupBy(usageDaily.metric)
    .all();

  const usageMap = new Map<string, number>();
  for (const row of monthlyUsage) {
    usageMap.set(row.metric, row.total);
  }

  const metrics: { metric: UsageMetric; limit: number }[] = [
    { metric: 'ingest', limit: limits.maxIngests },
    { metric: 'query', limit: limits.maxQueries },
    { metric: 'storage_bytes', limit: limits.maxStorageBytes },
  ];

  return metrics.map(({ metric, limit }) => {
    const current = usageMap.get(metric) ?? 0;
    const percentage = limit > 0 ? (current / limit) * 100 : 0;
    return {
      metric,
      current,
      limit,
      percentage,
      exceeded: limit > 0 && current >= limit,
      warning: limit > 0 && percentage >= 80,
    };
  });
}

export async function enforceUsageLimit(
  trail: TrailDatabase,
  tenantId: string,
  plan: string,
  metric: UsageMetric,
): Promise<{ allowed: boolean; reason?: string }> {
  const status = await checkUsage(trail, tenantId, plan);
  const match = status.find((s) => s.metric === metric);

  if (match?.exceeded) {
    return { allowed: false, reason: `${metric} limit exceeded (${match.current}/${match.limit})` };
  }

  return { allowed: true };
}
```

### 4. Integration Points

```typescript
// apps/server/src/routes/uploads.ts — log ingest usage
await logUsage(trail, tenant.id, 'ingest', 1, docId);
await logUsage(trail, tenant.id, 'storage_bytes', file.size);

// apps/server/src/routes/chat.ts — log query + tokens usage
await logUsage(trail, tenant.id, 'query', 1, undefined, sessionId);
await logUsage(trail, tenant.id, 'tokens_input', tokenUsage.input, undefined, sessionId);
await logUsage(trail, tenant.id, 'tokens_output', tokenUsage.output, undefined, sessionId);
```

### 5. Usage Dashboard Endpoint

```typescript
// apps/server/src/routes/usage.ts

export const usageRoutes = new Hono();

usageRoutes.get('/usage', async (c) => {
  const tenant = getTenant(c);
  const usage = await checkUsage(getTrail(c), tenant.id, tenant.plan);
  return c.json({ usage, plan: tenant.plan });
});
```

## Impact Analysis

### Files created (new)
- `packages/db/src/schema.ts` — usage_events + usage_daily tables (migration)
- `packages/core/src/usage/logger.ts` — usage logging
- `packages/core/src/usage/check.ts` — usage check + enforcement
- `packages/core/src/usage/__tests__/check.test.ts`
- `apps/server/src/routes/usage.ts` — usage dashboard endpoint
- `apps/admin/src/pages/usage-dashboard.tsx` — usage dashboard UI

### Files modified
- `apps/server/src/routes/uploads.ts` — log usage on upload/ingest
- `apps/server/src/routes/chat.ts` — log usage on query
- `apps/server/src/app.ts` — mount usage routes
- `packages/core/src/index.ts` — export usage module

### Downstream dependents for modified files

**`apps/server/src/routes/uploads.ts`** — adding usage logging is additive. Existing upload flow unchanged.

**`apps/server/src/routes/chat.ts`** — adding usage logging is additive. Existing chat flow unchanged.

### Blast radius
- Usage logging is fire-and-forget — doesn't block operations if DB write fails
- Daily aggregation keeps query performance good (no full table scans)
- Plan limits are checked before expensive operations (ingest, query) — adds one DB query per operation
- Business tier has unlimited limits (0 = unlimited) — no enforcement

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `logUsage` inserts event and updates daily aggregate
- [ ] Unit: `checkUsage` returns correct percentages for each metric
- [ ] Unit: `enforceUsageLimit` blocks when limit exceeded
- [ ] Unit: `enforceUsageLimit` allows when under limit
- [ ] Integration: Upload file → ingest + storage usage logged
- [ ] Integration: Chat query → query + token usage logged
- [ ] Integration: Usage dashboard shows current month totals
- [ ] Integration: Hobby tenant blocked after 100 sources
- [ ] Regression: Upload/chat flow unchanged when usage logging fails

## Implementation Steps

1. Create usage_events + usage_daily tables + migration
2. Create `packages/core/src/usage/logger.ts` + unit tests
3. Create `packages/core/src/usage/check.ts` + unit tests
4. Integrate usage logging into upload and chat routes
5. Create usage dashboard endpoint
6. Create usage dashboard UI in admin
7. Integration test: full usage flow → dashboard shows correct numbers
8. Test plan limit enforcement (soft warning + hard block)

## Dependencies

- F43 (Stripe Billing) — usage data feeds metered billing
- F122 (Plan Limits on tenants) — plan limits defined per tenant

## Effort Estimate

**Medium** — 2-3 days

- Day 1: Schema + logger + check logic + unit tests
- Day 2: Integration into upload/chat routes + usage endpoint
- Day 3: Dashboard UI + limit enforcement + testing
