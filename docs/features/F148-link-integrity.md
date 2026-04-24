# F148 — Link Integrity (ingen 404-fejl i hjernen)

> Tre lag der samlet garanterer at intet klik på et `[[wiki-link]]` eller et `/kb/<slug>/neurons/<slug>` lander på en 404. Prompt-regler der lærer LLM'en Trail's slug-konvention, URL-resolution-fallback med dansk↔engelsk-fold, og et link-checker-scheduler-job med en `broken_links`-tabel der auto-fixer entydige mismatches og rapporterer resten til curator. Tier: alle brains, alle connectors. Effort: Medium — 2-3 dage. Status: Planned.

## Problem

En Trail brain er ubrugelig hvis internt-link-klik 404'er. Den 2026-04-24 auditerede vi Demo Brain "zoneterapi" (26 Neuroner, 122 wiki-links) og fandt systematiske mismatches:

- LLM'en kompilerer en kilde på dansk, men navngiver Neuron-filer på **engelsk**: `yin-and-yang.md`, `five-elements-tcm.md`, `traditional-chinese-medicine.md`.
- Andre Neuroner citerer dem med **dansk** link-tekst: `[[Yin og Yang]]`, `[[De Fem Elementer]]`.
- Admin reader i `apps/admin/src/panels/wiki-reader.tsx:121` resolver URL'en ved at slå `slugify(slug)` op mod `slugify(filename-sans-.md)`. `slugify('Yin og Yang') = 'yin-og-yang'`, men filnavnet er `yin-and-yang.md` → slug `yin-and-yang` → **ingen match → 404**.
- Samme problem i backlink-extractor (`resolveLink` i `apps/server/src/services/backlink-extractor.ts:131`) — backlinks til den målrettede Neuron registreres aldrig fordi strategy 2 (slugified link text vs filename stem) fejler.
- Entity-Neuroner mangler helt links fra kilde-summaries: Gemini Flash nævner `Sanne Andersen` i prosa-teksten men glemmer at wrappe navnet i `[[...]]`, så person→source-forbindelsen aldrig optræder i graph- eller backlink-visningen.

Model-lab-eksperimentet (`apps/model-lab/data/REPORT.md` + `~/Downloads/MODEL-LAB-NEURON-LINK-QUALITY-RAPPORT.md`) fandt at ingen af de tre testede cloud-modeller (Gemini Flash, GLM, Qwen) producerer konsistente slugs af sig selv — det er en strukturel egenskab ved LLM'er: de har ingen indbygget forståelse for Trail's slug-konvention. Christians dekret: **der må være 0,0000000 404-fejl i en hjerne**. Tre lag i forsvar, fordi ét lag alene hver især er utilstrækkeligt.

## Secondary Pain Points

- Graph-view (F99) tegner ikke kanter hvis `wiki_backlinks`-rækken aldrig blev skrevet — så brain'en ser ud til at være sammensat af isolerede klynger selvom det er en strøm af citations der ikke kunne resolve.
- Entity-tælling i Queue / Connector-attribution (F95) viser underestimat af hvor mange Neuroner der faktisk refererer en given person når personnavne ikke er linket.
- Orphan-lint (F98) markerer dokumenter som "orphan" fordi ingen kommer ind til dem via backlinks — men det kan være pga. link-mismatch, ikke reelt orphan.
- Curator spilder tid på at manuelt rette link-tekst-casing i Neuroner (`[[De Fem Elementer (TCM)]]` vs `[[De Fem Elementer]]`) når toleransen burde leve i resolveren.

## Solution

Tre additive lag i forsvar:

1. **Prompt-lag** — udvid `apps/server/src/services/ingest.ts`-prompten med `kb.language`-injektion, en liste over eksisterende entity-Neuroner (ny `listKbEntities()` aggregator parallel med `listKbTags()`), og eksplicitte konsistens-regler ("filnavn, `title`-frontmatter og `[[link-tekst]]` SKAL slugify til samme streng", "dansk KB → brug `og` ikke `and`", "alle personnavne i kilden SKAL være `[[wiki-links]]`").

2. **URL-fallback-lag** — ny `normalizedSlug(slug, language)` i `packages/shared/src/slug.ts` der folder bilingual-drift (`og ↔ and`, `i ↔ of`, `med ↔ with`, `til ↔ to`) og fjerner parentes-kvalifikatorer. Anvendt symmetrisk i `wiki-reader.tsx` (URL→doc), `backlink-extractor.ts resolveLink()` (citationer→backlinks), og `wiki-links.ts targetToSlug()` (rendering). Kun ved entydig match; flertydighed falder videre til næste strategi.

