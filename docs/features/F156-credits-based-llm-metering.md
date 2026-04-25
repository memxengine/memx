# F156 — Credits-Based LLM Metering

> Bruger-vendt credits-valuta til LLM-forbrug. Hver plan inkluderer X credits/måned, ekstra credits købes som one-time pakker (100/200/500/1000/2000 credits). LLM-cost skjules bag et stabilt enhedsbegreb — det som skalerer omkostninger fra en post på vores regnskab til en del af tenant's abonnement. Tier: Phase 2 infrastructure · Effort: Medium · Status: Planned.

## Problem

Som det står i `SAAS-SCALING-PLAN.md` og den oprindelige `DEPLOYMENT-STAGES.md`, absorberer vi LLM-omkostninger i tier-prisen: "LLM-cost ~10-25 % af revenue, passer ind i margin." Det antagende passer ikke når:

- En Business-tenant kører batch-ingest på 400-siders PDF — Sonnet koster os $40-80 i én nat.
- En Pro-tenant har 12 aktive curatorer der re-compiler samme KB hele dagen.
- En voksende Enterprise-kunde med 200K Neurons fyrer contradiction-lint af hver time.

Hver af dem betaler én fast månedspris, men LLM-omkostningen spejler brugsmønstret — ikke planen. Resultat: vores gross margin bliver uforudsigelig, og vi må enten (a) sætte priserne højt nok til at dække worst-case (straffer let-brugere) eller (b) have loft på tier (straffer power-brugere).

Både alternativer er dårlige. Det rigtige svar er at **brugeren betaler for sin egen forbrug**, med en inkluderet grundmængde i abonnementet.

## Secondary Pain Points

- **Ingen incentiv til model-valg.** Hvis Flash er 10× billigere end Sonnet og tenant alligevel betaler samme månedspris uanset valg, har de ingen grund til at vælge Flash — også hvor den ville levere perfekt kvalitet. Credits binder brugerens pengepung til model-valget → folk optimerer af sig selv.
- **Ingen kobling mellem F149 Pluggable Backends og kommercielle incitamenter.** Vi har nu Flash/GLM/Qwen/Sonnet som runtime-valg. Uden credits er der ingen grund til at bruge den funktion.
- **USD cents er ikke et produkt.** "Du har brugt $12.43 i Sonnet-calls" er intern regnskabsdata. "Du har 47 credits tilbage" er en ren bruger-oplevelse med tydelig mental model.
- **Vi mangler kanal for one-time-revenue.** I dag er alt månedligt abonnement. Credits-pakker giver en transactional-revenue-stream der komplementerer subscription.
- **Enterprise-kontrakter bliver lettere.** I stedet for at forhandle per-bruger/per-Neuron/per-query limiter kan vi bare sige "12 000 credits/år i kontrakten, overforbrug på faktura" — én enkelt akse at forhandle om.

## Solution

Introducér **credits** som enheden for tenant's LLM-forbrug. **1 credit = $0.01 LLM-cost**, målt direkte fra OpenRouter's `usage.cost` felt på den faktiske API-response (F149 leverer dette per turn). Ingen separat multiplier-tabel — credits *er* cost, blot opskaleret til en hel-tals-enhed brugeren kan tælle. Alle ingest-jobs og ressource-tunge compile-cascades forbruger credits. **Chat forbruger også credits** (revideret 2026-04-25 sammen med F159 pluggable chat backends — den nye arkitektur gør det muligt at måle chat-cost ægte; default-modellen Gemini Flash holder per-turn-cost på ~0.1 credits så Hobby-tier ikke depleter på normal brug — se canonical-tabellen nedenfor). Lint, tag-aggregering, glossary og andre passive "baggrunds-features" forbruger **ikke** credits — de er inkluderet i abonnementet.

Hver plan inkluderer en månedlig grundkvote. Løber tenant tør → de kan købe credits-pakker som one-time-purchase via Stripe Checkout. Pakker udløber aldrig og akkumulerer.

### Chat credit-burn — canonical pricing-table (editable)

Chat-pricing per backend × model lever som canonical i `apps/server/src/data/chat-pricing.yaml`. Tabellen er hot-reloadable og udgør sandheden for både F159's `runChat()` cost-stamping og F156's credit-decrement. Ændringer her ændrer alle tenants's chat-cost øjeblikkeligt — brugen er bevidst minimal; vi rør den når en ny model kommer eller en provider ændrer pricing.

