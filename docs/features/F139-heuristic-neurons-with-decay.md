# F139 — Heuristic Neurons with Temporal Decay

*Planned. Tier: alle. Effort: 1 day.*

> En ny Neuron-type `type: heuristic` der fanger MENTALE MODELLER og DECISION-RULES frem for faktuelle koncepter ("tjek altid contradictions efter hver ingest", "frem-fokus på input, ikke output", "Luhmann: skriv i første person"). I modsætning til faktuelle concepts har heuristic-Neuroner en confidence-decay baseret på last-touched date — pinned/core heuristics persister, fleeting fade. Trail lærer hvad der RENT FAKTISK bruges vs. hvad der var en engangs-tanke.

## Problem

Faktuelle concept-Neuroner har en implicit varighed: de beskriver verden som den er, og ændres kun når nye Kilder ankommer. Heuristikker — hvordan du tænker, hvornår du gør hvad — er mere volatile. Nogle er bærende søjler i ens praksis (Luhmann's Zettelkasten-regler); andre er flygtige "dette prøver jeg i en måned"-eksperimenter.

Hvis alle heuristikker bare bliver concept-Neuroner, akkumulerer KB'en et lag af historiske tankegange der aldrig blev noget — men som forurener chat-svar, search-results og graphen i al evighed. Thinking-MCP's "node decay"-model adresserer det: core-values persister, fleeting ideas fade.

Praktisk eksempel: Christian's udviklings-heuristikker over 3 år vs. "denne uge prøver jeg TDD on everything"-flueben-tanker. Begge er værdifulde i øjeblikket, men de skal behandles forskelligt over tid.

## Solution

Tilføj `type: heuristic` som første-klasses Neuron-type (del af F101's type-enum). Frontmatter:

```yaml
---
title: "Always clarify before coding"
type: heuristic
pinned: false       # optional; true = ingen decay
confidence: 1.0     # computed; starts 1.0, decays over time
last_touched: 2026-04-20
tags: [workflow, coding]
---
```

Confidence-decay model (computed, ikke stored — afledes fra last_touched):

```
age_days = days_since(last_touched)
if pinned: confidence = 1.0
else if age_days < 30: confidence = 1.0
else if age_days < 90: confidence = 0.8
else if age_days < 180: confidence = 0.5
else if age_days < 365: confidence = 0.3
else: confidence = 0.1
```

Confidence-tallet bruges til:
- **Chat context selection** — lav-confidence heuristikker vægtes lavere i relevant-Neuron-udvælgelse; under 0.3 ekskluderes helt medmindre eksplicit tagget
- **F99 graph** — heuristic-noder render mindre / mere transparent jo lavere confidence (visuelt decay)
- **Lint signal** — heuristikker med confidence <0.3 i 60 dage flagges som "overvej at arkivere eller genbekræfte" (ny finding kind `heuristic-faded`)

last_touched nulstilles når:
- Bruger redigerer Neuronen via editor
- Bruger nævner Neuronen i chat (F89 chat-tools — "brug denne heuristic som input til svaret")
- Bruger eksplicit markerer `pinned: true` (opgraderer til permanent core-heuristic)

## How

- F101 udvides med `heuristic` i type-enum (hvis ikke allerede)
- `packages/core/src/heuristic-confidence.ts` (ny) — pure function `computeConfidence(lastTouched, pinned): number`
- Chat endpoint (F89) filter-integration: `candidate.type === 'heuristic' && confidence < 0.3` → skip i context-building
- F99 graph API returnerer `confidence` for heuristic-noder; frontend renders med `opacity: confidence`
- Lint-scheduler (F32) får ny detector `detectFadedHeuristics()` — ren SQL-query, ingen LLM-kald
- Admin-editor viser computed confidence i sidebar så kurator kan pin eller refresh en heuristic

## Dependencies

- F101 (type-frontmatter — heuristic registreres som ny type)
- F32 (lint-scheduler — ny detector plugges ind her)

## Success criteria

- Kurator kan oprette en Neuron med `type: heuristic` via editor; frontmatter gemmes korrekt
- 90-dage-gammel heuristic uden pins viser confidence≈0.5 i UI
- Chat ekskluderer <0.3-confidence heuristikker fra context automatisk
- F99 graph viser fadede heuristikker med reduceret opacity
- Lint-pass flagger heuristikker der er stagnerede over en cutoff
