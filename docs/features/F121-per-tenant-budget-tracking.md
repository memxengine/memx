# F121 — Per-Tenant LLM Budget Tracking + Soft-cap

> Tier: infrastruktur (prerequisite for Pro+). Effort: 2-3 days. Planned.

## Problem

Efter F120 API-migration betaler Trail (ikke Anthropic-subscription) for hver LLM-token. Uden per-tenant-tracking kan en enkelt kunde's aktive ingest-batch brænde $500+ i én nat uden at vi opdager det. Kritisk for unit-economics (jf. PRICING-PLAN.md § 10).

## Secondary Pain Points

- No visibility into which features consume the most LLM budget per tenant
- No way to forecast monthly spend before it happens
- No graceful degradation path when budget is exceeded

## Solution

Ny tabel `tenant_llm_usage` der tracker per-tenant, per-feature, per-month LLM forbrug i dollar-ækvivalenter. Hver LLM-transport-call (F120) writer en row efter completion. Aggregate-query returnerer tenant's månedlige usage.

Plan-cap (på tenants-tabellen, F122): `monthly_llm_budget_usd_cents INTEGER NOT NULL`. Når 80 % ramt → email-notifikation + admin-badge. Ved 100 %:

- Starter/Pro: graceful degradation — chat svarer "budget overskredet, opgrader eller vent til næste måned"
- Business+: notification-only, ingen afbrydelse (antager SLA accepterer overage)

## Non-Goals

- Real-time budget enforcement during a single LLM call (checked before call starts)
- Automatic credit card charging on overage (manual upgrade required)
- Per-feature budget sub-limits (only total monthly budget)
- Historical usage beyond 12 months (archive older data)

## Technical Design

### Schema

```sql
CREATE TABLE tenant_llm_usage (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month TEXT NOT NULL,  -- 'YYYY-MM'
  feature TEXT NOT NULL,  -- 'ingest', 'chat', 'contradiction', 'translation', ...
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_cents INTEGER NOT NULL DEFAULT 0,  -- stored as cents for precision
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_usage_tenant_month ON tenant_llm_usage(tenant_id, month);
```

### Usage Tracker Service

```typescript
// apps/server/src/services/llm-usage-tracker.ts
interface LlmUsageRecord {
  tenantId: string;
  month: string; // 'YYYY-MM'
  feature: 'ingest' | 'chat' | 'contradiction' | 'translation' | 'source-inferer' | 'action-recommender' | 'fine-tune';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsdCents: number;
}

export async function logLlmUsage(db: TrailDatabase, record: LlmUsageRecord): Promise<void> {
  await db.insert(tenantLlmUsage).values(record);
}

export async function getTenantMonthlyUsage(db: TrailDatabase, tenantId: string, month: string): Promise<{
  totalCostCents: number;
  budgetCents: number;
  usagePercent: number;
  byFeature: Record<string, number>;
}> {
  // Aggregate query by feature
}

export async function checkBudgetBeforeCall(db: TrailDatabase, tenantId: string): Promise<{
  allowed: boolean;
  remainingCents: number;
  usagePercent: number;
}> {
  // Returns allowed: false if tenant has exceeded budget and is Starter/Pro
}
```

### Cost Calculation

```typescript
// Pricing per model (cents per 1M tokens)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 300, output: 1500 },
  'claude-haiku-20241022': { input: 25, output: 125 },
  'claude-opus-20240229': { input: 1500, output: 7500 },
};

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 100); // cents
}
```

### Integration Point

`llm-client.ts` (F120) calls `logLlmUsage()` after each successful completion, passing the `ConversationResult.usage` data.

### Soft-Cap Enforcement

```typescript
// In llm-client.ts, before making API call:
const budget = await checkBudgetBeforeCall(db, tenantId);
if (!budget.allowed) {
  throw new BudgetExceededError(tenantId, budget.remainingCents);
}
if (budget.usagePercent >= 80) {
  await sendBudgetWarning(tenantId, budget.usagePercent);
}
```

## Interface

```typescript
// GET /api/v1/tenant/usage?month=2026-04
interface UsageResponse {
  totalCostCents: number;
  budgetCents: number;
  usagePercent: number;
  byFeature: Record<string, { tokens: number; costCents: number }>;
  warningThreshold: number; // 80
}

// POST /api/v1/tenant/usage/export (CSV export for reconciliation)
interface UsageExportRequest {
  month: string;
  format: 'csv' | 'json';
}
```

## Rollout