```yaml
# apps/server/src/data/chat-pricing.yaml — F156 + F159 canonical
# Per-turn-estimater bruges KUN til UI-fremvisning (preview "den her chat
# vil koste ~0.1 credits"). Den faktiske credit-burn er den observerede
# cost fra OpenRouter usage.cost — denne tabel er for transparens, ikke
# debitering.
models:
  google/gemini-2.5-flash:
    typical_in_tokens: 1500       # system + context + history + user msg
    typical_out_tokens: 600       # assistant answer
    credits_per_turn_estimate: 0.1
    notes: "default for alle tiers; ~1000 chats per Hobby-credit-pulje (100c)"
  google/gemini-2.5-pro:
    credits_per_turn_estimate: 0.4
  anthropic/claude-haiku-4-5:
    credits_per_turn_estimate: 1.5
  anthropic/claude-sonnet-4-6:
    credits_per_turn_estimate: 6.0
    notes: "premium chat; ~16 chats per Hobby-credit-pulje"

# Per-tier hard caps på daglige chat-turns (bygger oven på credit-balance).
# Forhindrer en Hobby-tenant i at brænde alle 100 månedlige credits af
# på én Sonnet-eftermiddag — credit-systemet alene tillader det, men det
# er ikke en god UX (depletion uden warning).
tier_caps:
  hobby:    { daily_chat_turns_max: 50,   default_model: "google/gemini-2.5-flash" }
  starter:  { daily_chat_turns_max: 200,  default_model: "google/gemini-2.5-flash" }
  pro:      { daily_chat_turns_max: 2000, default_model: "google/gemini-2.5-flash" }
  business: { daily_chat_turns_max: null, default_model: "google/gemini-2.5-flash" }

# Soft alerts (in-app banner + email — F156 §"Notifications").
alerts:
  warn_at_pct: 80    # "Du har brugt 80% af månedens chat-credits"
  block_at_pct: 100  # "Du er løbet tør — opgrader eller køb pakke"
```

**Default-model er Gemini Flash på alle tiers** — også Pro+. Premium-modeller er bevidste opgraderinger via F152's runtime model switcher (udvidet til chat i F159), ikke usynlig drift. Anti-burn-disciplinen ligger her: man flipper til Sonnet pr. Trail når kvaliteten kræver det, ikke som default.

### Hvordan credits beregnes per ingest

Vi bruger den faktiske LLM-cost som returneres af provider, IKKE estimat fra tokens på vores side. Det er den industri-standard tilgang (OpenRouter, Anthropic Console, OpenAI usage API gør samme). Tokens er en proxy; cost er sandheden.

```typescript
// 1 credit = $0.01 = 1 cent USD af målt LLM-cost
const credits = Math.ceil(costCentsUsd);
```

**Hvad det betyder i praksis** (typiske ingest-cost ifølge live-cost-data fra F149/F151):

