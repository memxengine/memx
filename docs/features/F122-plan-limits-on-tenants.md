# F122 — Plan Limits on `tenants` Table

*Planned. Tier: infrastruktur. Effort: 1 day.*

> Skift plan-grænserne fra hardcoded map i `routes/user.ts` til eksplicitte kolonner på tenants-tabellen. Tillader per-tenant override for enterprise-kontrakter + danner grundlag for F123 add-on billing.

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

## Solution

Udvid tenants-schemaet:

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

Plan-definition bliver derfor **per tenant** (med defaults seeded ved tier-assignment), ikke global kode. Stripe-webhook (F123) opdaterer disse felter ved add-on-køb/afmelding.

## How

- Schema-migration med ALTER TABLE + seed-data for eksisterende tenants baseret på current `plan`-enum
- Plan-preset-funktion `applyPlanDefaults(tenant, plan)` der sætter kolonnerne til standard-værdier for den valgte tier
- Read-sti: `services/tenant-limits.ts` returnerer current limits; F118/F119/F121 læser herfra
- Admin-UI i Settings > Trail: vis current limits, knap "Opgrader plan" → Stripe-portal

## Dependencies

- F118, F119, F121 (consumers af disse plan-kolonner)
- F123 (metered billing modificerer kolonnerne dynamisk)

## Success criteria

- Plan-skift via Stripe-webhook opdaterer tenant-row kolonner korrekt
- Enterprise-kontrakt kan sætte fx `max_neurons_per_kb: 1000000` uden kodeændring
- F118 sampling-scheduler læser `sampling_size` per tenant
- Admin-UI viser "Din plan: Pro + 2× Neurons-pack — 10.000 Neurons / 3 Trails / P=4"