3. **Link-checker-lag** — nyt `apps/server/src/services/link-checker.ts`-service + `broken_links`-tabel (migration `0013`). Spejler `contradiction-lint.ts`-mønsteret: subscriber på `candidate_approved` til per-doc re-check, daglig sweep via `lint-scheduler`. Auto-fix når den normaliserede fold peger entydigt på én Neuron. Flertydige eller uløselige mismatches lander som `queue_candidates` med `kind='broken-link-alert'` så curator ser dem i den eksisterende kø.

## Non-Goals

- **Rewriting eksisterende Neuron-filnavne in-place som del af denne feature.** En curator-drevet batch-rename af legacy engelske filnavne kan følge senere; F148 løser problemet ved resolve-tid og ved fremadrettet ingest.
- **Cross-KB link-resolution.** Links forbliver scopet til deres egen KB. `[[kb:other/…]]`-syntaksen er F23's ansvar.
- **Sproggenkendelse fra kildeindhold.** `knowledge_bases.language` er den autoritative kilde. Fejl-tagget KB → LLM følger fejl-taggen; curator retter ved at ændre KB-sproget, ikke ved at vi detekterer det.
- **Fuzzy/ML-matching hinsides deterministiske ord-folds.** Levenshtein ≤ 2 bruges kun som *forslag* til curator (ikke auto-write). Ingen LLM i checkeren.
- **Fikse link-tekst i andre Neuroner når et filnavn renames.** Rename-flows håndteres separat; F148 gør dem sikrere ved at fold'en allerede klarer mange dagligdags mismatches.
- **Slug-normalization for ekstern content (web-clipper titles, RSS feeds).** Kun for Neuroner inden for en KB.

## Technical Design

### Lag 1 — Prompt-opgradering

File: `apps/server/src/services/ingest.ts` (`runJob`, template literal ved linje 307-366).

**Nye injections i prompten:**

```typescript
// Ny aggregator — mirror af listKbTags
export async function listKbEntities(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
): Promise<Array<{ title: string; filename: string }>>
```

Forespørgsel: `kind='wiki' AND archived=false AND path LIKE '/neurons/entities/%'`, capped til top-200, sorteret efter titel. Samme 60s TTL-cache-mønster som `listKbTags` (se `apps/server/src/services/tag-aggregate.ts:47-94`). Kaldes én gang per ingest-job.

**Promptindsættelse (efter `tagBlock`, før `schemaBlock`):**

```
EXISTING ENTITY NEURONS IN THIS KB (prefer linking to these over creating duplicates — exact title required):
  - Sanne Andersen (/neurons/entities/sanne-andersen.md)
  - Grethe Schmidt (/neurons/entities/grethe-schmidt.md)
  ...
Every named person, organisation, or tool mentioned in the source MUST appear as a [[wiki-link]]. Check this list first; only create a fresh entity page if none matches.
```

**Language-consistency-regel indsat i IMPORTANT RULES:**

```
- THIS KB'S LANGUAGE IS ${kb.language === 'da' ? 'DANISH' : kb.language === 'en' ? 'ENGLISH' : kb.language.toUpperCase()}.
  All filenames, titles, and link text MUST be in this language. When kb.language=='da', use Danish connectives:
  "og" not "and", "i" not "of", "til" not "to", "med" not "with". Use Danish specialist terms not English ones.
- FILENAME / TITLE / LINK-TEXT CONSISTENCY: before you write a page, decide what [[link-text]] other Neurons will use to cite it. That link-text's slugified form IS the filename (e.g. link-text "Yin og Yang" → filename "yin-og-yang.md" → title "Yin og Yang"). These three must slugify to the same string. A drift here causes 404s.
- ENTITY LINKING: every named person, organisation, or tool in the source MUST be wrapped in [[...]]. Resolve against the ENTITY VOCABULARY block above before creating a new entity page.
```

### Lag 2 — URL-fallback

File: `packages/shared/src/slug.ts` + ny `packages/shared/src/slug-fold.ts`.

**Ny helper:**

