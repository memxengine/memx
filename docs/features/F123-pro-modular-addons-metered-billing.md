# F123 — Pro Modular Add-ons + Metered Billing (Stripe)

> Pro-tier har 6 stackable add-ons (Neurons pack, Trails pack, Parallel boost, Daily sampling, Priority ingest, Connector pack) solgt via Stripe metered billing. Kunden opgraderer/nedgraderer per add-on individuelt uden at skifte tier. Fjerner behov for "Pro Extended"-tier og matcher SaaS-best-practice (Notion, Linear, Vercel). Tier: Pro. Effort: 3-5 days. Status: Planned.

## Problem

PRICING-PLAN.md § 3-4: uden metered tilkøb har Pro fast $75 og Business $999. Springet er 13× pris for 10× kapacitet — naturlige Pro-vækst-kunder har ingen sti. Alternativet er en ekstra "Pro Extended"-tier som skaber decision paralysis.

## Secondary Pain Points

- Customers who need just one more feature (e.g., more Neurons) must upgrade entire tier
- No revenue from incremental usage — all-or-nothing tier pricing
- Manual enterprise contract negotiation for every custom limit increase
- No self-service upgrade path for Pro customers

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

## Non-Goals

- Stripe subscription management UI (redirect to Stripe Portal for downgrades/cancellations)
- Proration handling (Stripe handles this automatically)
- Custom add-on pricing per customer (fixed prices for all)
- Invoice generation or PDF download (Stripe Portal handles this)
- Trial periods for add-ons (immediate activation on purchase)

## Technical Design

### Stripe Integration

```typescript
// apps/server/src/services/stripe.ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const ADDON_PRICES = {
  'neurons-pack': process.env.STRIPE_PRICE_NEURONS_PACK!,
  'trails-pack': process.env.STRIPE_PRICE_TRAILS_PACK!,
  'parallel-boost': process.env.STRIPE_PRICE_PARALLEL_BOOST!,
  'daily-sampling': process.env.STRIPE_PRICE_DAILY_SAMPLING!,
  'priority-ingest': process.env.STRIPE_PRICE_PRIORITY_INGEST!,
  'connector-pack': process.env.STRIPE_PRICE_CONNECTOR_PACK!,
};

export async function createCheckoutSession(
  tenantId: string,
  addon: string,
  returnUrl: string,
): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: ADDON_PRICES[addon], quantity: 1 }],
    success_url: `${returnUrl}?success=true`,
    cancel_url: `${returnUrl}?canceled=true`,
    metadata: { tenantId, addon },
  });
  return session.url!;
}
```

### Webhook Handler

```typescript
// apps/server/src/routes/billing.ts
app.post('/api/v1/billing/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature']!;
  const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);

  switch (event.type) {
    case 'checkout.session.completed':
      await handleAddonPurchase(event.data.object);
      break;
    case 'customer.subscription.deleted':
      await handleAddonCancellation(event.data.object);
      break;
    case 'customer.subscription.updated':
      await handleAddonChange(event.data.object);
      break;
  }
  res.json({ received: true });
});

async function handleAddonPurchase(session: Stripe.Checkout.Session) {
  const { tenantId, addon } = session.metadata!;
  await applyAddonToTenant(tenantId, addon);
}
```

### Tenant Update Logic

```typescript
async function applyAddonToTenant(tenantId: string, addon: string): Promise<void> {
  const tenant = await db.select().from(tenants).where(eq(tenants.id, tenantId)).one();

  switch (addon) {
    case 'neurons-pack':
      await db.update(tenants).set({ maxNeuronsPerKb: tenant.maxNeuronsPerKb + 2500 }).where(eq(tenants.id, tenantId));
      break;
    case 'trails-pack':
      await db.update(tenants).set({ maxKbs: tenant.maxKbs + 2 }).where(eq(tenants.id, tenantId));
      break;
    case 'parallel-boost':
      await db.update(tenants).set({ parallelism: tenant.parallelism + 1 }).where(eq(tenants.id, tenantId));
      break;
    case 'daily-sampling':
      await db.update(tenants).set({ samplingFrequency: 'daily', samplingSize: 2000 }).where(eq(tenants.id, tenantId));
      break;
    case 'connector-pack':
      await db.update(tenants).set({ connectorPack: tenant.connectorPack | 1 }).where(eq(tenants.id, tenantId));
      break;
  }
}
```

### Grace Period

Grace-period ved billing-failure: 7 dage read-only mode før nedgrader til base Pro.

## Interface

### API Endpoints

```
POST /api/v1/billing/checkout
  Body: { addon: string }
  → 302 redirect to Stripe Checkout URL

POST /api/v1/billing/stripe-webhook
  Body: Stripe webhook event
  → 200 { received: true }

GET /api/v1/billing/portal
  → 302 redirect to Stripe Customer Portal
```

### Admin UI

Settings > Account displays current add-on stack with toggle-switches:

