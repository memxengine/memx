# Konkrete adopt-items fra Karpathy's gist + Balu's referenceimplementation

*Supplement til `KARPATHY-ALIGNMENT.md`. Skrevet 2026-04-20 efter gennemlæsning af Balu Kosuri's Medium-artikel (Apr 7, 2026) + hans repo [balukosuri/llm-wiki-karpathy](https://github.com/balukosuri/llm-wiki-karpathy) + Karpathy's originale [llm-wiki.md gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).*

## Udgangspunkt

KARPATHY-ALIGNMENT.md beskriver konceptuelle gaps. Dette dokument lister **konkrete ting der kan copy-paste'es eller reimplementeres i Trail** — med estimerede timer, ikke dage.

Totalbudget: **~2-3 arbejdsdage** for alle 7 adopt-items samlet. Det er så lille at hele pakken kan lande som én sprint.

## Adopt-items sorteret efter impact/effort

### #1 — Pre-konfigureret `.obsidian/`-vault i Obsidian-export (2-3 timer)

Balu's repo indeholder komplet `.obsidian/`-mappe med:
- `app.json` — file paths, link behavior
- `appearance.json` — theme, font size
- `core-plugins.json` — hvilke plugins er aktive
- `graph.json` — farver + layout til graph-view
- `hotkeys.json` — keyboard shortcuts
- `workspace.json` — default tabs + sidebar

Når en bruger eksporterer sin Trail-KB til Obsidian, ZIPpes:

```
trail-export-<kbId>-<date>.zip
├── raw/
│   └── <source>.md                  (alle kind='source' docs med frontmatter)
├── wiki/
│   ├── index.md                     (fra overview.md)
│   ├── log.md                       (fra eksisterende log.md)
│   ├── glossary.md                  (fra glossary.json — se #3)
│   └── <path>/<slug>.md             (alle kind='wiki' Neurons)
├── .obsidian/                       ← COPIED FROM BALU'S REPO
│   ├── app.json
│   ├── appearance.json
│   ├── core-plugins.json
│   ├── graph.json
│   ├── hotkeys.json
│   └── workspace.json
├── CLAUDE.md                        (Trail's ingest-prompt som plain-text)
└── README.md                        (Trail-attribution + Obsidian-åbne-guide)
```

Brugeren åbner mappen i Obsidian → alt er pre-konfigureret, graph-view farve-kodet per type, hotkeys sat op.

**Repo er offentligt**, men vi skal verificere licens (sandsynligvis MIT eller CC-BY) og give attribution i README.