```typescript
// packages/shared/src/slug-fold.ts
const BILINGUAL_FOLDS: Record<string, Array<[string, string]>> = {
  da: [
    // Bilingual pairs — bidirectional (both sides mapped to a canonical form).
    ['og', 'and'], ['i', 'of'], ['til', 'to'], ['med', 'with'],
    // Danish diacritics common ASCII variants
    ['ae', 'æ'], ['oe', 'ø'], ['aa', 'å'],
  ],
  en: [/* mirror */],
};

export function foldBilingual(slug: string, language: string): string {
  // Word-level replace on '-' boundaries. Canonical direction: prefer the
  // KB-language form. A slug "yin-and-yang" on a Danish KB folds to
  // "yin-og-yang"; a slug "yin-og-yang" on an English KB folds to "yin-and-yang".
  const pairs = BILINGUAL_FOLDS[language] ?? [];
  let out = slug;
  for (const [native, foreign] of pairs) {
    const re = new RegExp(`(^|-)${foreign}(-|$)`, 'g');
    out = out.replace(re, `$1${native}$2`);
  }
  return out;
}

// packages/shared/src/slug.ts
export function normalizedSlug(slug: string, language: string): string {
  const stripped = stripParens(slug); // "de-fem-elementer-tcm" → "de-fem-elementer" when "-tcm" is a suffix qualifier
  return foldBilingual(stripped, language);
}
```

**Anvendt symmetrisk tre steder:**

1. `apps/admin/src/panels/wiki-reader.tsx:113` — URL matcher prøver først canonical, derefter `normalizedSlug()` på både incoming slug OG filename-sans-.md. Kun præcis én Neuron i pool'en skal matche via fold'en; flertydighed falder videre til filename-exact-match-strategien.

2. `apps/server/src/services/backlink-extractor.ts:131` — `resolveLink()` får en fjerde strategi: `foldBilingual(slugify(target), kb.language)` matchet mod `foldBilingual(stripExt(n.filename).toLowerCase(), kb.language)`. Samme entydighedsbetingelse.

3. `apps/admin/src/lib/wiki-links.ts:26` — `rewriteWikiLinks()` rendering: `[[Yin og Yang]]` → `/kb/x/neurons/yin-og-yang`. Link-href bliver ved med at være den kanoniske slug, ikke den normaliserede — fold'en lever kun i resolverne, så den kanoniske href stadig virker når targetet senere renames.

Resolveren tager KB-language som parameter så en engelsk KB ikke per ulykke folder `and → og`.

### Lag 3 — Link-checker-service

Ny fil: `apps/server/src/services/link-checker.ts` (mirror af `contradiction-lint.ts:88-265`).

```typescript
export function startLinkChecker(trail: TrailDatabase): () => void {
  // Subscribe candidate_approved — per-doc rescan på write/update.
  const unsub = broadcaster.subscribe(async (evt) => {
    if (evt.type !== 'candidate_approved') return;
    if (evt.kind !== 'ingest-summary') return; // kun wiki-doc-udskrivninger
    await rescanDocLinks(trail, evt.documentId);
  });
  return unsub;
}

export async function runFullLinkCheck(
  trail: TrailDatabase,
  kb: { id: string; tenantId: string; language: string },
): Promise<LinkCheckReport> {
  // Hent pool af wiki-docs én gang (samme pattern som backlink-extractor).
  // For hver doc: parseWikiLinks → for hvert link:
  //   1. resolveLink(pool, ...) med fold
  //   2. hvis null → forsøg auto-fix via entydig fold-match
  //   3. ellers → insert i broken_links, emit queue_candidates-row
}
```

**Registrering ved boot:** `apps/server/src/index.ts` lige efter `startLintScheduler`:

```typescript
const stopLinkChecker = startLinkChecker(trail);
// lint-scheduler kalder runFullLinkCheck(trail, kb) per KB i sin daglige sweep
```

**Ingen LLM** — ren text-parsing, in-memory pool, normalizedSlug-fold, Levenshtein ≤ 2 for forslag. Cache på 60s TTL som backlink-extractor.

### Database — `broken_links`-tabel

File: `packages/db/drizzle/0013_broken_links.sql` (ny migration, sekventielt efter `0012_ingest_job_id.sql`).

