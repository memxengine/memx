# F123 — Pro Modular Add-ons + Metered Billing (Stripe)

*Planned. Tier: Pro. Effort: 3-5 days.*

> Pro-tier har 6 stackable add-ons (Neurons pack, Trails pack, Parallel boost, Daily sampling, Priority ingest, Connector pack) solgt via Stripe metered billing. Kunden opgraderer/nedgraderer per add-on individuelt uden at skifte tier. Fjerner behov for "Pro Extended"-tier og matcher SaaS-best-practice (Notion, Linear, Vercel).

## Problem

PRICING-PLAN.md § 3-4: uden metered tilkøb har Pro fast $75 og Business $999. Springet er 13× pris for 10× kapacitet — naturlige Pro-vækst-kunder har ingen sti. Alternativet er en ekstra "Pro Extended"-tier som skaber decision paralysis.

## Solution

6 add-ons via Stripe Price-objects:

| Add-on | Stripe Price | Effekt på `tenants`-felter (F122) |
|---|---|---|
| Neurons pack (×1-6) | $25/mdr metered | `max_neurons_per_kb += 2500` |
| Trails pack (×1-4) | $15/mdr metered | `max_kbs += 2` |
| Parallel boost (×1-2) | $30/mdr metered | `parallelism += 1` |
| Daily sampling | $40/mdr | `sampling_frequency = 'daily'`, `sampling_size = 2000` |
| Priority ingest | $20/mdr | flag der giver egen ingest-lane |
| Connector pack | $15/mdr | `connector_pack |= 1` (Slack/GitHub/Linear/Notion) |

Admin-UI i Settings > Account: toggle-switches per add-on. Klik → redirect til Stripe Checkout → webhook modtaget → F122 tenants-row opdateret.

## How

- Integrér Stripe SDK + webhook-endpoint `POST /api/v1/billing/stripe-webhook`
- Metered usage rapporteres ikke live (ingen per-action charge) — bare add-on-subscription
- Stripe Portal embeddes for downgrade/cancel
- Grace-period ved billing-failure: 7 dage read-only mode før nedgrader til base Pro

## Dependencies

- F122 (plan limits på tenants-tabellen — add-ons opdaterer disse)

## Success criteria

- Kunde opgraderer Pro + 2 Neurons-pack i Stripe Portal, ser kapacitet stige inden for 30s
- Stripe Webhook håndterer fejl + retries
- Annullering respekteres ved periode-slut (ikke instant)
- Admin dashboard viser current add-on stack med opgraderings-CTA
