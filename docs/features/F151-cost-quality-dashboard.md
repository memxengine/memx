# F151 — Cost & Quality Dashboard

> Admin-panel der gør F149's `ingest_jobs.cost_cents` + `model_trail`-data synligt for curator og ejer. To tabs: **Cost** (per-KB running total, per-source, per-Neuron estimat) og **Quality** (side-by-side-sammenligning af samme kildes ingest via forskellige modeller — turns, cost, neurons-skabt, wiki-links, entity-refs). Data-backend bygger på F149's kolonner; ingen nye migrations. Tier: alle tenants, aktiveres automatisk når F149 er deployet. Effort: Medium — 2–3 dage. Status: Planned.

## Problem

F149 samler cost-data pr. ingest-job (`cost_cents`) og model-trail (hvilke modeller kørte hvilke turns) — men uden UI er dataen usynlig. Curator kan ikke:

- Se hvad det koster at holde Sanne's Trail opdateret over en uge/måned
- Sammenligne tre modellers output af samme kilde før han beslutter hvilken default-model en KB skal køre
- Identificere dyre sources (stor bog → 10× normal cost) før de spiser månedsbudgettet
- Dele cost-oversigt med Sanne som tenant-ejer inden vi ramper op

Christian's direkte feedback under F149-review (2026-04-24):
> "Er det medtaget i F149 at lave UI for at vise denne Cost pr. KB, per source, per neuron, og et samlet trail/KB running cost?"
> "Quality comparison over tid: HVOR vil side-by-side-sammenligne ingests af den samme kilde kunne vises?"

F149 svarede nej på UI-delen; F151 er hjemmet.

Derudover er der et business-case-punkt: pricing-modellering til F43 Stripe-billing kræver *faktiske* cost-tal pr. KB, ikke estimater. "Hobby-tier = 1 KB" er meningsløs hvis én KB kan koste fra $1/måned (små text-kilder, billig model) til $50/måned (digere PDF-bøger, Sonnet via API). F151 leverer dataen pricing-tier-designet hviler på.

## Secondary Pain Points

- **Model-selection er gæt i dag.** Gemini 2.5 Flash er "bedst" ifølge model-lab-rapporten, men vi har ikke data på hvordan den opfører sig over tid på Sanne's faktiske indhold. Quality-tab gør det synligt — efter 10 ingests på den samme KB har curator et data-punkt pr. run at sammenligne på.
- **Månedsbudget-alerts kommer senere (F44 Usage Metering).** F151 leverer tal-visningen; F44 bygger thresholding + notifications ovenpå.
- **Cost-per-Neuron er en approksimation.** En source → 7 Neuroner, cost = $X → per-Neuron = $X/7. Det er ikke perfekt (Neuroner koster ikke lige meget at producere), men det er den bedste signal-kilde vi har indtil per-turn-cost mapes til per-tool-call — og det er out of scope for v1.
- **Quality-tab kan ende med at drive auto-model-valg.** Efter N ingests hvor model A producerer 30% flere korrekte wiki-links end model B på samme type kilde, kan F152 Runtime UI Switcher vise "vi anbefaler model A på denne KB ift. din historik". Out of scope for v1 men datastrukturen skal understøtte det.

## Solution

To tabs i én ny admin-panel:

1. **Cost tab** (`/kb/:kbId/cost`): line-chart af KB's running total cost over 30/90/365 dage + top-10 dyreste sources + per-Neuron avg. Eksportknap → CSV.

2. **Quality tab** (`/kb/:kbId/quality?source=:sourceId`): tabel-view der viser alle ingest-jobs mod en given kilde (typisk 1-4 rækker hvis curator har prøvet forskellige modeller). Kolonner: model, cost, turns, wall-clock, neurons-skabt, wiki-links-skabt, entity-refs. Klik en række → full-wiki-preview (embed af WikiReaderPanel i read-only).

Al data kommer fra `ingest_jobs` + `documents` + `wiki_backlinks` + `document_references` — ingen nye tabeller. Ingen LLM. Ingen migrations.

## Non-Goals