**Implementering:**
- Ny endpoint `GET /api/v1/knowledge-bases/:kbId/export/obsidian` der streamer ZIP
- Engangs-copy af `.obsidian/` som checked-in template i `apps/server/src/templates/obsidian-vault/`
- Markdown-fil-rendering via eksisterende `documents.content`
- Frontmatter auto-genereres med `type:` (se #2)

### #2 — `type:` frontmatter-felt (2-4 timer)

Balu's CLAUDE.md kræver `type: source | feature | product | persona | concept | style | analysis` i frontmatter. Vi har `tags, sources, date` men ikke `type`.

Uden `type`-felt kan Obsidian's Dataview-plugin ikke filtrere Neurons per kategori. Det er kernen til en produktiv Obsidian-browse-oplevelse.

**Implementering:**
- Udled `type` fra `documents.path` ved export-tid:
  - `/neurons/sources/` → `type: source`
  - `/neurons/concepts/` → `type: concept`
  - `/neurons/entities/` → `type: entity`
  - `/neurons/queries/` → `type: analysis`
  - `/neurons/sessions/` → `type: session`
- Tilføj til YAML frontmatter-output i export-endpoint (#1)
- Ingen DB-ændring kræves — path er kilde til sandhed

**Fremtidig udvidelse:** eksponér `type` som kolonne på `documents`-tabellen når vi vil bruge det i admin-UI også. For export alene er computed-from-path nok.

### #3 — `/neurons/glossary.md` som auto-maintained wiki-fil (4-6 timer)

I dag har vi `apps/server/src/data/glossary.json` med 20 statiske EN/DA-termer. Det er en hardcoded fil, ikke en evolving artifact.

Karpathy's pattern + Balu's implementation: `wiki/glossary.md` er en **kurator-wiki-fil som LLM vedligeholder** — nye termer tilføjes løbende, eksisterende termer revideres når ingest møder ny brug.

**Implementering:**
- Ved ny KB-creation: opret `/neurons/glossary.md` som seed-Neuron med indhold fra glossary.json
- Udvid ingest-prompt trin 6 (nu: "update the log"): tilføj "Review glossary.md — add new terms, revise ambiguous definitions based on this source's usage"
- Glossary.md bliver en normal Neuron med `type: glossary` i frontmatter — søgbar, redigerbar, backup-able via wiki_events

**Backwards-compat:** behold glossary.json som seed-data indtil alle eksisterende KBs er migrated. Admin-UI kan fortsat rendere den eksisterende Glossary-panel fra DB-versionen.

### #4 — 9-step ingest workflow formaliseret i prompten (30 min)

Balu's CLAUDE.md struktur ingest-workflow som numereret checklist:

```
1. Read source file from raw/
2. Discuss key takeaways; ask 1-3 clarifying questions
3. Create summary page in wiki/sources/
4. Identify and update affected existing wiki pages
5. Create new entity pages (feature, concept, persona, etc.)
6. Update wiki/glossary.md
7. Update wiki/index.md
8. Update wiki/overview.md if shift
9. Append entry to wiki/log.md
```

Vores `services/ingest.ts` prompt har tilsvarende indhold men mindre struktureret — blandet prose + numererede trin. LLM-adherence er bedre med strengere checklist-format.

**Implementering:**
- Re-skriv ingest-prompten (ingest.ts linje ~78-123) som numereret 1-9-checklist
- Ingen kode-logik-ændring, ren prompt-engineering
- A/B test før/efter på 3 test-sources → bekræft at den nye prompt producerer mere konsistente page-antal

### #5 — Per-KB prompt-profiler (1 dag)

Balu har specialiseret CLAUDE.md til **technical writers** — tilføjede personas, features, products, style-rules. Karpathy's eksempler dækker også **book-reading** (characters, themes, plot threads), **competitive analysis**, **due diligence**, **trip planning**.

Hver domæne har brug for forskellige Neuron-typer. I dag er vores ingest-prompt global server-side — samme prompt for alle KBs.

**Implementering:**
- Ny DB-kolonne: `knowledge_bases.ingest_profile` ENUM('researcher', 'technical-writer', 'book-reader', 'business-ops', 'custom')
- Hver profil mapper til en prompt-template i `apps/server/src/services/ingest-profiles/`
- Custom giver kunden en tekst-editor til at skrive egen prompt (Business-tier feature)
- Default for nye KBs: 'researcher' (nuværende adfærd)
- Settings-UI i admin lader kurator skifte profil (advarsel: ændring påvirker kun fremtidige ingests)

**Hvorfor det er impact-fuldt:** det positionerer Trail til flere use-cases uden kode-ændring. En onboarding-kunde der siger "jeg bygger en competitive-intelligence-KB" kan blot vælge den rette profil.

### #6 — Proaktiv "Skal jeg gemme dette som Neuron?"-prompt (1 dag)

Balu's query-workflow: *"The AI reads the wiki, puts together an answer, and asks: 'Should I save this as a wiki page?'"*

AI'en foreslår proaktivt, brugeren bekræfter. Vi har `saveChatAsNeuron` men det er en knap brugeren skal huske at trykke.

**Implementering:**
- Chat-API's response-JSON udvides:
  ```json
  {
    "answer": "...",
    "citations": [...],
    "suggestedSave": {
      "title": "<llm-foreslået title>",
      "path": "/neurons/analyses/",
      "reason": "This answer synthesizes 4 sources and didn't exist as a page yet"
    }
  }
  ```
- LLM'en beslutter `suggestedSave: null` hvis svaret er trivielt eller allerede dækket af en Neuron
- Admin-UI render'er hvis ikke-null: *"💡 Skal jeg gemme dette som Neuron 'Competitive positioning against Notion'?"* + [Ja, gem] [Nej]
- Bekræftelse laver candidate → auto-approver under Solo-mode, queue under Curator-mode

### #7 — Gem Karpathy's llm-wiki.md som attribution-fil (5 min)

Karpathy's gist er offentlig, ~2.000 ord, designet til at blive copy/pastet. At gemme den ordret i vores repo giver:

1. **Attribution** — tydelig credit til kilden
2. **Reference-material** — cc-sessioner kan læse hans eksakte ord uden at hente eksternt
3. **Doc-SEO** — folk der googler "Karpathy LLM wiki" kan lande på trail repo og se vores implementation som next-level
4. **Intellektuel ærlighed** — vi baserer arkitekturen på hans pattern, det bør være eksplicit

→ **Gemt som `docs/KARPATHY-LLM-WIKI-ORIGINAL.md` som del af dette commit.**

## Bi-produkter fra Karpathy's original gist vi kan anvende

Ud over de 7 adopt-items er der fragmenter værd at notere:

### qmd — hybrid search engine (reference kun)

Karpathy nævner [qmd](https://github.com/tobi/qmd) — local markdown search med BM25 + vector + LLM re-ranking, CLI + MCP-server.

Relevant når Trail's FTS5 ikke længere skalerer (estimated N > 10.000 Neurons pr. KB). For nu er SQLite FTS5 rigelig. **Bevar som link i SCALING-ANALYSIS.md** som fremtidig option.

### Log.md grep-pattern

> *"if each entry starts with a consistent prefix (e.g. `## [2026-04-02] ingest | Article Title`), the log becomes parseable with simple unix tools — `grep "^## \[" log.md | tail -5` gives you the last 5 entries"*

Vi genererer allerede log-entries i dette format (se ingest.ts linje 108-114). **Bevar format eksplicit** — skriv det som krav i CLAUDE.md og Obsidian-export's README.

### Obsidian-metafor

> *"Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase."*

**Brug denne i marketing.** Koncis, minderig, præcis. Passer perfekt på vores Solo-mode-positionering.

### Image-håndtering

> *"LLMs can't natively read markdown with inline images in one pass — the workaround is to have the LLM read the text first, then view some or all of the referenced images separately to gain additional context."*

Vi har dette problem i vores PDF-pipeline (`packages/pipelines/src/pdf/index.ts` — images extraheret separat, markdown refererer dem). **Patternen er korrekt** — bare bekræftet af Karpathy. Ingen kode-ændring.

### Memex / Vannevar Bush

Karpathy refererer Bush's Memex (1945) som spiritual forgænger. Vi har **allerede `docs/as-we-may-think.md`** i repo'en — perfekt alignment. **Løft frem i marketing**: "Vi bygger det Vannevar Bush forestillede sig, som Karpathy re-proklamerede, med AI som vedligeholder."

### Use-case-liste

Karpathy's gist nævner specifikt:
- Personal (health, psychology, self-improvement)
- Research (papers over weeks/months)
- Reading a book (character/theme/plot wiki)
- Business/team (Slack/meetings/docs)
- Competitive analysis, due diligence, trip planning, course notes, hobby deep-dives

**Hver er en potentiel Trail-kunde-profil.** Marketing-sitet bør liste dem med eksempel-setups. CMS-connector-kapitel dækker "Business/team" — men de øvrige er uudforskede markets.

## Adopt-plan samlet

Hvis alle 7 items landes som én sprint:

| # | Item | Effort | Landingsfokus |
|---|---|---|---|
| 1 | Obsidian-vault-export med pre-config | 2-3 t | Eksport-endpoint, template checked in |
| 2 | `type:` frontmatter | 2-4 t | Samme endpoint, tilføj felt |
| 3 | Auto-maintained glossary.md | 4-6 t | Ingest-prompt + seed-ved-KB-create |
| 4 | 9-step ingest-workflow | 30 min | Prompt-refactor |
| 5 | Per-KB prompt-profiler | 1 dag | Schema + profiles/-mappe + UI |
| 6 | Proaktiv save-prompt | 1 dag | Chat-API udvidelse + UI |
| 7 | Karpathy's gist som attribution-fil | 5 min | Committet nu |

**Total: ~2-3 dages arbejde**. Resultat: Trail matcher Balu's repo-oplevelse + tilføjer SaaS-infrastruktur oven på.

## Prioritering hvis ikke alt kan landes

Top-3 må-land: **#1 (Obsidian-export), #2 (type:-frontmatter), #5 (prompt-profiler)**. Disse tre sammen gør Trail til et **reelt alternativ** til at køre Balu's repo lokalt — du får eksportér-og-flyt-hvor-som-helst frihed + domæne-specialisering + hostet convenience.

Resten (#3, #4, #6) er inkrementelle forbedringer der kan landes organisk.

## Licens-note

Balu's repo er **offentlig på GitHub**. Før vi kopierer `.obsidian/`-konfiguration skal vi:

1. Verificere licens (tjek LICENSE-fil eller README-footer)
2. Inkludere attribution i vores eksport-README (og evt. i admin-UI under "Credits")
3. Hvis ingen licens angivet → kontakte Balu direkte for tilladelse (han vil sandsynligvis være flattered, ikke restriktiv)

Karpathy's gist er ikke licens-markeret men er eksplicit designet til at blive delt: *"it is designed to be copy pasted to your own LLM Agent"*. Attribution er implicit forventet.

## Beslutningslog

- **#1-7 alle adopteres** som del af næste optimizer-sprint
- **Obsidian-export er afgørende** for Solo-tier-konkurrence mod "brug repo gratis lokalt"
- **Per-KB prompt-profiler er afgørende** for ikke-technical-writer-use-cases
- Karpathy's gist kopieres ind som `docs/KARPATHY-LLM-WIKI-ORIGINAL.md` med attribution
- Balu's repo krediteres i eksport-README + trail.broberg.dk /credits-side
- Marketing-team informeres: metafor "Obsidian is the IDE" + Memex-forgænger + use-case-listen er klar til at bruge
