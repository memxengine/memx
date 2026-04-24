# Deployment Stages — fra Sanne til 500 tenants

**Sidst opdateret:** 2026-04-24
**Målgruppe:** Christian + fremtidige cc-sessioner der skal forstå hvor vi er, og hvor vi er på vej hen — uden at læse hele `SAAS-SCALING-PLAN.md`.
**Relaterede dokumenter:** [SAAS-SCALING-PLAN.md](./SAAS-SCALING-PLAN.md) (arkitektur + pricing i detalje), [SCALING-ANALYSIS.md](./SCALING-ANALYSIS.md) (per-action latency), [PRICING-PLAN.md](./PRICING-PLAN.md).

---

## Hvorfor dette dokument

`SAAS-SCALING-PLAN.md` svarer på *hvordan* vi bygger en multi-tenant SaaS. Det dokument her svarer på **hvordan den ser ud fra uden på hvert stadie**, så vi kan have en konkret mental model af:

- Hvad koster infrastruktur pr. måned ved stadie 1, 2, 3?
- Hvad tjener vi pr. måned på hvert stadie?
- Hvornår trigger stadie 1 → 2 → 3?
- Hvem skal agere på hvilke signaler?

Målet er ikke at gentage beslutningerne i `SAAS-SCALING-PLAN.md` (libSQL embedded per-tenant, Fly.io, Tigris+R2, EUR-priser). Målet er at gøre dem **navigerbare**.

---

## Arkitektur-beslutninger der ikke ændrer sig på tværs af stadier

Før stadiumsvisningen: fire ting der er låst, så vi ikke diskuterer dem hver gang.

1. **libSQL embedded per-tenant — ikke central DB.**
   Hver tenant har sin egen `.db`-fil på Fly-volumet. Ingen netværks-hop. Sanne's data er fysisk adskilt fra acme's. Cloudflare D1, centralt Postgres, central Turso Cloud er **alle afvist** som primær query-path. Turso Cloud bruges kun til nightly offsite-backup (F153 bruger R2, men Turso Cloud er også en option).

2. **Fly.io er primær cloud.**
   AWS er afvist eksplicit (umulige konsoller, bekymrende vendor lock-in). Cloudflare Workers er afvist fordi long-running ingest og libSQL-writes ikke er et Worker-mønster. Kubernetes er afvist som default fordi vi vil ikke drive en control-plane selv — Fly Machines API leverer den samme primitiver uden ops-byrde.

3. **Storage er pluggable — Tigris default + R2 alternativ.**
   Per-tenant valg. Hobby/Starter får Tigris (tættest på Fly-compute). Pro+ kan vælge R2 (nul egress). Se `packages/storage/src/interface.ts`.

4. **Stockholm (`arn`) er default region.**
   EU-data-residency out-of-the-box. Global distribution er Business+ opt-in via F77.

Disse fire beslutninger gør stadie-evolutionen **ren horisontal skalering** — vi tilføjer Fly-Machines, vi migrerer ikke mellem databaser, cloud-providers eller arkitekturer.

---

## Stadie 1 — Single-tenant Fly app (1-2 tenants)