- **Budget-alerts / threshold-notifications.** Leveres af F44 Usage Metering; F151 er pure-read dashboard.
- **Stripe-invoice-generation.** Ligeledes F43/F44.
- **Auto-modelselection baseret på quality-tab-historik.** Data-grundlaget er her, men beslutnings-logikken er F152's domæne (hvis det nogensinde skal være automatisk).
- **Cross-tenant cost-aggregation** (e.g. "alle tenants → summeret månedlig cost"). Admin-scope er én tenant. Ownership-dashboardet der aggregerer på tværs er out of scope.
- **Forecasting af fremtidig cost.** "Baseret på dine sidste 7 dage forventes denne måned at koste $X" er nice-to-have men kræver trend-analyse vi ikke har.
- **Retroaktiv cost-attribution.** Pre-F149-jobs har `cost_cents=0`; de viser som "ukendt" eller "gratis (Max Plan)"-badge, aldrig som gæt.

## Technical Design

### Cost-tab datakilder

```typescript
// apps/server/src/routes/cost.ts (ny)
GET /api/v1/knowledge-bases/:kbId/cost?window=30d
→ {
    totalCents: number,
    byDay: Array<{ date: string; cents: number }>,
    bySource: Array<{ documentId: string; filename: string; cents: number; jobCount: number }>,
    avgPerNeuronCents: number,  // totalCents / sum(neurons_produced_per_job)
    maxBudgetWarning?: string,  // F44-hook, null hvis ikke konfigureret
  }
```

Alle tal beregnes via SQL aggregering over `ingest_jobs`:

```sql
SELECT
  date(started_at) AS day,
  COUNT(*) AS jobs,
  SUM(cost_cents) AS cents
FROM ingest_jobs
WHERE tenant_id = ? AND knowledge_base_id = ?
  AND completed_at IS NOT NULL
  AND started_at >= date('now', '-30 days')
GROUP BY date(started_at)
ORDER BY day;
```

Performance: `ingest_jobs` har index `(knowledge_base_id, status)` fra F143; tilføj index `(knowledge_base_id, started_at)` i migration **0015** for date-range queries.

### Quality-tab datakilder

```typescript
GET /api/v1/sources/:sourceId/ingests
→ {
    source: { id, filename, fileSize, pageCount },
    runs: Array<{
      jobId: string,
      startedAt: string, completedAt: string, durationMs: number,
      backend: 'claude-cli' | 'openrouter',
      primaryModel: string,           // første step i model_trail
      finalModel: string,              // sidste step (kan variere ved fallback)
      modelTrail: Array<{turn, model}>,
      costCents: number,
      turns: number,
      status: 'done' | 'failed',
      metrics: {
        neuronsCreated: number,
        wikiLinksCreated: number,
        entityRefsCreated: number,
        openBrokenLinks: number,   // F148
      },
    }>,
  }
```

`metrics` aggregeres fra:
- `neuronsCreated` = `COUNT(documents WHERE ingest_job_id = :jobId AND kind='wiki')`
- `wikiLinksCreated` = `COUNT(wiki_backlinks joined through documents.ingest_job_id)`
- `entityRefsCreated` = `COUNT(wiki_backlinks WHERE edge_type != 'cites' joined through ingest_job_id)` — typed edges er F137's gave hertil
- `openBrokenLinks` = `COUNT(broken_links WHERE from_document_id IN (SELECT id FROM documents WHERE ingest_job_id = :jobId) AND status='open')` — F148's gave

Preview-pane'et viser WikiReaderPanel i read-only-mode pegende på det specifikke `ingest_job_id`'s compiled neurons. Kræver en ny route `/kb/:kbId/neurons?ingestJobId=:jid` der filtrerer.

### Panel-komponenter

- `apps/admin/src/panels/cost.tsx` — cost-tab med chart (brug genbrugt `apps/admin/src/components/line-chart.tsx` hvis den findes fra F141; ellers en tynd Recharts-wrapper).
- `apps/admin/src/panels/quality-compare.tsx` — tabel + embed-reader.
- `apps/admin/src/lib/use-cost.ts`, `use-quality-runs.ts` — data-hooks.

