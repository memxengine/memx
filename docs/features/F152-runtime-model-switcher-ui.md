# F152 — Runtime Model Switcher UI

> Admin-dropdown pr. KB der lader curator flippe `ingest_backend` + `ingest_model` live uden env-ændring eller redeploy. Kalder F149's `resolveIngestChain`-pure-function og viser preview af hvilken fallback-chain der ville blive brugt. Bygger på F151's quality-tab-data så anbefaling kan vises ("Du har fået bedst resultat med model X på denne KB"). Tier: alle tenants. Effort: Small — 1–1.5 dage. Status: Planned.

## Problem

F149 shippede pure-function `resolveIngestChain(kb, env)` + persistence-kolonner på `knowledge_bases` (`ingest_backend`, `ingest_model`, `ingest_fallback_chain`). Runner-laget læser dem ved hver ingest. Men der er ingen UI til at sætte værdierne. I dag skal curator enten:

- Redigere DB direkte via SQL
- Ændre env-vars + redeploy serveren
- Kalde `PATCH /knowledge-bases/:kbId/ingest-settings` via curl (hvis API lander før UI)

Ingen af det giver curator autonomi. Pointen med per-KB-model-valg er at Sanne's brain kan køre Gemini Flash mens dev-KB'en beholder Claude Sonnet (eller omvendt) — og det valg skal kunne flippes på et par sekunder når curator ser cost-dashboard og beslutter "Flash er god nok for os, flip det".

Christian's direkte feedback under F149-review:
> "Runtime-UI switch er out of v1 — plan-doc'en lægger pure-function-chain-resolution klar til UI-followup."

F152 er den UI-followup.

## Secondary Pain Points

- **Model-anbefaling baseret på historik.** F151 Quality-tab samler data om hvordan forskellige modeller performer på samme kilde. F152 kan vise "Baseret på dine 12 ingests på denne KB anbefales `google/gemini-2.5-flash`" som hint over dropdown'en.
- **Fallback-chain-preview.** Når curator hovrer "model Gemini 2.5 Flash" vises chainen der ville blive kørt: `Flash → GLM → Qwen → Claude API`. Curator har kontrol over hvad der sker ved fejl uden at skulle læse F149-docs.
- **Billing-key-advarsel.** Hvis curator vælger cloud-model men tenant ingen OpenRouter-key har, vises varsel rød: "Denne tenant har ingen OpenRouter-key. Indstil den først."

## Solution

Tilføj til eksisterende `apps/admin/src/panels/settings-trail.tsx` (KB-settings-panel):

1. Ny sektion "Ingest-model" med dropdown over `packages/shared/src/ingest-models.ts`-whitelist.
2. Preview-linje: "Fallback-chain: Flash → GLM → Qwen → Claude API" (generet via kald til client-side genbrug af `resolveIngestChain`).
3. Anbefalings-badge hvis F151 Quality-data har entydig vinder (≥3 runs, en model har ≥20% bedre kvalitets-score).
4. Advarsels-badge hvis valgt backend kræver API-key der ikke er sat.
5. "Gem"-knap → `PATCH /knowledge-bases/:kbId/ingest-settings`, invalidere kb-cache, toast.

Ingen nye tabeller, ingen migrations. Alt kode er UI + eksisterende F149-routes.

## Non-Goals

- **Mid-job-switch** (skift model mens en ingest kører). F149's fallback-chain håndterer fejl-drevne mid-job-switches; manuelt curator-initieret mid-job-switch er utility vi ikke har behov for nu.
- **Cross-KB bulk-switch.** "Set alle mine KBs til Gemini Flash" er nyttigt når man har mange KBs; ikke for v1.
- **A/B-test-orchestration.** "Kør næste 5 ingests via både Flash og GLM, sammenlign" er en dyb feature der kunne bygge på F151 Quality-tab. Out of scope her.
- **Per-source model-override.** "Denne store bog → Claude Sonnet; resten → Flash" kunne gøres men komplicerer model-valg. v1: KB-level.
- **Persisted audit-trail af hvem-ændrede-model-hvornår.** Nice for enterprise-tier senere; unødvendigt for solo/small-team.

## Technical Design

### Dropdown-komponent

Fil: `apps/admin/src/panels/settings-trail.tsx` (modifikation).

```tsx
<section>
  <h3>{t('kb.ingest.model.heading')}</h3>
  <select value={ingestModel} onChange={...}>
    {availableModels.map(m => (
      <option value={`${m.backend}:${m.id}`}>
        {m.label} ({m.costPer1kTokens}¢/1k tokens)
      </option>
    ))}
  </select>
  <p class="text-sm text-muted">
    Fallback: {chainPreview.map(step => step.model).join(' → ')}
  </p>
  {recommendation && <RecommendationBadge rec={recommendation} />}
  {keyWarning && <KeyWarningBanner message={keyWarning} />}
  <Button onClick={save} disabled={!dirty}>Gem</Button>
</section>
```