**Hvornår:** M1-M4. Sanne er customer #1, FysioDK Aalborg er kandidat #2. Måske 1-2 andre invites.
**Revenue-mål:** €0-150/mo (Sanne er gratis dogfood; #2 er betalt Pro).

```
┌─────────────────────────────────────────────────┐
│ Fly.io org: broberg-ai                          │
│                                                 │
│  App: trail-engine                              │
│  ├─ 1× performance-2x Machine (arn)             │
│  │    CPU: 2 vCPU · RAM: 4GB · €45/mo           │
│  │    ├── Bun + Hono server process             │
│  │    ├── /data/tenants/sanne.db                │
│  │    └── /data/tenants/fysiodk.db              │
│  │                                              │
│  └─ 1× Fly Volume (20GB) · €3/mo                │
│                                                 │
│  Storage: Tigris bucket (EU) · ~€2/mo           │
│  Auth: OAuth Google (F35, prod credentials)     │
│  Backup: nightly R2 push (F153) · €1/mo         │
└─────────────────────────────────────────────────┘

Total infrastructure: €51/mo
```

**Kendetegn:**
- Én Machine håndterer alle tenants
- Hver tenant har egen `.db`-fil på samme volume
- Ingen load-balancer, ingen multi-Machine routing
- Op til ~5 samtidige ingests uden stress (M1-Mac-ækvivalent)
- Deploy = én `fly deploy` fra main-branch

**Hvad KAN gå galt:**
- Machine restart under ingest → F143 persistent ingest queue samler op
- Volume fyldes op → Fly alerter, vi resize'r (no-downtime)
- Single-point-of-failure ved Machine-crash → cold-start ~30s, acceptable

**Trigger til Stadie 2:** Første betalte Pro-kunde kommer ind ELLER tenant-antal >5 ELLER Machine-CPU >70% gennemsnitligt over 24 timer.

---

## Stadie 2 — Shared Nodes + første dedicated (10-20 tenants)

**Hvornår:** M6-M10. Efter F40 multi-tenancy er live og F43 Stripe billing er aktiv.
**Revenue-mål:** €500-3000 MRR.

```
┌────────────────────────────────────────────────────────────┐
│ Fly.io org: broberg-ai                                     │
│                                                            │
│  App: trail-hobby-pool    (alle gratis tenants)            │
│  └─ 1× shared-cpu-1x 1GB (arn) · €4/mo                     │
│     └─ /data/tenants/{hobby-1..50}.db                      │
│                                                            │
│  App: trail-starter-pool  (€29/mo tenants)                 │
│  └─ 1× performance-2x 4GB (arn) · €45/mo                   │
│     └─ /data/tenants/{starter-1..15}.db                    │
│                                                            │
│  App: trail-pro-pool      (€149/mo tenants)                │
│  └─ 1× performance-4x 8GB (arn) · €90/mo                   │
│     └─ /data/tenants/{pro-1..5}.db                         │
│                                                            │
│  App: trail-business-fysiodk  (€499/mo, dedicated)         │
│  └─ 1× performance-8x 16GB (arn) · €180/mo                 │
│     └─ /data/tenants/fysiodk.db                            │
│                                                            │
│  App: trail-control-plane (admin panel for Christian)      │
│  └─ 1× shared-cpu-1x 512MB · €2/mo                         │
│                                                            │
│  Storage: Tigris (~20GB across tenants) · €0.40/mo         │
│  Backup: R2 nightly · €5/mo                                │
└────────────────────────────────────────────────────────────┘

Total infrastructure: €326/mo
Revenue (example): 50 Hobby + 15 Starter + 5 Pro + 1 Business
                 = €0 + €435 + €745 + €499 = €1679 MRR
Gross margin: (1679 − 326) / 1679 = 81%
```

**Kendetegn:**
- Én Fly-app pr. tier (routes på tier, ikke tenant)
- Subdomain-routing: `sanne.trailmem.com` → trail-starter-pool, `fysiodk.trailmem.com` → trail-business-fysiodk
- DNS er Cloudflare wildcard → Fly Anycast
- Pro→Business upgrade = manuel i Control Plane (copy DB, spin ny Business-app, DNS flip ~5 min)
- Auto-deploy på main-merge

**Hvad KAN gå galt:**
- Pro-pool får 6. kunde → over tier-density (5 max) → Control Plane alerter, vi spawner `trail-pro-pool-2`
- Starter-pool får noisy neighbor der spammer ingest → F21 backpressure beskytter, F32 lint scheduler yielder
- Hobby-pool rammer 200 tenants → spawn `trail-hobby-pool-2`

**Trigger til Stadie 3:** >100 tenants eller >3 dedicerede Business-Machines eller første Enterprise-kunde.

---

## Stadie 3 — Multi-Node fleet (200-500 tenants)

**Hvornår:** M12-M18. Efter F77 multi-region (Business+ opt-in) og første Enterprise-kontrakt.
**Revenue-mål:** €25-75K MRR.

```
┌────────────────────────────────────────────────────────────────┐
│ Fly.io org: broberg-ai                                         │
│                                                                │
│  Region: arn (Stockholm, default)                              │
│  ├─ trail-hobby-pool-{1..3}   · 3× shared-cpu-1x · €12/mo     │
│  │   (up to 600 Hobby tenants)                                 │
│  ├─ trail-starter-pool-{1..6} · 6× performance-2x · €270/mo    │
│  │   (up to 300 Starter tenants)                               │
│  ├─ trail-pro-pool-{1..4}     · 4× performance-4x · €360/mo    │
│  │   (up to 60 Pro tenants)                                    │
│  └─ trail-business-{1..30}    · 30× performance-8x · €5400/mo  │
│      (one app per Business tenant, dedicated Machine)          │
│                                                                │
│  Region: lhr (London, opt-in per tenant)                       │
│  └─ trail-business-acme-lhr   · 1× performance-8x · €180/mo    │
│                                                                │
│  Region: fra (Frankfurt, opt-in per tenant)                    │
│  └─ trail-enterprise-bigco    · 2× performance-16x · €720/mo   │
│                                                                │
│  App: trail-control-plane     · 1× performance-2x · €45/mo     │
│  └─ F154 admin UI + Fly API integration + alerting             │
│                                                                │
│  Storage: Tigris + R2 split (~2TB) · €40/mo                    │
│  Backup: R2 continuous + weekly offsite · €30/mo               │
│  DNS: Cloudflare wildcard + CDN · €20/mo                       │
└────────────────────────────────────────────────────────────────┘

Total infrastructure: ~€7100/mo
Revenue (example): 500 Hobby + 150 Starter + 40 Pro + 30 Business + 3 Enterprise
                 = €0 + €4350 + €5960 + €14970 + €15000 = €40,280 MRR
Gross margin: (40280 − 7100) / 40280 = 82%
```

**Kendetegn:**
- Fleet-topology: 45-50 Machines samlet
- F154 Control Plane er nu **operationelt nødvendig** — ikke luksus
- F155 auto-scaling kicker ind automatisk når pools rammer 80% kapacitet
- Regional spread på Business/Enterprise pr. kunde
- SOC 2 Type II compliance dokumentation (F73) for enterprise-proces
- Mandatorisk on-call rotation (1-2 personer) eller dedicated monitoring

**Hvad KAN gå galt:**
- Fly-region outage → F77 regional failover (Business+), Hobby/Starter accepterer downtime
- Database corruption på shared pool → F153 restore fra R2 snapshot (~5 min downtime for den ene tenant)
- En enkelt Enterprise-tenant bliver for stor for single-Machine → evaluering af Postgres-migration (F84) eller Turso Cloud embedded replicas
- DDoS → Cloudflare WAF foran Fly Anycast

**Trigger til hypotetisk Stadie 4:** >1000 tenants ELLER single-tenant >1M Neurons ELLER multi-region-latency krav <50ms globalt. Her begynder vi for første gang at overveje Kubernetes eller Postgres — men det er **ikke** på roadmap nu.

---

## Skaleringstriggere — hvornår går vi fra et stadie til det næste

Control Plane overvåger disse signaler og alerter:

| Signal | Stadie 1→2 | Stadie 2→3 |
|---|---|---|
| Antal tenants totalt | >5 | >100 |
| Antal betalte tenants | >1 | >25 |
| Machine CPU 24h-avg | >70% | >70% |
| Machine memory peak | >80% | >80% |
| Ingest-queue depth 95p | >10 jobs | >50 jobs |
| Queue-to-ingest-start latency | >30s | >60s |
| Business-tier kontrakter | >0 | >3 |
| Monthly revenue | >€150 | >€10K |

Ingen af disse er automatiske upgrades — de er **alerts** til F154 Control Plane. Curator (Christian eller fremtidig ops) tager beslutningen, ud fra trend, ikke enkelt-punkt.

---

## Cost & indtjening — stadie-for-stadie

Tabellen nedenfor antager **F156 Credits-Based LLM Metering** er aktiv. Hver plan inkluderer en månedlig grundkvote af credits (Hobby 5 / Starter 20 / Pro 100 / Business 500); ekstra credits købes som one-time-pakker. LLM-omkostninger over baseline-kvoten **dækkes af tenant** via credit-pakker, ikke af subscription-margin.

| Stadie | Tenants | Fly + storage + DNS | Subscription MRR | LLM cost (vores andel) | Credit-pack revenue | GM | Net |
|---|---|---|---|---|---|---|---|
| 1 | 1-2 | €51/mo | €0-150/mo | €5-20/mo | — | — | break-even ved tenant #2 |
| 2 | 10-20 | €326/mo | €1-3K MRR | €100-300/mo | €0-500/mo | 78-82% | €1.0-2.5K profit/mo |
| 3 | 200-500 | €7.1K/mo | €25-75K MRR | €1.5-4K/mo | €5-20K/mo | 75-80% | €22-83K profit/mo |

**Hvor LLM-omkostningen lander:**

- **Vores andel** = baseline-kvoten (5 / 20 / 100 / 500 credits/måned per plan). En credit ≈ $0.10 LLM-cost; det er vores "subsidiserede" del. Bagt ind i subscription-prisen.
- **Tenant's andel** = forbrug ud over baseline → credit-pakker købes via Stripe Checkout (10 / 20 / 50 / 100 / 200 credits per pakke, €0.30-0.50 per credit). Markup over vores cost = 1.25-5×.
- **Krydsmotivation:** model-valg afgør credit-cost (Flash 1× / GLM 2× / Sonnet 10×). F149's pluggable backends får dermed ægte kommerciel betydning — curators har incitament til at vælge den billigste model der løser opgaven.

Det er dét F151 Cost Dashboard tracker (intern view: USD-cost) og F156 Credits surfaces (kunde-vendt: credits-balance + pakke-køb). F149 Pluggable Backends eksisterer fordi: når Flash er godt nok til ingest, skrumper både vores cost og tenant's credit-burn 10×.

---

## Remote control — hvad Christian skal kunne klikke

Fra F154 Control Plane:

- **Fleet-dashboard:** alle Fly-apps, deres Machine-count, CPU/mem, tenant-count per Machine, daglig spend.
- **Provision new tenant:** form → vælg tier → policy placerer på den rette pool med ledig kapacitet → DB-init script kører → tenant modtager velkomst-mail.
- **Pro → Business upgrade:** one-click som starter: spawn ny `trail-business-<slug>` app, snapshot DB, restore på ny Machine, DNS cutover, slet fra pool. Rollback-knap indtil 24 timer efter.
- **Alert inbox:** alle signaler fra tabellen ovenfor samlet, med "confirm action" eller "dismiss" per alert.
- **Cost view:** drill-down fra "fleet spend denne måned" → per app → per tenant. Sammenlign med MRR.
- **Remote restart/deploy:** restart én Machine, deploy specifik git-SHA til én app, rollback til forrige.
- **Tenant-specific actions:** suspend (uden at slette), impersonate-read-only (support), export tenant-data (GDPR).

F155 (Auto-scaling Policy) automatiserer delmængden "pool-scaleup" og "performance-resize" så Christian ikke skal klikke hver gang en pool runder 80%.

---

## Hvad dette dokument IKKE er

- Ingen detaljeret tier-arkitektur (læs `SAAS-SCALING-PLAN.md`).
- Ingen per-feature-plan (hver F-feature har sin egen plan-doc).
- Ingen operations-runbook (F73 SOC 2 prep giver os det til Stadie 3).
- Ingen konkret tidsplan — datoerne ovenfor er vejledende, ikke committed.

---

## Cross-references

- **F33** Fly.io server deploy — forudsætning for Stadie 1.
- **F40** Multi-tenancy — forudsætning for Stadie 2.
- **F41** Tenant provisioning + signup — drev for Stadie 2 growth.
- **F42** Pluggable storage (Tigris + R2) — baseline for alle stadier.
- **F43** Stripe billing — nødvendigt for Stadie 2.
- **F44** Usage metering — signalkilde for Control Plane alerts.
- **F77** Multi-region — opt-in per tenant ved Stadie 3.
- **F153** Continuous R2 backup — infrastruktur-primitiv, brug alle stadier.
- **F154** Trail Control Plane — **operationelt nødvendig** ved Stadie 2, kritisk ved Stadie 3.
- **F155** [Auto-scaling Policy](./features/F155-auto-scaling-policy.md) — automatiserer delmængden af Control Plane-handlinger via yaml-policy med safety rails.
- **F156** [Credits-Based LLM Metering](./features/F156-credits-based-llm-metering.md) — gør LLM-cost user-paid via credits-pakker; afgørende for unit economics fra Stadie 2 og frem.
