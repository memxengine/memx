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