### Client-side chain-resolver

`apps/admin/src/lib/chain-preview.ts` er en tynd port af server-side `resolveIngestChain`'s default-chains (client kan ikke læse env, men den kan læse KB's persisted value + same hardcoded defaults). Holdes synkroniseret med server via `packages/shared/src/ingest-chains.ts` (flytes ud af server-side privat fil hvis nødvendigt).

### Recommendation-logic

Brugning af F151 `getQualityRuns(sourceId)` er per-source; vi har ikke en "per-KB bedste model"-endpoint. Tilføj en i F151 (`GET /knowledge-bases/:kbId/model-recommendation` → `{ recommendedModel, confidence, reasoning }`) eller beregn client-side ved at aggregere per-source-runs. v1: client-side aggregering over de seneste 20 runs i KB. Tærskel: kræv ≥3 runs + ≥20% kvalitets-delta før badge vises.

Kvalitets-score-formel: `(wiki_links_created + 2*entity_refs - 5*open_broken_links) / cost_cents`. Simpel, kan tuneres baseret på feedback.

### Key-warning

`GET /api/v1/tenant-secrets/status` → `{ claude: boolean, openrouter: boolean }` (ingen secrets returneret, kun boolean hvorvidt de eksisterer). Hvis valgt backend kræver manglende key → warning.

## Interface

**HTTP (genbrug fra F149 + 2 nye):**
- `GET /api/v1/knowledge-bases/:kbId/ingest-settings` (F149) → læs current
- `PATCH /api/v1/knowledge-bases/:kbId/ingest-settings` (F149) → gem
- `GET /api/v1/ingest-models` (F149) → whitelist
- **NY:** `GET /api/v1/tenant-secrets/status` → `{ claude: boolean, openrouter: boolean }`
- **NY:** `GET /api/v1/knowledge-bases/:kbId/model-recommendation` → `{ recommendedModel, confidence, reasoning, basedOnRuns }`

**Shared module (genbrug):**
- `packages/shared/src/ingest-chains.ts` — defaults (deles mellem admin + server)

## Rollout

**Enkelt-fase.** Ingen feature-flag. Aktiveres når F149 er deployet og `/ingest-settings`-routes er live. Recommendation-badge viser kun når data-grundlag er der (≥3 runs pr. KB).

Rækkefølge: F149 → F151 → F152. F152 kan landes uden F151 (så mangler recommendation-badge); F151 kan landes uden F152 (så mangler UI til at flippe baseret på data-indsigterne).

## Success Criteria

1. **Flip Sanne's KB fra Claude CLI til Gemini Flash og tilbage via UI tager < 10 sekunder**, inklusive save + toast + next ingest bruger den nye model.
2. **Fallback-chain-preview matcher faktisk kørsel.** Preview viser "Flash → GLM → Qwen"; næste ingest med mock-fail på Flash-step skal faktisk bruge GLM.
3. **Key-warning vises for tenant uden OpenRouter-key** når OpenRouter-backend vælges. Dismisser warning'en → save blocked indtil key sat.
4. **Recommendation-badge vises ikke før ≥3 runs** pr. KB. Efter 5 runs med entydig vinder skal badge fremgår med korrekt model-navn.
5. **Change ryggér via SSE eller page-reload** — hvis curator åbner kb-settings i to tabs og flipper i den ene, burde den anden opdatere. v1 accepter: page-reload krævet (SSE-integration som v2 hvis brugt).

## Impact Analysis

### Files created (new)

- `docs/features/F152-runtime-model-switcher-ui.md` — dette plan-dokument.
- `apps/admin/src/components/ingest-model-selector.tsx` — dropdown-komponent.
- `apps/admin/src/components/recommendation-badge.tsx` — badge.
- `apps/admin/src/lib/chain-preview.ts` — client-side chain-resolver.
- `packages/shared/src/ingest-chains.ts` — delte default-chains (flyttet fra server-private).
- `apps/server/src/routes/tenant-secrets-status.ts` — status-endpoint.
- `apps/server/src/routes/model-recommendation.ts` — recommendation-endpoint.

### Files modified

- `apps/admin/src/panels/settings-trail.tsx` — tilføj ingest-model-sektion.
- `apps/admin/src/api.ts` — 3 nye klient-funktioner.
- `apps/server/src/app.ts` — mount nye routes.
- `apps/server/src/services/ingest/chain.ts` (fra F149) — import fra shared-pakken frem for private constant.

