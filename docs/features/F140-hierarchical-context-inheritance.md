# F140 — Hierarchical Context Inheritance

*Planned. Tier: alle. Effort: 1-1.5 days.*

> En Neuron på `/neurons/concepts/akupunktur/nada.md` arver compile-kontekst fra parent-path'ens `_schema.md` (eller søskende-`README.md`) — eksempler, tone, struktur-konventioner, taxonomi. Komplementerer F104 (per-KB prompt profiles) med per-PATH profiles. Én KB kan dermed have flere domæner (Sannes akupunktur + coaching + business-delen) uden at de forurener hinandens compile-regler.

## Problem

F104 per-KB prompt profiles lader en hel KB have sin egen compile-ton (dansk vs engelsk, medicinsk-formel vs casual, entities-vs-concepts-balance). Men Sannes KB er faktisk TRE domæner i ét:

- `/neurons/concepts/akupunktur/` — NADA, punkter, kontraindikationer → klinisk/medicinsk tone
- `/neurons/concepts/coaching/` — Box Breathing, samtaleteknikker, klient-refleksion → terapeutisk tone
- `/neurons/concepts/business/` — prispolitik, klient-booking → forretnings-tone

Én prompt-profile til alle tre er altid kompromis. Waykee Cortex's "strict hierarchical inheritance model" løser det: hver path-node i wiki'en kan have sit eget schema; compile-prompten assembles via inheritance-chain fra root → target.

## Solution

Konvention: enhver path kan have en `_schema.md`-fil der beskriver compile-regler for den undermappe:

```
/neurons/
├── _schema.md                              KB-wide default (linker til F104 profile)
├── concepts/
│   ├── _schema.md                          overrides for /concepts
│   ├── akupunktur/
│   │   ├── _schema.md                      klinisk/medicinsk tone, kræver kontraindikations-sektion
│   │   └── nada.md                         compile'es med: F104 + /_schema + /concepts/_schema + /concepts/akupunktur/_schema
│   └── coaching/
│       ├── _schema.md                      terapeutisk tone, første-person
│       └── box-breathing.md                compile'es med kombineret inheritance
```

`_schema.md` frontmatter beskriver hvad den overrider/udvider:

```yaml
---
type: schema
scope: /neurons/concepts/akupunktur/
tone: "Clinical, medical — use Danish fagtermer (NADA, abstinenser, ørepunkter); cite only peer-reviewed sources or clinical guidelines."
required_sections:
  - "Indikationer"
  - "Kontraindikationer"
  - "Referencer"
tags_canonical: [nada, akupunktur, behandling, kontraindikation]
---

## Structure
Each Neuron under this path should follow the medical-Neuron template:
- Starts with a 1-sentence definition
- Mandatory "Indikationer" section
- Mandatory "Kontraindikationer" section
- Sources listed under "Referencer"
```

Compile-pipelinen (F103 step 0) finder alle `_schema.md` på path'en fra root til target, flettes i ingest-prompten:

```
1. F104 KB-wide base profile
2. /_schema.md (if exists)
3. /concepts/_schema.md (if exists)
4. /concepts/akupunktur/_schema.md (if exists)
→ Combined into effective compile-instruction for NADA.md
```

Arve-reglen: child overrider parent's felter; ikke-overriden felter arver. Jordnært: `tone:` på child overstyrer parent; `tags_canonical:` unionerer.

## How

- `packages/core/src/schema-inheritance.ts` (ny) — `resolveSchemaChain(kbId, targetPath): SchemaProfile` — walker path-segmenter, loader hver `_schema.md`, merger
- `apps/server/src/services/ingest.ts` — før prompt-building: `resolveSchemaChain(kb.id, doc.path)` → flet resultat ind som prompt-prefix efter F92 tag-block
- F102 glossary-Neurons kan have en `_schema.md` der specificerer at entries SKAL indeholde fagterm-definition + max 3 sources (stramning af step 7)
- Admin UI: path-browseren (wiki-tree) viser et lille schema-ikon på paths der har et aktiv schema + klik → quick-edit af scope-regler
- Schema-Neurons tæller ikke som "indhold" — ekskluderes fra search, graph, glossary-backfill (signatur-baseret: `type: schema`)

## Dependencies

- F104 (per-KB prompt profiles — root af schema-chain)
- F103 (9-step ingest-workflow — prompt-assembly site for inheritance)
- F101 (type-frontmatter — schemas har `type: schema`, udelukkes fra normale flows)

## Success criteria

- Sannes KB kan have 3 `_schema.md` (akupunktur / coaching / business) med forskellig tone
- Ingest af en ny akupunktur-PDF compile'es med akupunktur-schema'ens sektions-krav; coaching-PDF compile'es med coaching-tonen
- Schema-fil på `/neurons/concepts/akupunktur/` ændrer hverken search-resultater eller graph for ikke-admin queries
- En tom sub-mappe uden `_schema.md` bruger nærmeste parent's schema (inheritance virker op gennem path-træet)
