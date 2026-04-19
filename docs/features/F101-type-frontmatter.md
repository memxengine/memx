# F101 — `type:` Frontmatter Field

*Planned. Tier: alle (core-feature). Effort: 2-4 hours.*

> Hver Neuron får `type: source | concept | entity | synthesis | comparison | analysis | glossary | session` i sin YAML-frontmatter. Det matcher Balu's repo-skema, gør Obsidian Dataview-plugin brugbart på eksport, og forbereder Trail på at eksponere typen i admin-UI-filtre.

## Problem

Vores Neurons har i dag `title, tags, sources, date` i frontmatter men **ikke type**. Uden type-felt kan Obsidian's Dataview-plugin ikke filtrere Neurons per kategori i en eksport, og admin-UI kan ikke filtrere listen på "vis kun concepts". Karpathy og Balu har begge type-felt som foundational.

## Solution

`type` udledes deterministisk fra `documents.path` ved serialisering:

| Path prefix | `type:` |
|---|---|
| `/neurons/sources/` | `source` |
| `/neurons/concepts/` | `concept` |
| `/neurons/entities/` | `entity` |
| `/neurons/synthesis/` | `synthesis` |
| `/neurons/comparisons/` | `comparison` |
| `/neurons/queries/` | `analysis` |
| `/neurons/sessions/` | `session` |
| `/neurons/glossary.md` | `glossary` |
| øvrige | `note` |

## How

- Helper-funktion `deriveType(path: string): NeuronType` i `packages/shared/src/neuron-types.ts`
- Bruges i F100's eksport-serialisering + F130's `llms.txt` generering + admin-UI's neuron-reader footer
- Ingen DB-migration kræves — type er computed from path (kilde til sandhed = path)

## Dependencies

Ingen. Standalone.

## Success criteria

- Hver eksporteret Neuron har `type:` i frontmatter
- Obsidian Dataview-query `LIST FROM "" WHERE type = "concept"` returnerer alle koncept-Neurons
- Admin-UI neuron-reader viser "Type: concept" i footer