**Phased deploy:**
1. Ship schema migration + tracker service (no enforcement)
2. Wire into llm-client.ts for logging only
3. Add admin UI for usage display
4. Enable soft-cap enforcement for Starter/Pro tiers
5. Add CSV export for revenue-ops reconciliation

## Success Criteria

- Hver LLM-kald logger usage inden for 100ms af completion
- Tenant kan se current-month forbrug + resterende budget
- Soft-cap-degradation ved 100 % fungerer uden data-loss (ingen candidates korrumperes)
- Revenue-ops-team kan eksportere månedlig usage-CSV til reconciliation

## Impact Analysis

### Files created (new)
- `apps/server/src/services/llm-usage-tracker.ts`
- `apps/server/src/routes/usage.ts`
- `apps/server/src/errors/budget-exceeded.ts`

### Files modified
- `apps/server/src/services/llm-client.ts` (F120, call logLlmUsage after completion)
- `packages/db/src/schema.ts` (add tenant_llm_usage table + monthly_llm_budget_usd_cents to tenants)
- `apps/server/src/app.ts` (mount usage route)
- `apps/server/src/routes/chat.ts` (check budget before chat calls)
- `apps/server/src/routes/ingest.ts` (check budget before ingest starts)

### Downstream dependents
`apps/server/src/services/llm-client.ts` is imported by multiple services (from F120):
- `apps/server/src/services/ingest.ts` (1 ref) — will add budget check
- `apps/server/src/routes/chat.ts` (1 ref) — will add budget check
- `apps/server/src/services/translation.ts` (1 ref) — will add budget check
- `apps/server/src/services/source-inferer.ts` (1 ref) — will add budget check
- `apps/server/src/services/contradiction-lint.ts` (1 ref) — will add budget check
- `apps/server/src/services/action-recommender.ts` (1 ref) — will add budget check

`packages/db/src/schema.ts` is imported by 1 file:
- `packages/core/src/kb/resolve.ts` (1 ref) — reads document schema, unaffected by additive table

`apps/server/src/routes/chat.ts` is imported by 1 file:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected

`apps/server/src/routes/ingest.ts` is imported by 1 file:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected

### Blast radius

- Budget check adds latency before every LLM call — must be cached or batched
- Incorrect cost calculation could under/over-charge tenants
- `tenant_llm_usage` table grows linearly with LLM calls — may need periodic aggregation
- Soft-cap enforcement on Starter/Pro could break mid-ingest if budget exceeded during batch
- Business+ tier with no hard cap could still run up unexpected costs

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] LLM call logs usage row with correct tokens and cost
- [ ] Cost calculation matches Anthropic pricing for each model
- [ ] Budget check at 79% returns allowed: true
- [ ] Budget check at 80% returns allowed: true with warning flag
- [ ] Budget check at 100% for Starter returns allowed: false
- [ ] Budget check at 100% for Business returns allowed: true (notification only)
- [ ] Usage endpoint returns correct aggregation by feature
- [ ] CSV export matches database totals
- [ ] Regression: LLM calls still complete when budget is well under cap
- [ ] Regression: existing ingest/chat flows unaffected when no budget configured

## Implementation Steps

1. Add `tenant_llm_usage` table and `monthly_llm_budget_usd_cents` column to schema.
2. Create `apps/server/src/services/llm-usage-tracker.ts` with log, query, and budget-check functions.
3. Create `apps/server/src/errors/budget-exceeded.ts` error class.
4. Wire `logLlmUsage()` into `llm-client.ts` after each completion.
5. Add budget check before LLM calls in chat and ingest routes.
6. Create `apps/server/src/routes/usage.ts` with GET usage and POST export endpoints.
7. Add admin UI for current-month usage display.
8. Implement email notification at 80% threshold.

## Dependencies

- F120 (API-migration — no point tracking Max-subscription usage)
- F122 (plan limits defines the budgets)

## Open Questions

None — all decisions made.

## Related Features

- **F120** (Anthropic API Migration) — provides usage data from LLM calls
- **F122** (Plan Limits on Tenants) — provides `monthly_llm_budget_usd_cents` column
- **F123** (Pro Modular Add-ons) — add-ons may increase budget
- **F116** (Synthetic Training Data Export) — heavy LLM usage, must respect budget

## Effort Estimate

**Small** — 2-3 days.
- Day 1: Schema + tracker service + cost calculation
- Day 2: Wire into llm-client + budget checks
- Day 3: Usage endpoint + admin UI + CSV export
