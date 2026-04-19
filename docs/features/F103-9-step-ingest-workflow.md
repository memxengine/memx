# F103 — 9-step Ingest Workflow Formalization

*Planned. Tier: core. Effort: 30 minutes.*

> Trail's ingest-prompt skrives om som en streng numereret 9-step-checklist matching Balu's CLAUDE.md. Ingen kode-logik-ændring — bedre LLM-adherence gennem tydelig struktur.

## Problem

`apps/server/src/services/ingest.ts` har i dag en ingest-prompt med ~8 trin, men blandet prose + numererede instruktioner. LLM-output varierer mere end nødvendigt — nogle gange oprettes source-summary, nogle gange dropper den direkte til concept-pages. Balu's 9-step-formulering producerer mere konsistente ingests.

## Solution

Re-struktur prompt som eksplicit 1-9-liste:

```
1. Read the source file from raw/
2. Discuss key takeaways; ask 1-3 clarifying questions
3. Create a summary page in /neurons/sources/ named after the source
4. Identify and update affected existing wiki pages
5. Create new entity pages (concepts, entities, personas, etc.) as warranted
6. Update /neurons/glossary.md with new or refined terms
7. Update /neurons/overview.md if the source shifts the big picture
8. Append entry to /neurons/log.md with format:
   ## [YYYY-MM-DD] ingest | <source title>
   - Pages created: ...
   - Pages updated: ...
   - Key additions: ...
9. Confirm all frontmatter includes: title, type, sources, tags, date
```

## How

- Rediger `apps/server/src/services/ingest.ts` prompt-template
- Lav A/B-test på 3 test-sources: count Neurons skabt før/efter + verifikér frontmatter-completeness
- Commit med A/B-resultat i commit-beskeden

## Dependencies

- F102 (glossary exists) — trin 6 forudsætter glossary-Neuron findes
- F101 (type-frontmatter) — trin 9 kræver type-felt

## Success criteria

- Prompten er maksimalt 9 nummererede trin med konsistent format
- A/B-test viser ≥90 % frontmatter-completeness efter ingest (før: ~70 %)
- Log-entries følger unix-greppable `## [YYYY-MM-DD] ingest |`-format
