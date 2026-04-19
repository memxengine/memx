# F121 — Per-Tenant LLM Budget Tracking + Soft-cap

*Planned. Tier: infrastruktur (prerequisite for Pro+). Effort: 2-3 days.*

> Hver tenant har et månedligt LLM-budget målt i dollar-ækvivalenter. Alle LLM-kald skriver til en usage-log; når tenant nærmer sig cap får admin en warning, ved overskridelse degraderes service (soft-cap). Forudsætning for at sælge Pro uden risiko for runaway costs.

## Problem

Efter F120 API-migration betaler Trail (ikke Anthropic-subscription) for hver LLM-token. Uden per-tenant-tracking kan en enkelt kunde's aktive ingest-batch brænde $500+ i én nat uden at vi opdager det. Kritisk for unit-economics (jf. PRICING-PLAN.md § 10).

## Solution

Ny tabel:

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

Hver LLM-transport-call (F120) writer en row efter completion. Aggregate-query returnerer tenant's månedlige usage.

Plan-cap (på tenants-tabellen, F122): `monthly_llm_budget_usd_cents INTEGER NOT NULL`. Når 80 % ramt → email-notifikation + admin-badge. Ved 100 %:

- Starter/Pro: graceful degradation — chat svarer "budget overskredet, opgrader eller vent til næste måned"
- Business+: notification-only, ingen afbrydelse (antager SLA accepterer overage)

## How

- Migration + ny service `services/llm-usage-tracker.ts`
- `llm-client.ts` (F120) kaldes altid via wrapper der logger usage efter success
- Admin Settings > Account viser current-month usage + cap + forecast
- Usage-email-notifikation via eksisterende transactional-mail (eller simpel console-log indtil mail-infra lander)

## Dependencies

- F120 (API-migration — ingen mening at tracke Max-subscription-forbrug)
- F122 (plan limits definerer budgetterne)

## Success criteria

- Hver LLM-kald logger usage inden for 100ms af completion
- Tenant kan se current-month forbrug + resterende budget
- Soft-cap-degradation ved 100 % fungerer uden data-loss (ingen candidates korrumperes)
- Revenue-ops-team kan eksportere månedlig usage-CSV til reconciliation