```sql
CREATE TABLE broken_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  knowledge_base_id TEXT NOT NULL,
  from_document_id TEXT NOT NULL,
  link_text TEXT NOT NULL,
  suggested_fix TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'auto_fixed' | 'dismissed'
  reported_at TEXT NOT NULL DEFAULT (datetime('now')),
  fixed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  FOREIGN KEY (from_document_id) REFERENCES documents(id) ON DELETE CASCADE,
  UNIQUE (from_document_id, link_text)
);

CREATE INDEX idx_broken_links_kb_status ON broken_links(knowledge_base_id, status);
```

`UNIQUE (from_document_id, link_text)` sikrer idempotent insert når daglig sweep gen-checker en allerede-åben finding. `status='auto_fixed'` markeres i samme transaktion som link-rewriten i document.content.

### Admin UI — link-report panel

Ny fil: `apps/admin/src/panels/link-report.tsx`. Liste-view med kolonnerne: source-doc, broken link-text, suggested_fix, status. "Accept fix" / "Dismiss"-knapper kalder ny route:

- `GET /api/v1/link-check/:kbId` — liste af åbne broken_links
- `POST /api/v1/link-check/:id/accept` — anvender suggested_fix på dokumentet
- `POST /api/v1/link-check/:id/dismiss` — marker som `dismissed`

Genbruges via det eksisterende `queue_candidates`-UI: checkere emitter candidates med `kind='broken-link-alert'` så curator ser dem i Queue-tab'en uden at skulle åbne en separat side. Link-report-panelet er en specialiseret view hvis curator vil se dem samlet per KB.

## Interface

**Database:**
- Ny tabel `broken_links`.
- Ingen ændringer på `documents`, `wiki_backlinks`, `knowledge_bases`.

**HTTP endpoints (nye):**
```
GET  /api/v1/link-check/:kbId            → { findings: BrokenLink[] }
POST /api/v1/link-check/:id/accept       → { fixed: true, newContent: string }
POST /api/v1/link-check/:id/dismiss      → { dismissed: true }
```

**Events (nye):**
- Tilføj `broken-link-alert` som `queue_candidates.kind`-værdi. Eksisterende `CandidateCreatedEvent` + `CandidateResolvedEvent`-shapes er uændret.

**Shared module exports (nye):**
```typescript
// packages/shared/src/slug.ts
export function normalizedSlug(slug: string, language: string): string;

// packages/shared/src/slug-fold.ts
export function foldBilingual(slug: string, language: string): string;
```

`slugify()` selv er uændret — fold'en er en separat lag ovenpå, så eksisterende kaldere der bruger slugify direkte (fx filnavnsgenerering ved `create`) stadig producerer deterministiske slugs.

## Rollout

**Enkelt-fase deploy.** Intet feature-flag — tre lag er additive:

1. Migration `0013` kører ved server-boot via eksisterende Drizzle-migrations-runner. Tabellen er tom ved første boot; link-checkeren fylder den.
2. Prompt-ændringer påvirker kun nye ingest-runs. Eksisterende Neuroner er upåvirkede.
3. URL-fallback starter med at resolve 404-genererende links med det samme — ingen content-migration nødvendig. Christians Demo Brain (som allerede er hand-fixet) påvirkes ikke negativt: fold'en tilføjer kun en fallback-strategi, canonical match vinder stadig.
4. Link-checker's første fulde sweep kører i `lint-scheduler`-initial-delay-vindue (default 4 timer efter boot). Den første nat produceres en bund af åbne findings; curator bruger en eftermiddag på at acceptere suggested_fixes.

Efter deploy kører F148-verifikations-script mod `http://127.0.0.1:58031/kb/development-tester/neurons` og bekræfter 0 åbne findings.

## Success Criteria