### Downstream dependents

**`apps/admin/src/panels/settings-trail.tsx`** — root-panel-file, ingen downstream.

**`apps/admin/src/api.ts`** — ~15 importers, additive ændringer.

**`apps/server/src/app.ts`** — leaf mount.

**`apps/server/src/services/ingest/chain.ts`** — imported by `runner.ts` (1 ref). Ingen signatur-ændring; bare refactor af hvor chain-konstanter lever.

### Blast radius

- **Flyt af chain-konstanter til shared-pakke.** Server og admin deler én sandhed; tidligere kunne de drifte. Efter flytning skal både server- og admin-bundle rebuildes ved ændring — det er fint i monorepo.
- **Recommendation-endpoint rammer `ingest_jobs` + `documents` + `wiki_backlinks` for metrics-aggregation.** Cache 5 min så et KB-settings-view ikke hamrer DB'en.
- **Key-warning UX**: hvis warning er dismissed permanent, kan curator ved et uheld save og sende jobbet på en tom chain. Warning skal genereres ved hver mount, ikke persistet i localStorage.

### Breaking changes

**Ingen — alle ændringer er additive.** Flytning af chain-konstanter er refactor med samme behavior.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `chain-preview.ts` (client) returnerer samme chain som `resolveIngestChain` (server) for givne inputs
- [ ] Unit: kvalitets-score-formlen håndterer cost_cents=0 (Max Plan) uden division-by-zero
- [ ] Integration: flip KB-model via PATCH, kør ny ingest, verificér at `ingest_jobs.backend`+`model` matcher valget
- [ ] Integration: tenant uden OpenRouter-key får warning ved valg af OpenRouter-backend
- [ ] Integration: KB med 5 ingest-runs + entydig vinder → recommendation-endpoint returnerer den model
- [ ] Integration: KB med 0 runs → recommendation returnerer null (ingen badge)
- [ ] Manual Chrome DevTools MCP: flip model, observer toast, næste ingest bruger nye model, cost-dashboard viser ny row med den
- [ ] Manual: verificér chain-preview tekst matcher kørselsadfærd ved mock-fail
- [ ] Regression: F149 ingest-settings PATCH uændret adfærd (schema-valider inputs)
- [ ] Regression: F151 cost-dashboard renderer uændret efter F152-ændringer

## Implementation Steps

1. **Flyt chain-konstanter til `packages/shared/src/ingest-chains.ts`**, opdater F149 server-kode til at importere derfra.
2. **Client-side `chain-preview.ts`** (mirror af server pure-function).
3. **`GET /tenant-secrets/status`-endpoint** (boolean-only response, aldrig secrets).
4. **`GET /knowledge-bases/:kbId/model-recommendation`-endpoint** med 5min-cache.
5. **`IngestModelSelector`-komponent**: dropdown + preview-linje + warning-slots.
6. **`RecommendationBadge`-komponent**.
7. **Tilføj til `settings-trail.tsx`**.
8. **Manuel smoke**: flip model, kør ingest, verificér.

## Dependencies

- **F149 Pluggable Ingest Backends** — skaber kolonnerne + routes F152 skriver til.
- **F151 Cost & Quality Dashboard** — leverer data-grundlag for recommendation-badge (uden F151 er badge altid null).
- **F18 Curator UI Shell** — settings-panel-komponenten findes allerede.

## Open Questions

1. **Dropdown styling**: shadcn `<Select>` vs native `<select>`? shadcn er pænere men tungere import. Bekræft ved start.
2. **Auto-refetch recommendation efter save?** Hvis curator flipper model og ingester → recommendation kunne ændre sig. Svar: nej, cache-TTL på 5min er tilstrækkelig for v1. Curator genåbner settings-panel for at se nye tal.
3. **Skal "Flash → GLM → Qwen"-preview-tekst internationaliseres?** Alle model-IDs er engelske uanset KB-sprog. Labels kunne oversættes. v1: engelske model-IDs, dansk label-tekst omkring dem.

## Related Features

- **Depends on:** F149 (routes + data), F18 (settings-panel shell).
- **Data-consumer of:** F151 (quality-metrics for recommendation).
- **Complements:** F148 (accept/dismiss-UI for link-findings — samme mønster af "UI ovenpå F149-backbone").

## Effort Estimate

**Small** — 1–1.5 dage.

- Shared chains + client-preview + routes: 4 timer.
- Dropdown-komponent + panel-integration + recommendation-badge: 4–6 timer.
- Manuelt smoke-test + polish: 1–2 timer.