Nav: tilføj "Cost"-item i sidebar mellem "Chat" og "Settings". Quality-tab'en er ikke top-level — tilgås fra Source-detail-view ("Sammenlign ingest-runs"-knap). Det holder top-nav slank og placerer funktionen hvor curator naturligt leder efter den.

### Claude Max Plan edge-case

`cost_cents=0 && backend='claude-cli'` rendres som badge "gratis (Max)" med tooltip: "Kørt via Christian's Claude Max Plan — ingen per-job billing fra Anthropic". Andre `cost_cents=0`-rækker (fx failed jobs) rendres som "—".

### CSV-eksport

"Eksportér"-knap → `GET /api/v1/knowledge-bases/:kbId/cost.csv` returnerer én række pr. ingest-job med kolonner: `jobId, date, source, backend, model, cost_cents, turns, neurons, duration_ms`. Curator kan åbne i Excel/Sheets for egen analyse.

## Interface

**HTTP (nye):**
- `GET /api/v1/knowledge-bases/:kbId/cost?window=7d|30d|90d|365d` → `CostSummary`
- `GET /api/v1/knowledge-bases/:kbId/cost.csv` → CSV-stream
- `GET /api/v1/sources/:sourceId/ingests` → `QualityComparison`
- `GET /api/v1/knowledge-bases/:kbId/neurons?ingestJobId=:jid` → filtered neuron list for preview-embed

**Shared types (nye):**
- `@trail/shared`: `CostSummary`, `QualityComparison`, `IngestRunMetrics`

**Admin routes (nye):**
- `/kb/:kbId/cost` → `CostPanel`
- `/kb/:kbId/sources/:sourceId/compare` → `QualityComparePanel`

## Rollout

**Enkelt-fase**. Ingen feature-flag. Dashboards aktiveres automatisk når F149 er deployet og `ingest_jobs.cost_cents` populeres. Pre-F149 data (alle eksisterende rækker, `cost_cents=0`) rendres som "gratis (Max)" hvis backend er `claude-cli`, ellers "—".

Migration 0015 (tilføj index på `ingest_jobs(knowledge_base_id, started_at)`) er let — sekunder på selv Christian's største KB.

