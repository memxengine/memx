# Skalerings-analyse — queue actions + lint + compile

*Skrevet af trail-optimizer-sessionen, 2026-04-19, efter audit af committed + uncommitted kode på `main`.*

Formålet: kvantificere hvor længe hver handling i systemet tager ved 200 / 500 / 1.000 / 5.000 / 10.000 / 50.000 / 100.000 Neurons, og identificere hvor systemet arkitektonisk "rammer mur". Analysen er kildekode-baseret — ikke målt på en rigtig KB af den størrelse (Trail har pt. ~100 Neurons).

## Antagelser

Alle vurderinger forudsætter:

- **DB:** bun:sqlite libSQL, single-writer, lokal disk med WAL.
- **Gns. Neuron:** 2 KB content, ~10 `[[wiki-links]]`, ~5 `sources:` refs i frontmatter.
- **Sources:** skaleres separat fra Neurons; her antager vi S ≈ N/5 men det påvirker kun ref-extractor-grenen.
- **SQLite performance:** ~1 μs per row marshal til JS, ~500 μs pr. indexed write, ~5 μs point lookup på primary key.
- **LLM CLI (haiku):** ~1s cold-start + 1-2s generation pr. kald.
- **Trail-optimizer-fixes (som af 2026-04-19):** #1 stale-pushdown, #2 orphans batched LEFT JOIN, #7 reopen race, #8+9 canonical slugify. #15 (backlink N+1) er rapporteret men ikke landet. Tallene nedenfor markerer "før/efter" hvor relevant.

---

## 1. Per-action timing

Når en kurator klikker en action på en kandidat, udføres:

1. Route-layer auth + validering.
2. `resolveCandidate(...)` dispatcher på `action.effect`.
3. Effect-specifik transaktion.
4. Event-emission → live subscribers (reference-extractor, backlink-extractor, contradiction-lint hvis wired).

De forskellige effects har dramatisk forskellig kostprofil fordi kun `approve` emitterer `candidate_approved` — og dermed vækker de tunge subscribers.

### Konstant-tid actions

Rører ikke subscribers, ingen N-afhængighed:

