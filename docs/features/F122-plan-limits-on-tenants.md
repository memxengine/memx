# F122 — Plan Limits on `tenants` Table

> Tier: infrastruktur. Effort: 1 day. Planned.

## Problem

I dag er plan-grænser hardcoded i `apps/server/src/routes/user.ts`:

```ts
const planLimits = {
  hobby: { maxPages: 500, maxStorageBytes: 1GB },
  pro: { maxPages: 5000, ... },
  ...
};
```

Enhver kunde-specifik grænse (fx "enterprise-kunde X får 200k pages") kræver kodeændring. Add-on-modellen (F123) har ingen naturlig persistens. F118 sampling + F119 parallelism har ingen stabil plan-source.

## Secondary Pain Points

- No per-tenant override capability for enterprise contracts
- Plan changes require code deployment instead of database update
- No audit trail for when/why plan limits were changed

## Solution

Udvid tenants-schemaet med eksplicitte kolonner for hver plan-grænse. Plan-definition bliver **per tenant** (med defaults seeded ved tier-assignment), ikke global kode. Stripe-webhook (F123) opdaterer disse felter ved add-on-køb/afmelding.

```sql
ALTER TABLE tenants ADD COLUMN max_kbs INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tenants ADD COLUMN max_neurons_per_kb INTEGER NOT NULL DEFAULT 500;
ALTER TABLE tenants ADD COLUMN max_storage_bytes INTEGER NOT NULL DEFAULT 1073741824;
ALTER TABLE tenants ADD COLUMN parallelism INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tenants ADD COLUMN sampling_frequency TEXT
  CHECK (sampling_frequency IN ('off','manual','weekly','daily')) NOT NULL DEFAULT 'off';
ALTER TABLE tenants ADD COLUMN sampling_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN connector_pack INTEGER NOT NULL DEFAULT 0; -- 0=none, 1=cms, etc. (bitmask)
ALTER TABLE tenants ADD COLUMN monthly_llm_budget_usd_cents INTEGER NOT NULL DEFAULT 0;
```

## Non-Goals

