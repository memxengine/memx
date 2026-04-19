# F104 — Per-KB Prompt Profiles

*Planned. Tier: alle (default Researcher), custom er Business+. Effort: 1 day.*

> Hver KB vælger en **ingest-profil** (Researcher / Technical-Writer / Book-Reader / Business-Ops / Custom) der bestemmer hvilke Neuron-typer der produceres + hvordan compile-prompten struktureres. Trail går fra "én prompt passer alle" til "pattern matcher dit domæne".

## Problem

I dag er ingest-prompten global server-side. Samme prompt bruges til Sanne's medicinske KB, webhouse-docs-KB, og en hypotetisk book-reading-KB. Balu specialiserede hans CLAUDE.md til technical writers (personas, features, products, style-rules). Karpathy's gist lister fem andre use-cases (research, book-reading, business, competitive analysis, trip planning) — hver med egne Neuron-typer.

## Solution

Ny DB-kolonne:

```sql
ALTER TABLE knowledge_bases ADD COLUMN ingest_profile TEXT
  CHECK (ingest_profile IN ('researcher', 'technical-writer', 'book-reader', 'business-ops', 'custom'))
  NOT NULL DEFAULT 'researcher';
```

Plus valgfri `ingest_prompt_override TEXT` for Custom-profilen.

Hvert profil-navn peger på en template-fil:

```
apps/server/src/services/ingest-profiles/
├── researcher.md        nuværende prompt — concepts, entities, sources
├── technical-writer.md  + features, products, personas, style
├── book-reader.md       + characters, themes, plot-threads
├── business-ops.md      + slack-threads, meetings, decisions
└── _base.md             fælles 9-step-struktur fra F103
```

Runtime: `loadProfile(kb.ingest_profile)` henter template + substituerer base-blokke.

## How

- Schema-migration tilføjer kolonne
- Admin Settings > Trail tilføjer profile-selector dropdown + "Avanceret" toggle der eksponerer Custom-editor (Business+ only)
- Ingest.ts læser kb.ingest_profile og loader korresponderende template
- Ændring påvirker kun **fremtidige** ingests — eksisterende Neurons bevares

## Dependencies

- F103 (9-step workflow som base for alle profiler)

## Success criteria

- 4 built-in profiler med distinkt output-shape testet på samme 3 test-sources
- Custom-profile (Business+) tillader tekst-editor i admin med live preview af prompt
- Profile-skift er reversibel via audit-log (kan ses hvilken profil der producerede hvilken Neuron)
