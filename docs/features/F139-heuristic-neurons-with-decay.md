# F139 — Heuristic Neurons with Temporal Decay

> En ny Neuron-type `type: heuristic` der fanger MENTALE MODELLER og DECISION-RULES frem for faktuelle koncepter ("tjek altid contradictions efter hver ingest", "frem-fokus på input, ikke output", "Luhmann: skriv i første person"). I modsætning til faktuelle concepts har heuristic-Neuroner en confidence-decay baseret på last-touched date — pinned/core heuristics persister, fleeting fade. Trail lærer hvad der RENT FAKTISK bruges vs. hvad der var en engangs-tanke. Tier: alle. Effort: 1 day. Status: Planned.

## Problem

Faktuelle concept-Neuroner har en implicit varighed: de beskriver verden som den er, og ændres kun når nye Kilder ankommer. Heuristikker — hvordan du tænker, hvornår du gør hvad — er mere volatile. Nogle er bærende søjler i ens praksis (Luhmann's Zettelkasten-regler); andre er flygtige "dette prøver jeg i en måned"-eksperimenter.

Hvis alle heuristikker bare bliver concept-Neuroner, akkumulerer KB'en et lag af historiske tankegange der aldrig blev noget — men som forurener chat-svar, search-results og graphen i al evighed. Thinking-MCP's "node decay"-model adresserer det: core-values persister, fleeting ideas fade.

Praktisk eksempel: Christian's udviklings-heuristikker over 3 år vs. "denne uge prøver jeg TDD on everything"-flueben-tanker. Begge er værdifulde i øjeblikket, men de skal behandles forskelligt over tid.

## Secondary Pain Points

- Chat context selection vægter gamle heuristikker lige så højt som nye
- Graph-visualiseringen har ingen måde at vise hvilke heuristikker der er "aktive" vs. "faded"
- Ingen lint-signal for heuristikker der ikke er blevet bekræftet i lang tid

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

## Non-Goals

- Auto-pin heuristikker baseret på usage — pinning er eksplicit bruger-handling
- Erstatte concept-Neuroner — heuristikker er en supplerende type, ikke en erstatning
- Implementere custom decay curves — fast 5-trin model, ikke bruger-konfigurerbar

## Technical Design

### Confidence Calculator

```typescript
// packages/core/src/heuristic-confidence.ts
export function computeConfidence(lastTouched: Date, pinned: boolean): number {
  if (pinned) return 1.0;
  const ageDays = (Date.now() - lastTouched.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 30) return 1.0;
  if (ageDays < 90) return 0.8;
  if (ageDays < 180) return 0.5;
  if (ageDays < 365) return 0.3;
  return 0.1;
}
```

### Chat Context Filter

```typescript
// In chat context building
if (candidate.type === 'heuristic') {
  const confidence = computeConfidence(candidate.lastTouched, candidate.pinned);
  if (confidence < 0.3 && !explicitlyTagged) return false; // skip
  // Apply weight: final_score *= (0.5 + 0.5 * confidence)
}
```

### Lint Detector

```typescript
// In F32 lint-scheduler
export function detectFadedHeuristics(kbId: string): Finding[] {
  // SQL query: heuristic type, confidence < 0.3, last_touched > 60 days ago
}
```

## Interface

### Heuristic Frontmatter

```yaml
---
title: "..."
type: heuristic
pinned: boolean
last_touched: ISO date
tags: string[]
---
```

### Admin Editor

Sidebar viser computed confidence med mulighed for at:
- Pin heuristicen (confidence = 1.0 permanent)
- Refresh last_touched (manuelt bekræft)

### Graph API

Returnerer `confidence` for heuristic-noder; frontend renders med `opacity: confidence`.

## Rollout

**Single-phase deploy.** Ny type i F101 enum + confidence calculator + chat filter. Eksisterende Neuroner unaffected.

## Success Criteria

- Kurator kan oprette en Neuron med `type: heuristic` via editor; frontmatter gemmes korrekt
- 90-dage-gammel heuristic uden pins viser confidence≈0.5 i UI
- Chat ekskluderer <0.3-confidence heuristikker fra context automatisk
- F99 graph viser fadede heuristikker med reduceret opacity
- Lint-pass flagger heuristikker der er stagnerede over en cutoff

## Impact Analysis

### Files created (new)
- `packages/core/src/heuristic-confidence.ts`

### Files modified
- `packages/shared/src/types.ts` (add 'heuristic' to type enum)
- `apps/server/src/services/chat.ts` (filter low-confidence heuristics)
- `apps/server/src/routes/graph.ts` (return confidence for heuristic nodes)
- `apps/admin/src/components/neuron-editor.tsx` (show confidence in sidebar, pin button)
- `apps/admin/src/components/graph.tsx` (render heuristic nodes with opacity)
- `apps/server/src/services/lint-detectors.ts` (add detectFadedHeuristics)

### Downstream dependents
`packages/core/src/heuristic-confidence.ts` — New file, no dependents yet.

`packages/shared/src/types.ts` is imported by 15+ files across the codebase. Adding 'heuristic' to the type enum is additive.

`apps/server/src/services/chat.ts` is imported by 3 files:
- `apps/server/src/routes/chat.ts` (1 ref) — mounts chat endpoint, unaffected
- `apps/server/src/services/llm-context.ts` (1 ref) — builds context, needs heuristic filter
- `apps/server/src/app.ts` (1 ref) — imports services, unaffected

### Blast radius
- Low — ny type er additive, eksisterende typer unaffected
- Chat context filter kan reducere context størrelse for KBs med mange heuristikker — monitor
- Edge case: heuristik med last_touched i fremtiden (clock skew) → confidence = 1.0 (safe)

### Breaking changes
None — all changes are additive.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] `computeConfidence(30 days ago, false)` → 1.0
- [ ] `computeConfidence(100 days ago, false)` → 0.8
- [ ] `computeConfidence(200 days ago, false)` → 0.5
- [ ] `computeConfidence(400 days ago, false)` → 0.1
- [ ] `computeConfidence(any, true)` → 1.0
- [ ] Chat ekskluderer <0.3 confidence heuristikker
- [ ] F99 graph renderer heuristik med opacity = confidence
- [ ] Lint detector finder fadede heuristikker
- [ ] Regression: eksisterende concept-Neuroner virker uændret

## Implementation Steps
1. Tilføj 'heuristic' til type enum i F101
2. Implementér `heuristic-confidence.ts` med computeConfidence function
3. Opdater chat context building til at filtrere lav-confidence heuristikker
4. Opdater graph API til at returnere confidence for heuristic-noder
5. Opdater graph.tsx rendering med opacity baseret på confidence
6. Tilføj detectFadedHeuristics til lint-scheduler (F32)
7. Opdater Neuron-editor med confidence display + pin button
8. Typecheck + test plan

## Dependencies
- F101 (type-frontmatter — heuristic registreres som ny type)
- F32 (lint-scheduler — ny detector plugges ind her)

## Open Questions
None — all decisions made.

## Related Features
- **F101** (Type frontmatter) — heuristic er en ny type i enum
- **F32** (Lint scheduler) — detectFadedHeuristics detector
- **F89** (Chat tools) — chat context selection bruger confidence
- **F99** (Neuron graph) — heuristic nodes render med opacity
- **F141** (Neuron access telemetry) — last_touched = max(last_edited, last_read) udvidelse

## Effort Estimate
**Small** — 1 day
- 0.2 day: type enum + confidence calculator
- 0.2 day: chat context filter
- 0.2 day: graph API + rendering
- 0.2 day: lint detector
- 0.2 day: editor UI + testing