```
Add-ons:
[✓] Neurons pack (×2) — $50/mo  [Manage]
[ ] Trails pack — $15/mo         [Add]
[✓] Parallel boost (×1) — $30/mo [Manage]
```

## Rollout

**Phased deploy.** Phase 1: Stripe SDK integration + webhook endpoint (no UI). Phase 2: Admin Settings UI with toggle-switches. Phase 3: Stripe Portal embed for downgrades. Phase 4: grace period handling for billing failures.

## Success Criteria

- Kunde opgraderer Pro + 2 Neurons-pack i Stripe Portal, ser kapacitet stige inden for 30s (verified: webhook → tenant row updated → limits service returns new values)
- Stripe Webhook håndterer fejl + retries (verified: simulate webhook retry, idempotent handling)
- Annullering respekteres ved periode-slut (ikke instant) — verified: cancel at day 15, add-on active until period end
- Admin dashboard viser current add-on stack med opgraderings-CTA

## Impact Analysis

### Files created (new)

- `apps/server/src/services/stripe.ts`
- `apps/server/src/routes/billing.ts`
- `apps/server/src/services/__tests__/stripe.test.ts`

### Files modified

- `apps/server/src/app.ts` (mount billing routes)
- `apps/server/src/services/tenant-limits.ts` (add addon application logic)
- `apps/admin/src/components/settings-account.tsx` (add add-on toggle UI)

### Downstream dependents

`apps/server/src/app.ts` is imported by 4 files:
- `apps/server/src/index.ts` (1 ref) — creates app, unaffected
- `apps/server/src/routes/auth.ts` (1 ref) — dev mode, unaffected
- `apps/server/src/routes/health.ts` (1 ref) — health check, unaffected
- `apps/server/src/routes/api-keys.ts` (1 ref) — API key routes, unaffected
Mounting new route is additive.

`apps/server/src/services/tenant-limits.ts` is imported by 5 files:
- `apps/server/src/services/lint-scheduler.ts` (1 ref) — reads limits, unaffected by addon updates
- `apps/server/src/lib/concurrency.ts` (1 ref) — reads parallelism, unaffected
- `apps/server/src/services/llm-usage-tracker.ts` (1 ref) — reads budget, unaffected
- `apps/server/src/routes/user.ts` (1 ref) — reads limits, unaffected
- `apps/server/src/services/ingest.ts` (1 ref) — may check limits, unaffected
Addon application updates tenant row — consumers read fresh values on next call.

### Blast radius

- Stripe webhook must be idempotent — duplicate webhook deliveries should not double-apply addons
- Webhook signature verification is critical — unverified webhooks could allow unauthorized limit changes
- Addon cancellation must respect Stripe billing period end — instant cancellation would break customer expectations
- Grace period for billing failure: 7 days read-only mode must not delete data, just block writes
- Stripe SDK adds dependency — must handle network errors, timeouts, retries

### Breaking changes

None — all changes are additive. New routes, new service, new UI.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Checkout session creation returns valid Stripe URL
- [ ] Webhook handler processes `checkout.session.completed` → tenant limits updated
- [ ] Webhook handler processes `customer.subscription.deleted` → tenant limits reverted
- [ ] Webhook idempotency: same event delivered twice → limits updated only once
- [ ] Webhook signature verification rejects invalid signatures
- [ ] Admin UI shows correct add-on stack for tenant
- [ ] Stripe Portal redirect works for downgrade/cancel
- [ ] Grace period: billing failure → 7 days read-only, then downgrade
- [ ] Regression: tenant limits still enforced after addon updates

## Implementation Steps

1. Add Stripe SDK dependency to `apps/server/package.json`.
2. Implement `stripe.ts` service with checkout session creation.
3. Create billing routes: checkout, webhook, portal redirect.
4. Implement webhook handler with signature verification and idempotent addon application.
5. Implement addon cancellation handling (respect period end).
6. Add grace period logic for billing failures.
7. Build Admin Settings UI with add-on toggle-switches.
8. End-to-end test: purchase add-on in Stripe test mode → verify tenant limits updated.

## Dependencies

- F122 (plan limits på tenants-tabellen — add-ons opdaterer disse)

## Open Questions

- Should we use Stripe Checkout (redirect) or Stripe Elements (embedded) for add-on purchase? Checkout is simpler but redirects away from app.
- Should add-on quantities be tracked in our DB or only in Stripe? Tracking in our DB enables faster reads without Stripe API calls.

## Related Features

- **F122** (Plan Limits) — addons update tenant columns dynamically
- **F124** (CMS Content-Sync) — connector pack addon enables CMS connector
- **F119** (Parallel Contradiction Runner) — parallel boost addon increases concurrency
- **F118** (Contradiction-Scan Sampling) — daily sampling addon changes frequency

## Effort Estimate

**Medium** — 3-5 days. Stripe SDK + webhook + idempotent handling + admin UI + grace period.