Deploy-order:
1. F149 lander først (skaber dataen)
2. F151 lander bagefter (render'er dataen)

Panelet blocker ikke på at der er ≥1 cloud-backend-run — det virker også for Max-Plan-kørsler (tal er bare "gratis").

## Success Criteria

1. **Cost-tab load-time < 500ms** for KB med 30 dages data (≤ 1000 ingest-jobs). Målt via Chrome DevTools Performance.
2. **Quality-tab viser præcist N runs** for source der har kørt N ingest-jobs, med korrekte per-run-metrics (neurons/links/entity-refs matcher DB-count).
3. **CSV-eksport roundtrips uden tab**: antal rækker i CSV == antal jobs returneret af `GET /cost`.
4. **Per-Neuron avg-cost ≠ NaN selv når cost_cents=0**: curator skal kunne se "gratis (Max)" i stedet for division-by-zero-crash.
5. **Preview-embed viser korrekt wiki-output**: klik en quality-tab-row, embed-panel viser præcis de neurons der blev produceret af netop det `ingest_job_id`. Verificér ved at poste samme kilde to gange med forskellige modeller + asserterering at de to previews er forskellige.
6. **KB-skift genloader data uden cross-contamination**: navigér mellem to KBs; cost-tal mixer ikke.

## Impact Analysis

### Files created (new)

- `docs/features/F151-cost-quality-dashboard.md` — dette plan-dokument.
- `apps/server/src/routes/cost.ts` — GET cost + GET cost.csv.
- `apps/server/src/routes/ingests.ts` — GET `/sources/:sourceId/ingests`.
- `apps/server/src/services/cost-aggregator.ts` — SQL-aggregater + cache (60s TTL).
- `apps/admin/src/panels/cost.tsx` — Cost-tab.
- `apps/admin/src/panels/quality-compare.tsx` — Quality-tab.
- `apps/admin/src/lib/use-cost.ts`, `use-quality-runs.ts` — hooks.
- `apps/admin/src/components/cost-chart.tsx` — Recharts-wrapper (hvis ingen eksisterende).
- `apps/server/scripts/verify-cost-aggregator.ts` — probe der seeder 5 mock-jobs og bekræfter aggregater-SQL.
- `packages/db/drizzle/0015_ingest_jobs_date_index.sql` — migration (bare index, ingen kolonner).

### Files modified

- `apps/admin/src/main.tsx` — 2 nye routes (cost, quality-compare).
- `apps/admin/src/app.tsx` — "Cost"-nav-item tilføjet.
- `apps/admin/src/api.ts` — `getCostSummary`, `getQualityRuns`, `downloadCostCsv`.
- `apps/server/src/app.ts` — mount nye routes.
- `packages/shared/src/schemas.ts` — `CostSummarySchema`, `QualityComparisonSchema`.
- `packages/db/drizzle/meta/_journal.json` — 0015-entry.

### Downstream dependents

**`apps/server/src/app.ts`** — leaf mount-file, ingen importerer der kræver ændring.

**`apps/admin/src/api.ts`** — importeret af ~15 panels. Additive nye funktioner; ingen eksisterende signaturer ændret.

**`apps/admin/src/main.tsx` / `app.tsx`** — root-komponenter, ingen downstream.

**`packages/shared/src/schemas.ts`** — eksporteres bredt. Nye schemas er additive; ingen eksisterende Schema ændres.

**`packages/db/src/schema.ts`** — ingen ændring (0015 er kun index).

### Blast radius

- **Migration 0015 er additiv-only (`CREATE INDEX`)**. Idempotent via `IF NOT EXISTS`. Ingen eksisterende query brækker; nogle aggregat-queries bliver hurtigere.
- **Cost-summary-cache (60s TTL)**. Hvis en curator rate-limiter sig selv ved at åbne cost-tab'en 10 gange på 10s, pay-once-cache dækker. Cache-bust på `candidate_approved`-event (ingest-completion-signal) så tal'ne er friske lige efter en ingest.
- **Quality-tab's embed-preview**. Hvis curator har brugt read-only-reader-komponent i andre panels, er én komponent genbrugt. Hvis den bliver embedded i for mange sider, er det en kompatibilitets-matrix at holde styr på — noteret i open questions.
- **CSV-endpoint**. Ingen streaming-chunking; 1000-job-KB genererer ~50KB CSV — ingen problem. 10k-job-KB (langt i fremtiden) skal chunkes.
- **Per-Neuron-avg kan være 0 eller NaN hvis ingen jobs endnu.** UI skal håndtere: "Ingen ingests endnu — kør din første for at se cost-data."

### Breaking changes

**Ingen — alle ændringer er additive.**

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: cost-aggregator returnerer 0 for KB uden jobs (ingen NaN)
- [ ] Unit: `byDay`-array fyldes korrekt selv for dage uden jobs (nul-padding)
- [ ] Unit: quality-runs returnerer jobs sorteret efter `started_at DESC`
- [ ] Integration: seed 5 ingest_jobs over 3 dage, query `/cost?window=7d`, asserter sum og by-day-shape
- [ ] Integration: kør samme source 2× med forskellige modeller, query `/sources/:id/ingests`, asserter 2 rækker med korrekte metrics
- [ ] Integration: `/cost.csv` returnerer header + N rækker matchende `/cost`-output
- [ ] Integration: `/neurons?ingestJobId=X` filtrerer til netop det jobs neurons
- [ ] Manual Chrome DevTools MCP: åbn cost-tab, verificér chart renderer + load-tid < 500ms på development-tester KB
- [ ] Manual: flip KB i sidebar, verificér at cost-tal resetter korrekt
- [ ] Manual: CSV-eksport → åbn i Excel → verificér header + data
- [ ] Regression: F148 link-report-panel uændret
- [ ] Regression: F141 access-telemetry-rollup uændret (samme ingest_jobs-tabel)
- [ ] Regression: F143 ingest-queue uændret
- [ ] Migration proof: `pragma_index_list('ingest_jobs')` viser det nye index; `__drizzle_migrations` har 0015

## Implementation Steps

1. **Migration 0015 + cost-aggregator-service**: tilføj date-index, skriv `cost-aggregator.ts` med 60s TTL-cache + invalidation på `candidate_approved`. Probe: seed-script + SQL-verifikation.
2. **Route `/cost` + `/cost.csv`**: implementer GET-handlere, CSV-serialisering. Unit-tests.
3. **Route `/sources/:sourceId/ingests`**: query fan-out over documents/backlinks/broken_links. Unit-tests.
4. **Route `/neurons?ingestJobId=`**: filter-support på eksisterende neurons-endpoint.
5. **Admin api.ts + hooks**: klient-funktioner + useCost/useQualityRuns.
6. **CostPanel**: chart + top-sources-liste + CSV-knap. Copy-styling fra F141 access-rollup-panel hvis eksisterer.
7. **QualityComparePanel**: tabel + embed-reader. Route-tilgang fra Source-detail-view.
8. **Nav + route-registrering**.
9. **Chrome DevTools MCP smoke**: kør mod development-tester efter ingest af F149-plan-doc via 2 modeller. Verificér success-criteria.
10. **Commit + push**.

## Dependencies

- **F149 Pluggable Ingest Backends** — skaber `cost_cents` + `model_trail`-dataen F151 viser.
- **F143 Persistent Ingest Queue** — `ingest_jobs`-tabellen.
- **F148 Link Integrity** — `broken_links`-count i quality-metrics.
- **F137 Typed Edges** — entity-refs-count via `wiki_backlinks.edge_type`.
- **F141 Access Telemetry** — styling-reference for chart-komponent.
- **F87 SSE Event Stream** — cost-cache bust på `candidate_approved`.

## Open Questions

1. **Chart-bibliotek**: Recharts vs Chart.js vs noget tyndt med SVG direkte? Admin bruger allerede Preact + shadcn — jeg foreslår Recharts fordi det er godt dokumenteret og shadcn har charts-eksempler. Bekræft ved start.
2. **Aggregater i realtime vs nightly rollup?** F141 rollup-mønsteret er til N≈8k-Neurons-skala; F151 aggregater er små nok (1-100 jobs pr. KB pr. 30d) til at SQL-aggregere on-demand. Hvis en KB pludselig har 10k jobs på 30 dage (ingen realistisk scenarie i dag), genvej til rollup. v1: on-demand.
3. **Quality-tab side-by-side preview**: må vi rendere full-wiki fra to forskellige `ingest_job_id`-sæt SIDE-BY-SIDE (left/right split-pane) eller tab-switch? Split-pane er skarpt men komplekst ift. responsive. v1: tab-switch (klik "Se output"). Split-pane kunne komme som follow-up.
4. **Cost-per-Neuron estimate**: hvis en ingest producerer 7 neurons → cost = $X → per-Neuron = $X/7. Men en orphan-deletion kunne reducere neuron-count retroaktivt. Regn vi på nuværende neurons eller record-time-neurons? v1: nuværende neurons. Genberegning nightly rollup hvis tal drifter.

## Related Features

- **Depends on:** F149 (data), F143 (jobs-tabel), F148 (broken-links-metrics), F137 (edge-types).
- **Enables:** F44 (Usage Metering kan bygge threshold-alerts på dataen); F43 (Stripe-pricing-model kan backtestes mod historisk data); F152 (Runtime Model Switcher kan vise "anbefalet model" baseret på quality-tab-data).
- **Complements:** F54 (Curator Analytics) — F151 dækker cost + ingest-quality; F54 dækker queue-depth + approval-rate + gap-queries. To ortogonale dashboards.

## Effort Estimate

**Medium** — 2–3 dage.

- Dag 1: Migration 0015 + cost-aggregator-service + routes + probe.
- Dag 2: Admin cost-tab panel + chart + CSV.
- Dag 3: Quality-tab + embed-preview + Chrome DevTools smoke + polish.