| Operation | Model | Typisk USD | ≈ credits |
|---|---|---:|---:|
| 10-siders PDF ingest (small KB) | Flash | $0.01 | **1** |
| 10-siders PDF ingest (small KB) | GLM | $0.02 | **2** |
| 10-siders PDF ingest (small KB) | Qwen | $0.03 | **3** |
| 10-siders PDF ingest (small KB) | Sonnet | $0.30 | **30** |
| 50-siders PDF (medium KB) | Flash | $0.05 | **5** |
| 50-siders PDF (medium KB) | Sonnet | $1.50 | **150** |
| 200-siders bog (large KB) | Flash | $0.20 | **20** |
| 200-siders bog (large KB) | Sonnet | $6.00 | **600** |
| Re-compile efter source-edit (cascade, 5 sider) | Flash | $0.005 | **1** (rounded up) |
| Re-compile efter source-edit (cascade, 5 sider) | Sonnet | $0.15 | **15** |
| Claude CLI (Max Plan, Christian's tenant kun) | — | $0 | **0** |

Multiplikatoren mellem modeller er **implicit** i den målte cost — Sonnet ER ca. 30× dyrere end Flash for samme job, fordi Anthropic's API faktisk koster 30× per token. Brugeren ser sandheden, og vi behøver ikke vedligeholde en separat multiplier-tabel der drifter mod virkeligheden.

### Token-til-credit konverteringsstandarder

For curators der vil regne på det forhånd (før de starter et ingest), publicerer vi en transparent reference baseret på provider-prislister (april 2026):

| Model | Input pris | Output pris | Credits per 1M input tokens | Credits per 1M output tokens |
|---|---:|---:|---:|---:|
| Gemini 2.5 Flash | $0.075/M | $0.30/M | 8 credits | 30 credits |
| GLM 4.6 | $0.14/M | $0.28/M | 14 credits | 28 credits |
| Qwen 3.6 Plus | $0.20/M | $0.60/M | 20 credits | 60 credits |
| Claude Sonnet 4.6 | $3.00/M | $15.00/M | 300 credits | 1500 credits |

En "typisk" ingest har 50 000 input tokens (PDF-tekst + prompt) og 8 000 output tokens (compiled wiki-pages). På Flash giver det 0.4 + 0.24 = 0.64 credits → rounded up til 1 credit. På Sonnet: 15 + 12 = 27 credits.

Tabellerne er rene **transparens**, ikke billing-mekanik. Faktisk afregning bruger altid OpenRouter's målte `usage.cost` som er den eneste sandhed.

Credits tracker vi i en ny `tenant_credits`-tabel + `credit_transactions`-logbog (append-only, til audit).

## Non-Goals

- **Ikke credits for chat, lint, tag-extraction, translation, glossary.** De features er altid inkluderet. Vi absorberer den baggrunds-LLM-cost. Ellers bliver produktet uforudsigeligt dyrt at bruge.
- **Ikke real-time blocking midt i et igangværende ingest-job.** Hvis et job starter med 3 credits tilbage og bruger 5, lades det gå i minus op til 10 % buffer. Efterfølgende jobs blokeres indtil top-up.
- **Ikke credit-bytte mellem tenants.** Én tenant kan ikke overføre credits til en anden.
- **Ikke udløbende credits.** Købte credits lever for evigt. (Enterprise-kontrakter kan have eksplicit udløb, men det er contract-specifikt).
- **Ikke free trial-credits ud over den inkluderede Hobby-kvote.** Hobby-tier er vores trial.
- **Ikke credit-prissætning baseret på input-length.** Vi bruger målt `cost_cents` fra OpenRouter-response (F149) som sandhed. Ingen tokenisering på vores side.
- **Ikke refund på ubrugte credits ved plan-nedgradering.** Credits følger tenant, ikke plan.
- **Ikke credits for F147 Share Extension indsamling.** Indsamling er gratis; compile af det indsamlede er hvad der koster.

## Technical Design

### Schema

Migration `0018_credits.sql`:

```sql
CREATE TABLE tenant_credits (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0,          -- current credit balance
  monthly_included INTEGER NOT NULL DEFAULT 0, -- plan-baseline per month (Starter=20, Pro=100...)
  last_monthly_topup_at TEXT,                  -- ISO datetime of last plan-baseline refill
  low_balance_alerted_at TEXT,                 -- last time we emailed "getting low"
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE credit_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- 'consume' | 'monthly_topup' | 'purchase' | 'adjustment' | 'refund'
  amount INTEGER NOT NULL,           -- positive for additions, negative for consumption
  balance_after INTEGER NOT NULL,
  related_job_id TEXT,               -- ingest_jobs.id when kind='consume'
  related_stripe_id TEXT,            -- Stripe Checkout session id when kind='purchase'
  note TEXT,                         -- optional operator note (for 'adjustment')
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_credit_tx_tenant ON credit_transactions(tenant_id, created_at DESC);
CREATE INDEX idx_credit_tx_job ON credit_transactions(related_job_id);
```

### Credit-consumption flow

```typescript
// packages/core/src/credits/consume.ts

/**
 * 1 credit = $0.01 LLM-cost. We use the provider-reported cost
 * (OpenRouter `usage.cost`, Anthropic API response cost-tracking)
 * as the source of truth — same approach OpenRouter, Anthropic
 * Console and OpenAI usage API all use. Tokens are a proxy; cost
 * is the truth and matches what we're actually billed.
 *
 * Claude CLI (Max Plan) returns 0 cost on the response — those
 * jobs consume 0 credits, only billable for Christian's tenant
 * who pays Anthropic directly via subscription.
 */
export function computeCreditsForJob(costCents: number): number {
  if (costCents <= 0) return 0;
  return Math.ceil(costCents);  // 1 cent = 1 credit; round up
}

export async function consumeCredits(
  trail: TrailDatabase,
  tenantId: string,
  credits: number,
  relatedJobId: string,
): Promise<{ remaining: number; wentNegative: boolean }> {
  // Transactional: lock tenant_credits row, deduct, append transaction.
  return await trail.transaction(async (tx) => {
    const row = await tx.select().from(tenantCredits).where(eq(tenantCredits.tenantId, tenantId)).for('update').get();
    const newBalance = (row?.balance ?? 0) - credits;
    await tx.update(tenantCredits).set({ balance: newBalance, updatedAt: iso() }).where(eq(tenantCredits.tenantId, tenantId)).run();
    await tx.insert(creditTransactions).values({
      id: txId(),
      tenantId,
      kind: 'consume',
      amount: -credits,
      balanceAfter: newBalance,
      relatedJobId,
      createdAt: iso(),
    }).run();
    return { remaining: newBalance, wentNegative: newBalance < 0 };
  });
}
```

### Pre-ingest gate

```typescript
// apps/server/src/services/ingest.ts — before runWithFallback

const currentBalance = await getCreditBalance(trail, tenantId);
const MIN_BUFFER_PCT = 10;  // allow overdraft up to 10% of monthly included
const maxOverdraft = Math.floor(tenantCredits.monthlyIncluded * (MIN_BUFFER_PCT / 100));
if (currentBalance < -maxOverdraft) {
  throw new CreditsExhaustedError(
    `Tenant ${tenantId} has no credits. Purchase more to continue ingesting.`,
  );
}
```

### Monthly top-up job

```typescript
// apps/server/src/services/credit-scheduler.ts

// Runs daily at 03:00 UTC. Tops up any tenant whose last_monthly_topup_at
// is older than 30 days, adding `monthly_included` credits + logging a
// 'monthly_topup' transaction.
```

### Purchase flow

Stripe Checkout one-time products. Pakker er kalibreret til 1 credit = $0.01 cost-baseline med 3-5× markup:

| Pack | Price | €/credit | Stripe Price ID env |
|---|---|---|---|
| 100 credits | €5 | €0.050 | `STRIPE_PRICE_CREDITS_100` |
| 200 credits | €9 | €0.045 | `STRIPE_PRICE_CREDITS_200` |
| 500 credits | €19 | €0.038 | `STRIPE_PRICE_CREDITS_500` |
| 1 000 credits | €35 | €0.035 | `STRIPE_PRICE_CREDITS_1000` |
| 2 000 credits | €60 | €0.030 | `STRIPE_PRICE_CREDITS_2000` |

Volume-rabatten opfordrer til større pakker. Vores cost per credit er $0.01 (= ~€0.0095 ved typisk EUR/USD), så pakker sælges for 3-5× markup. En 1000-credit-pakke til €35 dækker fx ~700 Flash-ingests eller ~33 Sonnet-ingests og koster os ~€9.5 LLM-cost = €25.5 marginal-margin.

Webhook `checkout.session.completed` → insert `credit_transactions` med `kind='purchase'` + top-up balance.

### Plan baselines

20× mere generøse end første draft — credits skal ikke føles som en tællekæde, og samtidig matcher vi det Karpathy/Notion/Linear-mønster hvor abonnementet føles inkluderende:

| Plan | Monthly credits included | Vores LLM-cost (subsidiseret) | Fits (typisk Flash) | Fits (typisk Sonnet) |
|---|---:|---:|---|---|
| Hobby (free) | 100 | ~$1 | ~50-100 små PDF'er | ~3 PDF'er |
| Starter (€29) | 400 | ~$4 | ~200-400 PDF'er | ~13 PDF'er |
| Pro (€149) | 2 000 | ~$20 | ~1500-2000 PDF'er | ~66 PDF'er |
| Business (€499) | 10 000 | ~$100 | ~7000-10000 PDF'er | ~300 PDF'er |
| Enterprise | Contract (typisk 50 000-500 000/år) | metered | hundredvis tusind | tusinder |

**Hvorfor Hobby = 100 (ikke 5):** Trail's value-prop er "se hvor god din egen brain bliver". Med 100 credits kan en gratis-bruger ingest'e 50-100 små Flash-PDF'er = en hel Karpathy-"idea file"-samling. 5 credits ville lade dem prøve én PDF og så møde paywall — det er trial-bait, ikke onboarding.

**Hvorfor Sonnet-fits er små:** En Sonnet-ingest af samme PDF er 30× dyrere end Flash. Tabellen viser tenant deres reelle valg: "Du kan ingest'e 100 PDF'er på Flash, eller 3 på Sonnet — vælg klogt." Det er F149's pluggable backends's kommercielle pointe.

### Admin UI

- **Top-nav pill**: `47 credits` — klikbar til Credits-panel. Rødt hvis <10, gult hvis <25 % af monthly_included, accent hvis >50%.
- **Settings > Credits & Billing**: current balance, månedlig top-up-dato, purchase-knapper for hver pakke, transaktions-historik (seneste 50), burn-rate-graf (credits per dag seneste 30 dage), forventet runway baseret på seneste 7 dages forbrug.
- **Per-Source-visning**: efter hver ingest vises "Cost: 3 credits" så curator ser hvad det kostede.
- **Model-dropdown (F152)**: ud for hver model-valg viser "1× / 2× / 10× credits" så valget er bevidst.

### Operator UI (F154 Control Plane)

- Fleet-wide credit spend-oversigt
- Per-tenant credit balance + burn rate
- Alert når tenant går under 10 credits eller overdrafter
- Manual credit adjustments (support-tool — med audit-log)

## Interface

### Endpoints

```
GET   /api/v1/credits                        → { balance, monthlyIncluded, lastTopupAt, burnRate7d, runway }
GET   /api/v1/credits/transactions?limit=50  → transaction history
POST  /api/v1/credits/purchase               → { packSize } → Stripe Checkout URL
```

### Shared types

```typescript
// packages/shared/src/credits.ts

export interface CreditBalance {
  balance: number;
  monthlyIncluded: number;
  lastMonthlyTopupAt: string | null;
  nextTopupAt: string;
  burnRate7dPerDay: number;
  estimatedRunwayDays: number | null;
}

export const CREDIT_PACK_SIZES = [100, 200, 500, 1000, 2000] as const;
export type CreditPackSize = (typeof CREDIT_PACK_SIZES)[number];

export const PLAN_MONTHLY_CREDITS = {
  hobby: 100,
  starter: 400,
  pro: 2000,
  business: 10000,
  enterprise: 0, // contract-specified
} as const;

/** 1 credit = 1 USD cent of measured LLM cost. Provider-reported,
 *  not estimated from tokens. Source of truth: OpenRouter
 *  `usage.cost` or Anthropic API response cost field. */
export const CENTS_PER_CREDIT = 1;
```

## Rollout

**Phase 1 — infrastructure, no enforcement (M5):**
- Schema migration 0018 lander
- `consumeCredits` kaldes fra ingest.ts efter hver completion
- Balance akkumulerer i negativ (da ingen top-up eksisterer endnu)
- Admin UI viser balance som informational pil
- Ingen hard enforcement — tenants kan overskride uden blokering
- Giver os 1 måneds data til at validere CENTS_PER_CREDIT + MODEL_FACTOR

**Phase 2 — monthly top-up + pack purchase (M6):**
- Credit-scheduler kører daglige top-ups
- Stripe Checkout wired
- Tenants modtager månedlig baseline
- Endnu ingen hard enforcement

**Phase 3 — soft enforcement (M7):**
- Email-alert ved 80 % og 100 % af monthly_included
- In-app banner ved <10 credits
- Nye ingests godtages stadig, men curator ser advarsel

**Phase 4 — hard enforcement (M8):**
- Negative balance over 10 % buffer → ingest blokeres
- Tydelig "Purchase more" modal
- Enterprise-tenants opt-out (deres kontrakt regulerer overforbrug via faktura)

## Success Criteria

1. **Predictable unit economics.** Efter M8: mindst 90 % af fleet-wide LLM-cost er dækket af credit-indtægter, ikke af subscription-margin. Målt gennem månedlig revenue-vs-cost-afstemning.
2. **Power-users betaler proportionelt.** Top 10 % af tenants efter credit-brug betaler mindst 2× gns subscription via credit-pakker. Målt efter 3 måneders drift.
3. **Model-valg drives af økonomi.** Andel af Flash-ingests stiger fra 20 % (estimat 2026-04) til >60 % efter credits-indførelse. F149 Pluggable Backends gives real kommerciel værdi.
4. **Nul curator-forvirring om pris.** I brugertest (n=5 curators): hver kan korrekt forudsige credit-cost for en given ingest før de starter den.
5. **Transparens via F154 Control Plane.** Operator kan på <30s fortælle om fleet er profitable for en given måned (fleet cost vs. sum af subscription + credit-revenue).

## Impact Analysis

### Files created (new)

- `packages/db/drizzle/0018_credits.sql` — tenant_credits + credit_transactions
- `packages/db/src/schema.ts` — tilføj de nye tabel-definitioner
- `packages/core/src/credits/consume.ts` — consumption logic
- `packages/core/src/credits/balance.ts` — balance + burn-rate queries
- `packages/core/src/credits/purchase.ts` — Stripe Checkout integration
- `packages/shared/src/credits.ts` — shared types + pack sizes + plan baselines
- `apps/server/src/routes/credits.ts` — GET balance/transactions, POST purchase
- `apps/server/src/services/credit-scheduler.ts` — monthly top-up cron
- `apps/server/src/services/stripe-credits-webhook.ts` — pack purchase webhook handler
- `apps/admin/src/panels/credits.tsx` — Settings > Credits & Billing
- `apps/admin/src/components/credit-balance-pill.tsx` — top-nav indicator
- `apps/server/scripts/verify-credits.ts` — end-to-end probe
- `docs/features/F156-credits-based-llm-metering.md` (dette dokument)

### Files modified

- `apps/server/src/services/ingest.ts` — call consumeCredits() on success, CreditsExhaustedError gate
- `apps/server/src/services/ingest/runner.ts` — track model-per-turn for accurate credit-factor
- `apps/admin/src/app.tsx` — mount credits panel route + top-nav pill
- `apps/admin/src/panels/cost.tsx` — add credits column alongside USD cost
- `apps/admin/src/panels/sources.tsx` — show "X credits" badge on each compile
- `apps/admin/src/locales/da.json`, `en.json` — credits i18n strings
- `docs/SAAS-SCALING-PLAN.md` — update tier-table med monthly credit-baselines
- `docs/PRICING-PLAN.md` — replace "LLM absorbed in margin" with credits-model
- `docs/DEPLOYMENT-STAGES.md` — fix cost/revenue calculations (LLM becomes user-paid above baseline)
- `docs/FEATURES.md` + `docs/ROADMAP.md`

### Downstream dependents

- `apps/server/src/services/ingest.ts` is imported by 4 files — add of consumeCredits() call is additive, no breaking changes.
- `packages/shared/src/index.ts` — re-export credits.ts; no existing consumer broken.
- Stripe webhook endpoint is new; no existing webhook shares the path.

### Blast radius

- **Data integrity:** credit_transactions must be append-only. Any `UPDATE` or `DELETE` on that table = audit-trail breach. Trigger-level enforcement in migration.
- **Cash leak risk:** if consumeCredits() fails silently, we lose money. Wrap in try/finally; if DB write fails after LLM call succeeds, log critical + retry via F154 alert.
- **Stripe webhook idempotency:** duplicate webhook deliveries must not double-credit. Dedupe on `related_stripe_id`.
- **F153 R2-backup:** the 2 new tables add ~few KB per tenant — no meaningful impact on backup size/time.
- **Migration concurrency:** if running on live DB with pending ingests, migrate WHILE server is down (takes <100ms).

### Breaking changes

Ingen ikke-additive ændringer. Subscription-priser forbliver de samme. LLM-omkostning bliver synlig som credits — men indtil Phase 4 (M8) er der ingen blokering af ingests. Fair warning runway for eksisterende kunder: 3 måneder før enforcement.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `computeCreditsForJob(Flash, 100c)` returns 10 credits
- [ ] Unit: `computeCreditsForJob(Sonnet, 100c)` returns 100 credits (10× factor)
- [ ] Unit: `consumeCredits` goes into negative when balance insufficient
- [ ] Unit: double-consume same job-id is rejected (idempotency)
- [ ] Unit: Stripe webhook dedupe (same Checkout session → one transaction)
- [ ] Integration: end-to-end ingest → credit consumption → balance updated
- [ ] Integration: monthly top-up scheduler runs, adds baseline, creates transaction
- [ ] Integration: purchase pack → Stripe webhook → balance increased
- [ ] Manual: Admin UI shows balance pill with correct color tier
- [ ] Manual: Source page shows "X credits" badge after ingest
- [ ] Regression: existing ingest flow unaffected until Phase 4
- [ ] Regression: F151 Cost Dashboard still shows USD values correctly
- [ ] Regression: F149 fallback chain still works (credits deducted per final model used)

## Implementation Steps

1. **Migration 0018 + schema.ts update** — credits schema lander, verify via `apps/server/scripts/verify-migration.ts`
2. **Shared types** — `packages/shared/src/credits.ts` with constants + interfaces
3. **Core consume logic** — `packages/core/src/credits/consume.ts` with unit tests
4. **Ingest integration** — post-completion hook in ingest.ts + runner.ts
5. **Balance + history queries** — for the admin panel
6. **Admin UI Phase 1** — balance pill + Settings > Credits panel (read-only history)
7. **Stripe Checkout integration** — purchase flow with webhook handler
8. **Monthly top-up scheduler** — daily cron job
9. **Admin UI Phase 2** — purchase modal, pack-size selection
10. **Alert system** — email + in-app banner via F154 alerts
11. **Hard enforcement** — CreditsExhaustedError gate
12. **Operator panel (F154)** — fleet-wide credits view + adjustments

## Dependencies

- **F43** Stripe Billing — purchase-flow reuses the same Stripe account + webhook infrastructure
- **F44** Usage Metering — credit consumption is a specialisation of usage metering
- **F121** Per-tenant LLM Budget Tracking — F156 replaces this approach with user-facing credits (F121 deprecated or reframed as internal audit)
- **F149** Pluggable Ingest Backends — required for per-model credit factor
- **F151** Cost & Quality Dashboard — credits data shown alongside USD cost
- **F122** Plan Limits on tenants — plan row needs `monthly_credits` column
- **F154** Trail Control Plane — operator visibility + manual adjustments

## Open Questions

1. **Credit unit mapping — is $0.10 = 1 credit the right baseline?** Må kalibreres efter 1 måneds Phase-1-data. Må være så tæt på vores faktiske cost per "typical PDF ingest på Flash" at brugerne mentalt mapper 1 credit ≈ 1 ingest.
2. **Skal Claude CLI Max Plan virkelig være 0 credits, eller tildeles en nominel omkostning for intern tracking?** Recommend: 0 credits for Christian's egen tenant, men tracker det alligevel i `cost_cents_estimated` som shadow.
3. **Skal grandfather-Trail-tenants (pre-F156-kunder) få rabat i X måneder?** Recommend: ja, første 3 måneder får 2× monthly_included som afvejning for at switche mentalmodel.
4. **Refund-policy på ubrugte credits ved plan-cancel?** Recommend: nej — credits løber med tenant indtil de tømmes. Abonnements-cancel stopper månedlige top-ups, men bruger resterende credits indtil opbrugt.
5. **EU-VAT på credit-pakker?** Stripe Tax burde håndtere det. Verificer ved Phase 2.
6. **Trail på trail.broberg.ai (Christian's dev-tenant) bør konfigureres som "unlimited credits"** så development ikke koster os credits via vores egen beta-test. Recommend: `monthlyIncluded = 999999` for `t-christian`.

## Related Features

- **Depends on:** F43, F44, F122, F149, F151
- **Supersedes:** F121 (budget tracking) — F156 replaces the user-facing model; F121 becomes internal audit only
- **Enables:** F154 Control Plane operator dashboards, F123 Pro Add-ons (credit packs become add-ons in Stripe)
- **Cross-cuts:** F152 Runtime Model Switcher (model-valg = credit-cost signal), F153 R2 Backup (credit_transactions er append-only og skal backup'es)

## Effort Estimate

**Medium** — 6-9 dage fordelt over 4 phases.

- Phase 1 infra + schema + consume: 2-3 dage
- Phase 2 monthly top-up + Stripe: 1-2 dage
- Phase 3 alerts + soft enforce: 1-2 dage
- Phase 4 hard enforce + operator UI: 2 dage

Kritisk: landed FØR M8 (se Rollout). Efter M8 kræves phased enforcement; landet for sent = vi subsidiserer LLM-cost for alt for længe.
