# F102 — Auto-maintained Glossary Neuron

*Planned. Tier: alle. Effort: 4-6 hours.*

> Hver KB får en `/neurons/glossary.md` Neuron som LLM vedligeholder. Nye termer tilføjes ved hver ingest, tvetydige definitioner revideres, gamle termer ryger ikke tabt. Udskifter dagens statiske `glossary.json`-fil som aldrig har fulgt med det faktiske indhold.

## Problem

`apps/server/src/data/glossary.json` er hardcoded med 20 EN/DA-termer. Den er seed-data fra F94 og har ikke ændret sig siden. Når en KB vokser og udvikler eget vokabular (Sanne's akupunktur-termer, webhouse-CMS-feature-navne), står glossary.json stille. Karpathy's pattern + Balu's implementation har glossary.md som living artifact.

## Solution

Ved KB-creation oprettes en seed-Neuron `/neurons/glossary.md` med indhold fra glossary.json (oversat til DA/EN afhængigt af `kb.language`). Ingest-prompten (trin 6, F103) opdaterer glossary.md når den møder nye eller tvetydige termer.

```yaml
---
title: Glossary
type: glossary
---

## Akupunktur
**EN:** Traditional Chinese medicine technique inserting fine needles at specific body points.
**DA:** Traditionel kinesisk medicinsk teknik...
_Sources: [Øreakupunktur_DIFZT_2025.pdf, intro-to-tcm.pdf]_

## Øreakupunktur (Auricular acupuncture)
...
```

## How

- Migration: iterate alle eksisterende KBs, opret `/neurons/glossary.md` som Neuron (kind='wiki', path='/neurons/', filename='glossary.md')
- Ingest-prompt (trin 6 i F103) udvides: "Review glossary.md — tilføj nye termer fra denne kilde, revider tvetydige definitioner baseret på denne kildes brug"
- `glossary.json` beholdes som seed-content-fil, bruges KUN ved ny KB-creation
- Admin-UI's eksisterende Glossary-panel læser fra glossary-Neuron via normal neuron-load-path (ingen special-case)

## Dependencies

- F103 (9-step ingest workflow) — glossary-update er trin 6

## Success criteria

- Ny KB får glossary.md som synlig Neuron i wiki-tree
- Ingest af source der introducerer ny term tilføjer entry til glossary.md
- Gamle glossary.json-termer migreres som seed-indhold
- Eksport via F100 inkluderer glossary.md i `wiki/`