- Dynamic plan UI builder (hardcoded tiers with per-tenant overrides)
- Plan history/audit trail (that's F144)
- Multi-currency support (USD only)
- Automatic plan upgrades based on usage patterns

## Technical Design

### Schema Migration

8 new columns on `tenants` table as shown above. All have defaults so existing rows are unaffected.

### Plan Defaults Function

```typescript
// apps/server/src/services/tenant-limits.ts
interface PlanDefaults {
  maxKbs: number;
  maxNeuronsPerKb: number;
  maxStorageBytes: number;
  parallelism: number;
  samplingFrequency: 'off' | 'manual' | 'weekly' | 'daily';
  samplingSize: number;
  connectorPack: number; // bitmask
  monthlyLlmBudgetUsdCents: number;
}

const TIER_DEFAULTS: Record<string, PlanDefaults> = {
  starter: {
    maxKbs: 1,
    maxNeuronsPerKb: 500,
    maxStorageBytes: 1_073_741_824, // 1GB
    parallelism: 1,
    samplingFrequency: 'manual',
    samplingSize: 0,
    connectorPack: 0,
    monthlyLlmBudgetUsdCents: 5000, // $50
  },
  pro: {
    maxKbs: 3,
    maxNeuronsPerKb: 5000,
    maxStorageBytes: 10_737_418_240, // 10GB
    parallelism: 2,
    samplingFrequency: 'weekly',
    samplingSize: 500,
    connectorPack: 0,
    monthlyLlmBudgetUsdCents: 25000, // $250
  },
  business: {
    maxKbs: 10,
    maxNeuronsPerKb: 50000,
    maxStorageBytes: 107_374_182_400, // 100GB
    parallelism: 4,
    samplingFrequency: 'daily',
    samplingSize: 2000,
    connectorPack: 1, // CMS connector
    monthlyLlmBudgetUsdCents: 100000, // $1000
  },
  enterprise: {
    maxKbs: 999,
    maxNeuronsPerKb: 999999,
    maxStorageBytes: 1_099_511_627_776, // 1TB
    parallelism: 8,
    samplingFrequency: 'daily',
    samplingSize: 10000,
    connectorPack: 255, // all connectors
    monthlyLlmBudgetUsdCents: 1000000, // $10000
  },
};

export function applyPlanDefaults(tenant: Tenant, plan: string): Tenant {
  const defaults = TIER_DEFAULTS[plan];
  return { ...tenant, ...defaults };
}
```

### Seed Migration for Existing Tenants

```typescript
// Migration script: read current `plan` enum, apply defaults
for (const tenant of existingTenants) {
  await db.update(tenants)
    .set(applyPlanDefaults(tenant, tenant.plan))
    .where(eq(tenants.id, tenant.id));
}
```

### Read Path

```typescript
export function getTenantLimits(db: TrailDatabase, tenantId: string): Promise<PlanDefaults> {
  return db.select(limitsColumns).from(tenants).where(eq(tenants.id, tenantId)).get();
}
```

## Interface

```typescript
// GET /api/v1/tenant/limits → PlanDefaults
// POST /api/v1/admin/tenants/:id/limits (admin override)
interface TenantLimitOverride {
  maxKbs?: number;
  maxNeuronsPerKb?: number;
  maxStorageBytes?: number;
  parallelism?: number;
  samplingFrequency?: 'off' | 'manual' | 'weekly' | 'daily';
  samplingSize?: number;
  connectorPack?: number;
  monthlyLlmBudgetUsdCents?: number;
}
```

## Rollout

**Single-phase deploy.** Migration is additive with defaults. Seed existing tenants from current plan enum. Deploy migration + seed + service in same PR.

## Success Criteria

- Plan-skift via Stripe-webhook opdaterer tenant-row kolonner korrekt
- Enterprise-kontrakt kan sætte fx `max_neurons_per_kb: 1000000` uden kodeændring
- F118 sampling-scheduler læser `sampling_size` per tenant
- Admin-UI viser "Din plan: Pro + 2× Neurons-pack — 10.000 Neurons / 3 Trails / P=4"

## Impact Analysis

### Files created (new)
- `apps/server/src/services/tenant-limits.ts`

### Files modified
- `packages/db/src/schema.ts` (add 8 columns to tenants)
- `apps/server/src/routes/user.ts` (replace hardcoded planLimits with DB reads)
- `apps/server/src/app.ts` (no change — user route already mounted)

### Downstream dependents
`apps/server/src/routes/user.ts` is imported by 1 file:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected

`packages/db/src/schema.ts` is imported by 1 file:
- `packages/core/src/kb/resolve.ts` (1 ref) — reads document schema, unaffected by additive columns

### Blast radius

- All existing tenants get default values — must verify these match current hardcoded behavior
- Admin override endpoint could be misused if not properly auth-guarded
- Stripe webhook (F123) will update these columns — race conditions possible if webhook fires during manual override
- `connector_pack` bitmask design limits to 8 connectors — sufficient for now but not infinite

### Breaking changes

None — all changes are additive. Existing `plan` enum column remains for backward compat.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Migration adds all 8 columns with correct defaults
- [ ] Seed migration correctly applies defaults based on existing plan enum
- [ ] `applyPlanDefaults('pro')` returns correct values
- [ ] Admin override endpoint updates tenant row
- [ ] Starter tenant gets sampling_size=0, parallelism=1
- [ ] Business tenant gets sampling_size=2000, parallelism=4
- [ ] Regression: existing plan-based UI still shows correct tier name
- [ ] Regression: F118 sampling reads correct sampling_size per tenant

## Implementation Steps

1. Add 8 new columns to `tenants` schema with migration.
2. Create seed migration script to populate existing tenants from current plan enum.
3. Create `apps/server/src/services/tenant-limits.ts` with `applyPlanDefaults()` and `getTenantLimits()`.
4. Update `routes/user.ts` to read limits from DB instead of hardcoded map.
5. Add admin override endpoint `POST /api/v1/admin/tenants/:id/limits`.
6. Add admin UI for displaying current limits in Settings > Trail.

## Dependencies

- F118 (sampling — consumes sampling_size column)
- F119 (parallelism — consumes parallelism column)
- F121 (budget tracking — consumes monthly_llm_budget_usd_cents column)
- F123 (metered billing — modifies columns dynamically via Stripe webhook)

## Open Questions

None — all decisions made.

## Related Features

- **F118** (Contradiction-Scan Sampling) — reads `sampling_size` and `sampling_frequency`
- **F119** (Parallel Contradiction Runner) — reads `parallelism`
- **F121** (Per-Tenant Budget Tracking) — reads `monthly_llm_budget_usd_cents`
- **F123** (Pro Modular Add-ons) — modifies columns via Stripe webhook
- **F124** (CMS Content-Sync) — reads `connector_pack` bitmask

## Effort Estimate

**Small** — 1 day.
- Half day: Migration + seed script + service
- Half day: Route update + admin UI