| Action | Tid | DB-ops |
|---|---|---|
| `reject` | ~5 ms | 1 UPDATE candidate |
| `acknowledge` | ~5 ms | 1 UPDATE candidate |
| `flag-source` | ~10 ms | 1 SELECT source + UPDATE metadata + UPDATE candidate |
| `mark-still-relevant` | ~10 ms | 1 UPDATE doc + UPDATE candidate |
| `retire-neuron` | ~15 ms | tx(SELECT + UPDATE archived + wiki_event + finalise). Emitter IKKE `candidate_approved` → ingen subscribers |
| `reopen` (rejected → pending) | ~5 ms | 1 UPDATE candidate (m. status-guard efter fix #7) |

Disse forbliver under 20 ms ved alle skalaer, også ved N=100.000.

### Approve / auto-link-sources (triggerer subscriber-chain)

Subscribers der fyrer:

- `reference-extractor.extractReferencesForDoc` — parser frontmatter `sources: [...]` og INSERT-er til `document_references`.
- `backlink-extractor.extractBacklinksForDoc` — parser body `[[links]]` og INSERT-er til `wiki_backlinks`.
- `contradiction-lint.scanDocForContradictions` — hvis live; FTS pre-filter + LLM-kald per top-K peer.

| N Neurons | tx | ref-extractor | **backlink-extractor** | ∑ uden contradiction | + contradiction-LLM |
|---:|---:|---:|---:|---:|---:|
| 200 | 15 ms | 10 ms | 20 ms | **45 ms** | ≈ 10 s |
| 500 | 15 ms | 15 ms | 50 ms | **80 ms** | ≈ 10 s |
| 1.000 | 15 ms | 20 ms | 100 ms | **135 ms** | ≈ 10 s |
| 5.000 | 15 ms | 40 ms | 500 ms | **555 ms** | ≈ 10,6 s |
| 10.000 | 15 ms | 60 ms | **1,0 s** | **1,1 s** | ≈ 11,1 s |
| 50.000 | 15 ms | 200 ms | **5,0 s** | **5,2 s** | ≈ 15,2 s |
| 100.000 | 15 ms | 400 ms | **10,0 s** | **10,4 s** | ≈ 20,4 s |

For `auto-link-sources` lægges **+1-3 s LLM-kald** (source-inferer) ovenpå. FTS pre-filteret er O(log N), så selv ved N=100.000 holder inferer-delen sig i sub-sekund range.

### Kritiske flaskehalse

**1. `backlink-extractor.resolveLink` er O(L × N)** (`apps/server/src/services/backlink-extractor.ts:81-96`, finding #15 i optimizer-audit).

For **hvert** `[[link]]` i en Neuron-body loades hele KB'ens wiki-liste på ny via `SELECT * FROM documents WHERE kind='wiki'`. Ved L=10 links × N=100.000 = 1 million rows marshaled til JS per approval. Dette er den dominerende skaleringsomkostning.

Efter fix (hoist listen én gang i `extractBacklinksForDoc`, pass som param): bliver O(N) per extraction i stedet for O(L × N). Cirka **10-50× speedup** ved N ≥ 10.000.

**2. Contradiction-lint subscriber** tilføjer ~10 s (5 LLM-kald × 2 s) **per approval** uanset N. Konstant add-on, men det betyder approve-click bliver 10× langsommere når scannerne er live. Styres via `TRAIL_LINT_SKIP_CONTRADICTIONS=1`.

---

## 2. Lint-pass timing

`runLint` kører orphans + stale detektorer. F32.2-scheduleren tilføjer contradiction-scan over **alle** ready Neurons sekventielt hver 24. time.

### Orphans + stale, før alle fixes

| N | orphans scan | per-orphan N+1 (≈15 % rate × 2 queries) | stale (gammel, JS-filter) | ∑ |
|---:|---:|---:|---:|---:|
| 200 | 10 ms | 30 × 1 ms = 30 ms | 5 ms | ~50 ms |
| 500 | 25 ms | 75 × 1 ms = 75 ms | 5 ms | ~110 ms |
| 1.000 | 50 ms | 150 × 1 ms = 150 ms | 10 ms | ~210 ms |
| 5.000 | 250 ms | 750 × 1 ms = 750 ms | 50 ms | ~1 s |
| 10.000 | 500 ms | 1500 × 1 ms = 1,5 s | 100 ms | ~2,1 s |
| 50.000 | 2,5 s | 7500 × 1 ms = 7,5 s | 500 ms | ~11 s |
| 100.000 | 5 s | 15k × 1 ms = **15 s** | 1 s | **~21 s** |

### Orphans + stale, efter #1 stale-pushdown + #2 orphans batched

Trail har landet #2 (`b75d693`) og #1 (`packages/core/src/lint/stale.ts` pending i optimizer-batch):

| N | ∑ orphans + stale |
|---:|---:|
| 200 | ~10 ms |
| 1.000 | ~30 ms |
| 10.000 | ~100 ms |
| 100.000 | ~1 s |

**10-20× hurtigere** på toppen. Orphans er nu domineret af den ene aggregate-query + én batched LEFT JOIN i stedet for N individuelle round-trips.

### Contradiction-scheduler (dreaming pass, 24h interval)

Scanneren kører pr. KB og scanner **hver** ready Neuron sekventielt mod top-K peers via LLM:

| N | Tid per Neuron | Total per pass |
|---:|---:|---:|
| 200 | ~10 s | **33 min** |
| 500 | ~10 s | 83 min |
| 1.000 | ~10 s | **2,8 t** |
| 5.000 | ~10 s | 14 t |
| 10.000 | ~10 s | **28 t — overstiger 24h cycle** |
| 50.000 | ~10 s | 5,8 dage |
| 100.000 | ~10 s | **11,6 dage** |

**Fundamentalt skaleringsproblem:** ved N > ~8.000 kan contradiction-scan ikke nå rundt på én dag. Køen ophober sig, friske Neurons får aldrig deres tur. Dette er et arkitektonisk issue, ikke en perf-bug. Mulige løsninger:

1. **Sampling** — scan kun de N nyligst ændrede + tilfældigt udvalgte pr. pass. Acceptabelt dækning, forudsigelig cyklus.
2. **Reactive-only** — drop scheduled pass, bero på candidate_approved-subscriber. Mangel: ændringer i *citerede* Neurons fanger ikke modsigelse mellem to *eksisterende* Neurons.
3. **Parallelisering** — kør K claude-processer parallelt mod LLM-CLI'en. Begrænses af CLI token budget og lokal CPU.

---

## 3. Ingest / compile timing

Per kilde: spawnClaude CLI (haiku, max-turns 25, timeout 180s). LLM opretter typisk 2-5 Neurons via MCP-write pr. ingest. Hver write → createCandidate → auto-approval-policy → approveCreate → subscribers fyrer.

### Per-ingest total

| N (før ingest) | LLM-bundet | Post-each-approve subscribers (×3) | Total per ingest |
|---:|---:|---:|---:|
| 200 | 60-180 s | ~150 ms | ~180 s |
| 1.000 | 60-180 s | ~400 ms | ~180 s |
| 10.000 | 60-180 s | ~3 s | ~183 s |
| 50.000 | 60-180 s | ~15 s | ~195 s |
| 100.000 | 60-180 s | **~30 s** | ~210 s |

Ingest er **LLM-latency bundet**, ikke DB-bundet. Selv ved N=100.000 udgør subscriber-cost kun ~15 % overhead. Efter backlink-fix (#15) dropper overhead til <1 s — ingest-tiden bliver reelt konstant på tværs af skalaer.

### Batch-ingest (fx 100 sources på én gang)

Queue-backfill serialiserer via én CLI-lane:

| N slutstand | Uden backlink-fix | Med backlink-fix |
|---:|---:|---:|
| 200 | 5,0 t | 5,0 t |
| 10.000 | 5,1 t | 5,0 t |
| 100.000 | **5,8 t** | 5,0 t |

Serialiseret af natur — ingen parallel-gain uden større refactor (separate CLI-lanes per KB kunne være en bro, men hver ingest trækker 1-2 GB RAM fra claude-process, så 2-3 parallelle er realistisk maks).

---

## 4. Sammenfatning — hvor rammer vi mur

Før optimizer-fixes:

- **N ≈ 10.000** — approve/auto-link tager 1 s+ pga. backlink N+1. UX begynder at føles trægt.
- **N ≈ 8.000** — contradiction-scan kan ikke færdiggøres inden for 24h-cyklussen.
- **N ≈ 50.000** — enhver approve ≥ 5 s. Queue-arbejdet bliver visuelt langsomt.
- **N ≈ 100.000** — approve 10 s+, uden contradiction. Ubrugeligt under interaktiv kurering.

Med de landede og foreslåede fixes (#1, #2, #7 landet; #15 foreslået):

- **Approve/auto-link** holder sig under 500 ms helt op til N=100.000 (uden contradictions).
- **Lint uden contradictions** under 1 s ved N=100.000.
- **Ingest** reelt N-uafhængig (LLM-latency dominerer).

Kan ikke fixes uden arkitektonisk ændring:

- **Contradiction-scan** over alle Neurons — fundamental N × LLM-latency-skalering. Kræver sampling eller on-mutation-only model for at være levedygtig ved N > 10.000.

---

## 5. Anbefalinger i prioriteret rækkefølge

1. **Land #15 (backlink N+1 fix)** — single største gevinst for approve/ingest-perf ved alle skalaer N ≥ 5.000. Allerede rapporteret, kræver kun at `extractBacklinksForDoc` hoister wiki-listen én gang og passer den til `resolveLink`.
2. **Beslut contradiction-scan-strategi inden N > 10.000** — sampling er den enkleste vej. Dokumentér trade-off i F32.2.
3. **Overvej uniqueIndex på `(knowledgeBaseId, path, filename)`** (finding #12) — ved høj approval-rate kan dupes opstå. Billig migration.
4. **Index på `documents.updatedAt`** for stale-pushdown — bliver relevant ved N > 50.000. Ikke kritisk før da.

Trail's ingest-pipeline, queue, og SSE-broadcast layer skalerer i sig selv fint — flaskehalsene ligger konsekvent i N+1-queries og i LLM-latency. De første er gratis at løse. Den anden er et designvalg.

---

# Del II — Contradiction-scan strategier og økonomi

*Tilføjet 2026-04-19 som uddybning af § 5 pkt. 2. Besvarer: hvad indebærer sampling vs. on-mutation-only i praksis, hvor langt bringer parallelle claude-sessioner os, hvad koster en API-migration, og hvad betyder det for business plan.*

## 6. Sampling-modellen — uddybning

**Grundidé:** erstat "scan alle Neurons hver 24. time" med "scan en delmængde pr. pass, og tour rundt over tid". Kostnaden bliver konstant pr. pass uanset KB-størrelse; til gengæld tager det længere før en given Neuron får sin næste tur.

### Implementering

Tilføj en kolonne til `documents`:

```sql
ALTER TABLE documents ADD COLUMN last_contradiction_scan_at TEXT;
```

Scheduler læser `SELECT id FROM documents WHERE kind='wiki' AND archived=false ORDER BY last_contradiction_scan_at ASC NULLS FIRST LIMIT ?`. Efter hver scan opdateres kolonnen. "NULLS FIRST" sikrer at nye Neurons kommer forrest — de er per definition mest sandsynlige at introducere noget nyt.

### Strategi-varianter

| Strategi | Udvælgelse | Pro | Kon |
|---|---|---|---|
| **Round-robin** | Ordre efter `last_contradiction_scan_at` ASC | Fair, simpel, deterministisk | Én gammel Neuron blokerer hele paletten hvis dens scan fejler gentagne gange |
| **Stratificeret** | 70 % oldest-scanned + 30 % nyligt-ændrede (`updatedAt > now - 7d`) | Nye mutations fanges hurtigt; ingen Neuron glemmes | Kræver to queries + blanding |
| **Prioritet** | Score = `age_since_last_scan × edit_count × incoming_backlinks` | Neurons der "betyder mest" scannes oftere | Kræver mere bogføring; skal indekseres |

For MVP: round-robin. Skrifter 15 linjer kode + én migration.

### Dækningsvindue (round-robin)

Tiden før **hver** Neuron er scannet én gang (= "worst-case contradiction latency"):

| N Neurons | Sample-size = 200/pass | = 500/pass | = 1.000/pass | = 2.000/pass |
|---:|---:|---:|---:|---:|
| 200 | 1 dag | 1 dag | 1 dag | 1 dag |
| 500 | 2,5 dag | 1 dag | 1 dag | 1 dag |
| 1.000 | 5 dage | 2 dage | 1 dag | 1 dag |
| 5.000 | 25 dage | 10 dage | 5 dage | 2,5 dag |
| 10.000 | 50 dage | 20 dage | 10 dage | 5 dage |
| 50.000 | 250 dage | 100 dage | 50 dage | 25 dage |
| 100.000 | 500 dage | 200 dage | 100 dage | 50 dage |

Anbefalingen afhænger af tolerance: hvis "en modsigelse må leve op til en uge før detection" er acceptabelt, så er 2.000/pass brugbart op til N ≈ 10.000. Ud over det må enten sample-size øges, eller parallelisering tages i brug (se § 8).

### Hvad sampling **ikke** løser

- **Kold-start**: første pass efter at feature går live skal stadig berøre alle Neurons før et fuldt dæknings-SLA er etableret. Kan scriptes som én-gangs-backfill med højere parallelisme.
- **Deep-contradictions**: modsigelser mellem Neuron A og B kræver at én af dem bliver valgt til scanning. Sampler vi kun 200/pass og KB'en har 10k, vil A+B-par kun blive "samtidigt scannet" ved held (eller efter dækningsvindue). Contradiction-checkeren opererer dog allerede på "scan A, top-K peers incl. B" — så det er nok at A scannes for at par A,B opdages.

## 7. On-mutation-only-modellen — uddybning

**Grundidé:** fjern scheduled-pass helt. Bero udelukkende på den eksisterende `candidate_approved`-subscriber i `services/contradiction-lint.ts`. Arbejde er bundet af kuratorens approval-rate, ikke KB'ens størrelse.

### Hvad fanges

- Modsigelser **introduceret af en ny/opdateret Neuron** — subscriber fyrer på approval og scanner top-K peers mod den nye.
- Kædereaktioner hvor edit af A vækker en scan der også ser B-C-modsigelsen som sideeffekt (fordi top-K for A er B).

### Hvad **ikke** fanges

- **Pre-eksisterende modsigelser** der lå i Trailet før contradiction-lint blev aktiveret. Løses kun via en engangs-backfill scan.
- **Drift-modsigelser**: Neuron A skrevet under forståelse X, Neuron B skrevet senere under forståelse Y, ingen af dem edites bagefter. Hverken A eller B's `candidate_approved` fyrer igen, så parret forbliver usynligt. I praksis: kildegrundlaget ændres (fx en guideline er revideret) men Trails tidligere opsummeringer forbliver statiske. Sampling ville fange det. On-mutation-only ikke.
- **Tredjeparts-kontekst**: hvis Neuron C senere tilføjes med information der afslører A≠B, kun C's scan detekterer det — A+B-par alene består.

### Cost

Antag 10 approvals/dag i en aktiv KB. Contradiction-scan pr. approval: 5 peer-checks × ~2s LLM = 10s. Total: 100s/dag. Uafhængig af N.

I praksis **perfekt til hobby- og lavvolumen-plans**, fordi uanset KB-størrelse er CPU/LLM-forbruget loftet på approval-frekvens — hvilket er et mål for brugerens aktive brug, ikke et mål for lagrets størrelse.

### Hybrid: on-mutation + månedlig fuld backfill

Rimeligt kompromis for alle tier. Kør contradiction-scan på hver approval (gratis-ish, dækker 80 % af real-world modsigelser), og kør en fuld pass én gang pr. måned som catch-up for drift. Ved N=10.000 er månedlig fuldscan ~28 timer sekventielt — kan scheduleres til weekend-natt med acceptabel risiko.

## 8. Parallelle claude-sessioner

Contradiction-lint-scanneren kalder p.t. claude seriel: per Neuron, per top-K peer, én synkron spawn ad gangen. Outer parallelism (flere Neurons i parallel) og inner parallelism (peers i parallel inden for én Neuron) er to forskellige drejeknapper.

### Begrænsninger

**Lokal CLI (current stack, Max subscription):**
- Hver `claude -p` subprocess: ~500MB-2GB RAM afhængigt af model + context.
- 8GB VPS → maks 3-4 parallel (safely 2).
- 32GB maskine → maks 16 (safely 8).
- **Rate-limit gruppe:** Max subscription har delt kvote. Overbelastning giver 429'er + backoff. Realistisk P ved Haiku: 4-6. Ved Sonnet: 2-3.

**Anthropic API direct:**
- Ingen per-proces RAM-cost (bare HTTP).
- Tier 1 (default): ~50 RPM / 40k TPM på Haiku. P=1-2 realistisk.
- Tier 2 ($40+ betalt): 1.000 RPM / 100k TPM. P=8-16 mulig.
- Tier 3 ($400+ betalt): 2.000 RPM / 200k TPM. P=16-32 mulig.

### Tid til fuld scan af alle N Neurons

Serial baseline: ~10s pr. Neuron (5 peer-checks × 2s).

| N | Serial | P=2 | P=4 | P=5 | P=8 |
|---:|---:|---:|---:|---:|---:|
| 200 | 33 min | 17 min | 8 min | 7 min | 4 min |
| 500 | 83 min | 42 min | 21 min | 17 min | 10 min |
| 1.000 | 2,8 t | 1,4 t | 42 min | 33 min | 21 min |
| 5.000 | 14 t | 7 t | 3,5 t | 2,8 t | 1,7 t |
| 10.000 | **28 t** | 14 t | 7 t | 5,6 t | 3,5 t |
| 50.000 | 5,8 dage | 2,9 dage | 35 t | 28 t | 17,5 t |
| 100.000 | **11,6 dage** | 5,8 dage | 2,9 dage | 56 t | 35 t |

**Observationer:**
- Ved P=8 **kan** N=10k og N=50k nås inden for 24h-vinduet. N=100k stadig overbooket.
- Parallel alene løser problemet op til N ≈ 50.000. Over det er sampling påkrævet uanset.
- Den lokale CLI kan ikke realistisk køre P > 4 i længere tid uden dedikeret hosting — den Max subscription-enhed vi har i dag lever sammen med cc-sessioner, ingest-compile, chat, og action-recommender, som alle trækker på samme kvote.

### Sampling + parallel kombineret

Ideel driftsprofil for store KB'er: sampling 1.000 Neurons/pass × P=4.

| N | Dækningsvindue @1.000/pass, P=4 |
|---:|---:|
| 10.000 | 10 dage (42 min wall-time pr. pass) |
| 50.000 | 50 dage |
| 100.000 | 100 dage |

42 min/pass kan scheduleres natligt. Dækningsvindue accepteres mod at get mutation-only-subscriberen fanger 80+% af real-world modsigelser i realtid.

## 9. Cloud API-økonomi

**Scenarie:** vi migrerer fra Claude Code CLI (Max subscription) til direkte Anthropic API-kald fra trail-serveren. Spørgsmål: hvad koster det, og hvor krydser det over Max subscription?

### Pris-antagelser

Haiku 4.5 (hurtig, billig tier) — vores mål for contradiction + translation + action-recommender:
- Input: ~$1/M tokens
- Output: ~$5/M tokens

(Tal er approksimative; Anthropic opdaterer prislisten. Ved Sonnet er input/output roughly 3× og 3× højere; ved Opus ~15× begge.)

**Per contradiction-check:**
- Input: Neuron A body (~500 tok) + Neuron B body (~500 tok) + system prompt (~500 tok) = ~1.500 tokens
- Output: y/n + kort quote + summary = ~200 tokens
- Kost: (1.500 × $1 + 200 × $5) / 1.000.000 = **$0,0025**

**Per Neuron-scan** (5 peer-checks): $0,0125

### Månedlig API-omkostning per strategi

| N Neurons | Fuld daglig scan | Sampling 1.000/pass | On-mutation-only (10 appr./dag) |
|---:|---:|---:|---:|
| 200 | $75/mdr | $375/mdr | $3,75/mdr |
| 500 | $188/mdr | $375/mdr | $3,75/mdr |
| 1.000 | $375/mdr | $375/mdr | $3,75/mdr |
| 5.000 | $1.875/mdr | $375/mdr | $3,75/mdr |
| 10.000 | **$3.750/mdr** | $375/mdr | $3,75/mdr |
| 50.000 | $18.750/mdr | $375/mdr | $3,75/mdr |
| 100.000 | **$37.500/mdr** | $375/mdr | $3,75/mdr |

**Udover contradiction-scan:** ingest-compile og chat trækker også fra samme konto.

| Feature | Typisk forbrug | Månedlig kost/KB (aktiv bruger) |
|---|---|---|
| Ingest-compile | 1-5 kilder × 50k tok input + 10k tok output | $5-25/mdr |
| Chat Q&A | 30 queries × 5k in + 1k out | $0,30/mdr |
| Action-recommender | 100 pending candidates × 2k in + 200 out | $0,30/mdr |
| Translation (lazy) | 50 candidates × 3k in + 1k out | $0,30/mdr |

**Samlet per aktiv KB (on-mutation contradictions, moderat ingest):** ~$10-30/mdr.

### Crossover vs. Max subscription

Claude Max (individual) koster ~$200/mdr og dækker stort set ubegrænset brug inden for rate-limits. For vores brug:
- En enkelt aktiv KB (on-mutation + moderate ingest): ~$10-30 API vs. $200 Max. **API er billigere.**
- Fuld daglig scan af N=5.000 KB: $1.875 API vs. $200 Max. **Max er billigere** — men Max rate-limits vil ramme hårdt ved høj parallelisme.

Max er et pay-for-unlimited-på-én-seat produkt. Når vi er et SaaS med tusindvis af tenants, kan vi ikke "have Max" for alle — Anthropic's TOS tillader det ikke, og det skalerer ikke. **Vejen til flere tenants går via API.**

### API-migration-kostnad (engangs)

- Udskift `spawnClaude(args, opts)` → `anthropic.messages.create(...)` i `services/claude.ts`, `contradiction-lint.ts`, `source-inferer.ts`, `translation.ts`, `action-recommender.ts`.
- Estimat: 2-3 dages arbejde for ren drop-in.
- Behold CLI-sti bag feature flag (`TRAIL_CLAUDE_TRANSPORT=cli|api`) for dev + local tests.

## 10. Business plan-implikationer

Nuværende plan-grænser (`apps/server/src/routes/user.ts`):

| Plan | maxPages | maxStorageBytes |
|---|---:|---:|
| hobby | 500 | 1 GB |
| pro | 5.000 | 10 GB |
| business | 50.000 | 100 GB |
| enterprise | unbounded | unbounded |

"Pages" her er summen af sources + Neurons (`kind='source'` + `kind='wiki'`). Ved en typisk ratio ~1:3 (flere Neurons end sources) svarer det til ~375 / 3.750 / 37.500 Neurons pr. plan.

### Hvad hver plan kan understøtte

**Hobby (500 pages ≈ 375 Neurons):**
- On-mutation-only scan: $3,75/mdr LLM-kost. Sampling 500/pass daglig: $375/mdr — ufinancierbart.
- **Anbefaling:** KUN on-mutation-scan. Ingen scheduled. Tilbud: "Contradiction-finder in realtime; no historic pass".
- Plan-pris ~$5-10/mdr kan bære dette med massiv margen.

**Pro (5.000 pages ≈ 3.750 Neurons):**
- Daglig fuldscan: $1.400/mdr — ufinancierbart.
- Sampling 500/pass: $188/mdr. Dækningsvindue ~7,5 dage. Alright.
- On-mutation + månedlig fuld-backfill: ~$3,75 + ($47/backfill) = ~$10/mdr. Massivt billigere.
- **Anbefaling:** On-mutation realtime + månedlig backfill. Skal kommunikeres som "dybdescan én gang pr. måned + realtime på alt nyt".
- Plan-pris ~$20-30/mdr realistisk.

**Business (50.000 pages ≈ 37.500 Neurons):**
- Daglig fuldscan: $14.000/mdr — ufinancierbart.
- Sampling 2.000/pass: $750/mdr. Dækningsvindue ~19 dage.
- On-mutation + månedlig fuld: $3,75 + $470 = ~$475/mdr for backfill (28t wall-time).
- **Anbefaling:** Sampling 2.000/pass + valgbar kvartalsvis fuld-backfill. Parallelisme P=4 kræves for at holde backfill inden for en weekend.
- Plan-pris ~$99-199/mdr realistisk, afhængigt af SLA på backfill.

**Enterprise (100.000+ pages):**
- Daglig fuldscan: $37.500+/mdr — kun på enterprise-grade plan.
- Sampling aggregeret kan konfigureres per customer-SLA.
- P=8-16 parallelisme via dedicated tier 2/3 API-kvoter.
- **Anbefaling:** custom pricing. Kunde vælger sampling-dækning og backfill-frekvens. Typisk $500-2.000/mdr infra-del + base-plan.

### Feature-gating strategi

| Feature | Hobby | Pro | Business | Enterprise |
|---|---|---|---|---|
| Ingest-compile | ✓ | ✓ | ✓ | ✓ |
| Chat Q&A | 100/mdr | 1k/mdr | 10k/mdr | unlimited |
| On-mutation contradiction | ✓ | ✓ | ✓ | ✓ |
| Scheduled contradiction-sampling | ✗ | ✓ (500/pass) | ✓ (2.000/pass) | custom |
| Månedlig full-backfill | ✗ | ✓ | ✓ | ✓ |
| Parallelism tier | P=1 | P=2 | P=4 | P=8+ |
| Connector types | upload, chat, buddy | + mcp:* | + slack/github/linear | alle |

### Forretningsmæssig konsekvens af valg

**Hvis vi vil have contradiction-lint som et differentierende salgsargument:**
- Pro+: scheduled sampling er afgørende. Kræver API-migration.
- Markering: "Trail er den eneste KB der aktivt finder sine egne modsigelser".
- Prisposition: Pro ~$25/mdr vs. Notion AI på ~$10/mdr — premium positionering.

**Hvis contradiction-lint er en teknisk detalje, ikke et salgsargument:**
- On-mutation-only på alle tiers. Ingen scheduled.
- Prisposition: følg markedet ($10-15 hobby tier vs Obsidian Sync $8/mdr).
- Teknisk gevinst: vi slipper for at bygge sampling-infrastruktur.

**Mit valg:** positioner contradiction-lint som premium-feature på Pro+. Hobby får "realtime check on every save" (on-mutation). Det er sales-funnel sproget alligevel — hobbyister vil sjældent have 5k Neurons, og dem der gør har incitament til at opgradere.

### Kritiske arkitektoniske beslutninger før vi kan sælge Pro+

1. **API-migration** (`services/claude.ts` → Anthropic SDK direct). 2-3 dage. Forudsætning for hvad som helst over Hobby.
2. **`documents.last_contradiction_scan_at` kolonne + scheduler-logic.** 1 dag. Forudsætning for sampling.
3. **Parallelisme-runner** (Promise.all med concurrency limit via p-limit el. similar). 0,5 dag. Forudsætning for at holde Business-tier under SLA.
4. **Per-tenant LLM-budget-tracking + soft-cap.** 2-3 dage. Forudsætning for at sælge Pro+ uden fare for runaway costs.
5. **Dedicated tier 2/3 API-kvoter** (Anthropic contract negotiation). Eksternt. Forudsætning for Enterprise parallelisme P=8+.

### Break-even hurtig-regning

Ved Pro $25/mdr:
- API-kost on-mutation + månedlig backfill: ~$10/mdr
- Hosting + storage: ~$3/mdr
- Margin: $12/mdr × 100 kunder = $1.200/mdr dækker 0,6 FTE udvikler.

Skaleringspunktet: omkring 200-300 Pro-kunder begynder det at kunne bære én fuld udvikler + server-drift. Det er den tidsramme der bestemmer hvor aggressivt API-migrationen skal prioriteres. Hvis GTM'en sigter på 100+ betalende Pro-kunder i 2026Q3, skal punkt 1-4 være nedfældet senest 2026Q2.