1. **Zero 404s on `/kb/<kbId>/neurons/<slug>`** for enhver ingest-produceret Neuron i en dansk-tagget KB, efter en enkelt fuld ingest-run + link-checker-pass. Målt ved: `verify-link-integrity.ts` kører 122 klik-simulationer mod Demo Brain og får HTTP 200 på alle.
2. **≥95% af LLM-producerede slugs matcher link-tekst uden fold efter prompt-opgradering.** Målt ved: kompil en fresh kilde (Sanne's NADA-PDF bruges som reference), tæl Neuroner hvor `slugify(title) === stripExt(filename)` og `slugify(title) === slugify(first-backlink-from-other-Neuron)`. Pre-F148-baseline: ~60% (model-lab data).
3. **100% af navngivne personer/organisationer i kilden bliver wiki-links.** Målt ved: efter ingest, sammenlign `parseWikiLinks(source-summary.content).filter(target ∈ entityNames)` med manuel liste af entities i kilden. Pre-F148-baseline: ~40%.
4. **Link-checker auto-fixer ≥80% af broken links uden curator-indblanding.** Målt ved: af `broken_links`-rækker oprettet i første uge, `status='auto_fixed'`-andel.
5. **Full-KB link-sweep < 2s for 300-Neuron KB.** Målt ved: `runFullLinkCheck` wall-clock på en seeded KB i integration-test.

## Impact Analysis

### Files created (new)

- `docs/features/F148-link-integrity.md` — dette plan-dokument.
- `apps/server/src/services/entity-aggregate.ts` — `listKbEntities()` aggregator.
- `apps/server/src/services/link-checker.ts` — service + scheduler-hook.
- `apps/server/scripts/verify-link-integrity.ts` — end-to-end probe.
- `apps/admin/src/panels/link-report.tsx` — broken-links view.
- `packages/db/drizzle/0013_broken_links.sql` — migration.
- `packages/shared/src/slug-fold.ts` — `foldBilingual()` + bilingual-pair-table.

### Files modified

- `apps/server/src/services/ingest.ts` — inject `kb.language` + `listKbEntities()` + entity-vokabular-block + language-consistency-regler i prompten.
- `apps/server/src/services/backlink-extractor.ts` — `resolveLink()` får fold som 4. strategi. Signatur tager `language: string`.
- `apps/server/src/index.ts` — `startLinkChecker(trail)`-registrering ved boot.
- `apps/server/src/routes/lint.ts` — tilføj `GET /link-check/:kbId`, `POST /link-check/:id/accept`, `POST /link-check/:id/dismiss`.
- `apps/admin/src/panels/wiki-reader.tsx` — URL matcher bruger `normalizedSlug()` som fallback.
- `apps/admin/src/lib/wiki-links.ts` — `targetToSlug()` dokumenterer at fold IKKE ændrer href; rendering forbliver canonical.
- `packages/db/src/schema.ts` — `brokenLinks` table-definition.
- `packages/shared/src/slug.ts` — tilføj `normalizedSlug()` (wrap af slugify + fold).
- `packages/shared/src/events.ts` — tilføj `'broken-link-alert'` til candidate-kind-enumeration.

### Downstream dependents

**`apps/server/src/services/ingest.ts`** er kun selv-kaldet (fra `triggerIngest`). Ingen external imports påvirket.

**`apps/server/src/services/backlink-extractor.ts`** importeres af:
- `apps/server/src/bootstrap/zombie-ingest.ts` (1 ref) — kalder `backfillBacklinks()`, unaffected (signatur uændret på den funktion).
- `apps/server/src/services/ingest.ts` (0 direkte refs men kører via candidate-approved-event) — unaffected.
- `apps/server/src/index.ts` (1 ref) — `startBacklinkExtractor`-call, unaffected.
- `apps/server/scripts/backfill-*.ts` (et par scripts) — unaffected.
Kun `resolveLink` får en ny parameter, og den er en intern (lowercase) hjælpefunktion — ikke eksporteret. `extractBacklinksForDoc` signatur ændres ikke.

**`apps/admin/src/panels/wiki-reader.tsx`** er root-page-komponent — ingen downstream dependents.

**`apps/admin/src/lib/wiki-links.ts`** importeres af:
- `apps/admin/src/panels/wiki-reader.tsx` (1 ref) — unaffected (signatur uændret).
- `apps/admin/src/panels/chat.tsx` (1 ref) — unaffected.
- `apps/admin/src/panels/graph.tsx` (1 ref, hvis den bruger den) — unaffected.

**`packages/shared/src/slug.ts`** importeres af >20 filer (kanonisk slugify). **Nye eksporter (`normalizedSlug`) er additive — eksisterende `slugify()` er uændret.** Ingen caller kræver ændring.

**`packages/db/src/schema.ts`** importeres af alle engine-services. Tilføjelse af ny tabel er additiv; ingen eksisterende kolonne ændres.

**`apps/server/src/routes/lint.ts`** er leaf-route (mountes i `app.ts`, ingen imports andetsteds).

Ingen modified file har uhåndterede downstream consumers.

### Blast radius

- **URL-resolution-adfærd ændres.** Før: `/neurons/yin-og-yang` → 404 når filnavnet er `yin-and-yang.md`. Efter: resolver korrekt via fold. **Ingen eksisterende kaldsmønstre brydes** — fold kører kun når canonical match fejler.
- **Backlink-extractor påvirker `wiki_backlinks`-tabellen.** Ved første kørsel efter deploy finder extractoren flere matches end før (pga. fold). `insertBacklink()` er idempotent via unique-index, så gentagne kørsler er sikre.
- **`queue_candidates.kind`-enumeration udvides.** Eksisterende kind-baserede filter-visninger i admin skal tillade den nye `'broken-link-alert'`-værdi. Verificér at frontend-komponentets kind-switch har fallback.
- **Migrations-runner.** Drizzle-migration 0013 er idempotent (`CREATE TABLE IF NOT EXISTS`). Ved genstart uden ny deploy er den no-op.
- **Concurrent ingest + link-check.** Link-checkeren re-sker kun docs der lige blev `candidate_approved`. Ingen lock nødvendig — `broken_links.UNIQUE(from_document_id, link_text)` forhindrer dublerede inserts.
- **Edge-case: stor KB + første sweep.** Første `runFullLinkCheck` på en 500-Neuron-KB (~2000 links) kører i ~1s via in-memory pool. Sweep'en kører serielt per KB (som contradiction-lint), så I/O-båndbredde er bounded.

### Breaking changes

**Ingen — alle ændringer er additive.**

- `slugify()` signatur uændret.
- `resolveLink()` signatur får en ny `language`-parameter — men funktionen er intern (lowercase, ikke eksporteret), så ingen external call-site påvirkes.
- `queue_candidates.kind`-kolonnen er TEXT og har ingen CHECK-constraint, så ny værdi kræver ikke migration.
- Eksisterende Neuroner og URL'er forbliver klikbare.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `foldBilingual('yin-and-yang', 'da') === 'yin-og-yang'`
- [ ] Unit: `foldBilingual('yin-og-yang', 'en') === 'yin-and-yang'`
- [ ] Unit: `foldBilingual('yin-and-yang', 'en') === 'yin-and-yang'` (no-op hvis slug allerede er KB-sprog)
- [ ] Unit: `normalizedSlug('de-fem-elementer-tcm', 'da') === 'de-fem-elementer'` (parens-stripping)
- [ ] Unit: `resolveLink` returnerer target når fold entydigt matcher
- [ ] Unit: `resolveLink` returnerer null når fold peger på to forskellige docs (flertydighed)
- [ ] Integration: indsæt wiki-doc med filnavn `yin-and-yang.md` + backlink `[[Yin og Yang]]` → URL matcher resolver via fold, `resolveLink` skriver backlink
- [ ] Integration: `runFullLinkCheck` på seedet KB genererer forventede `broken_links`-rækker og auto-fixer de entydige
- [ ] Integration: `candidate_approved`-event på en doc-update re-kører link-check på kun den doc
- [ ] Manual: `apps/server/scripts/verify-link-integrity.ts` kører mod `http://127.0.0.1:58031/kb/development-tester/neurons` og rapporterer 0 broken
- [ ] Manual: Chrome DevTools MCP — navigér til Demo Brain, klik 20 tilfældige links i `zoneterapibogen-2026.md`, 0 × 404
- [ ] Manual: kompil ny kilde (Sanne's NADA-PDF) med opgraderet prompt, verificér at entity-mentions i kildesummary er `[[wrapped]]`
- [ ] Regression: eksisterende backlink-extractor-kald (via `extractBacklinksForDoc`) fungerer uændret på pre-F148-neuroner
- [ ] Regression: `/kb/<slug>/neurons/<slug>` virker på KB der har `language='en'` (engelske slugs)
- [ ] Regression: Lint-scheduler's daglige sweep tager ikke målbart længere end før F148
- [ ] Migration proof: `SELECT name FROM pragma_table_info('broken_links') WHERE name='status'` returnerer rækken OG `__drizzle_migrations` indeholder hash for 0013

## Implementation Steps

1. **Skriv plan-doc + index-opdatering + commit.** `docs/features/F148-link-integrity.md` + `docs/FEATURES.md` + `docs/ROADMAP.md` i samme commit. **Hard rule — ingen af de andre skridt starter før denne commit er landet.**
2. **Lag 2 først (sikrer nuværende indhold).** Implementér `packages/shared/src/slug-fold.ts` + `normalizedSlug` i `slug.ts`, tilslut i `backlink-extractor.ts:resolveLink()`, `wiki-reader.tsx` URL matcher, og `wiki-links.ts targetToSlug()`. Kør eksisterende backlink-backfill mod Demo Brain → ~30 nye backlinks forventes landet. Commit.
3. **Migration + broken_links-tabel.** Skriv `0013_broken_links.sql`, opdater `schema.ts`, bekræft via `pragma_table_info` at DDL lander. Commit.
4. **Link-checker-service.** Byg `link-checker.ts` (subscribe candidate_approved + `runFullLinkCheck`), tilføj til `index.ts` boot-sekvens, tilslut i `lint-scheduler`-daglig-sweep. Skriv routes i `lint.ts` + admin-panelet. Commit.
5. **Lag 1 — prompt-opgradering.** Byg `entity-aggregate.ts`, udvid `ingest.ts`-prompten med entity-block + language-regler. Kør ingest på `development-tester`-KB med Sanne's NADA-PDF som input — verificér at de 7 resulterende Neuroner har konsistente slugs og entity-links uden manuel intervention. Commit.
6. **Verifikations-script + smoke-test.** `verify-link-integrity.ts` + Chrome DevTools MCP-pass mod `http://127.0.0.1:58031/kb/development-tester/neurons`. Rapportér tal fra alle fem success-criteria. Commit + done.

## Dependencies

- **F06 Ingest Pipeline** — prompt-opgraderingen lever i denne pipeline.
- **F32 Lint Pass / F139 Lint Scheduler** — link-checker kører på samme scheduler-mønster.
- **F137 Typed Neuron Relationships** — `parseWikiLinks` er allerede edge-type-aware; link-checkeren arver gratis typed-edge-understøttelse.
- **F140 Hierarchical Context Inheritance** — ingest-prompten har allerede et schema-block; entity-block indsættes i samme struktur.
- **F102 Glossary Backfill** — etablerer mønsteret for "aggregér KB-vokabular og inject i prompt".
- **F145 Per-KB seqIDs** — broken-link-reports kan linke til Neuroner via `<kbPrefix>_00000042`-handles i queue_candidate-metadata.

## Open Questions

Ingen — alle designbeslutninger truffet. Den eneste semi-åbne kant er:

- **Parens-stripping-heuristik.** `de-fem-elementer-tcm` → `de-fem-elementer` er sikkert når `-tcm` aldrig optræder som legitim slug-halvdel. I dag har ingen KB en Neuron med filnavn der naturligt ender på `-tcm`, så heuristikken er sikker; hvis det en dag bliver et problem, er løsningen at tjekke om fold-kandidaten matcher en eksisterende Neuron før strippen anvendes. Noteret som fremtidig iteration, ikke et v1-blocker.

## Related Features

- **Depends on:** F06 (Ingest), F32 (Lint), F95 (Connectors — orphan-lint-connector-awareness), F102 (Glossary), F137 (Typed Edges), F140 (Schema Inheritance), F145 (seqIDs).
- **Enables:** F149 (Pluggable Ingest Backends) — når cloud-modeller ingestet kan backend skiftes uden at 404-problemet vender tilbage, fordi fold + link-checker står bagved uanset kompilér-model. Den løser symmetrisk det problem cloud-models opdagede.
- **Complements:** F99 (Graph) — backlinks der før gik tabt pga. mismatch vises nu som kanter.
- **Predates / blocks:** F150+ rename-flow (ikke specificeret endnu) — når en curator renamer et filnavn, skal link-checker automatisk markere alle `[[old-name]]`-refererencer som broken og auto-fixe dem. F148's infrastruktur leverer plumbingen.

## Effort Estimate

**Medium** — 2-3 dage.

- Dag 1: Plan-doc commit + Lag 2 (fold + resolveLink + URL matcher + wiki-links.ts). Kør backfill, verificér nye backlinks.
- Dag 2: Migration 0013 + link-checker-service + routes + boot-registrering + admin-panel.
- Dag 3: Lag 1 (entity-aggregate + prompt-opgradering) + verifikations-script + Chrome DevTools smoke + success-criteria-rapport.

Buffer en halv dag til fold-edge-cases (parens-stripping-heuristik, flertydighed-håndtering).
