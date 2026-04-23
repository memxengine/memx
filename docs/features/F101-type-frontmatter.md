# F101 — `type:` Frontmatter Field

> Hver Neuron får `type: source | concept | entity | synthesis | comparison | analysis | glossary | session` i sin YAML-frontmatter. Det matcher Balu's repo-skema, gør Obsidian Dataview-plugin brugbart på eksport, og forbereder Trail på at eksponere typen i admin-UI-filtre. Tier: alle (core-feature). Effort: Small (2-4 hours). Status: Planned.

## Problem

Vores Neurons har i dag `title, tags, sources, date` i frontmatter men **ikke type**. Uden type-felt kan Obsidian's Dataview-plugin ikke filtrere Neurons per kategori i en eksport, og admin-UI kan ikke filtrere listen på "vis kun concepts". Karpathy og Balu har begge type-felt som foundational.

## Secondary Pain Points

- Graph-view in Obsidian can't color-code Neurons by type without a type field.
- Admin UI can't group or filter Neurons by semantic category.
- `llms.txt` generation (F130) can't structure output by Neuron type.

## Solution

`type` is derived deterministically from `documents.path` at serialization time — no DB migration needed. A helper function `deriveType(path: string): NeuronType` maps path prefixes to type values:

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

## Non-Goals

- Adding a `type` column to the `documents` table (type is computed from path, source of truth = path).
- Allowing users to manually set or override the type (type is derived, not user-editable).
- Migrating existing Neurons to new path conventions (existing paths already match the mapping).
- Supporting custom user-defined types (only the predefined set is valid).

## Technical Design

### Type derivation helper

```ts
// packages/shared/src/neuron-types.ts
export type NeuronType =
  | 'source'
  | 'concept'
  | 'entity'
  | 'synthesis'
  | 'comparison'
  | 'analysis'
  | 'glossary'
  | 'session'
  | 'note';

export function deriveType(path: string): NeuronType {
  if (path.startsWith('/neurons/sources/')) return 'source';
  if (path.startsWith('/neurons/concepts/')) return 'concept';
  if (path.startsWith('/neurons/entities/')) return 'entity';
  if (path.startsWith('/neurons/synthesis/')) return 'synthesis';
  if (path.startsWith('/neurons/comparisons/')) return 'comparison';
  if (path.startsWith('/neurons/queries/')) return 'analysis';
  if (path.startsWith('/neurons/sessions/')) return 'session';
  if (path === '/neurons/glossary.md') return 'glossary';
  return 'note';
}
```

### Usage in serialization

The `deriveType()` function is called wherever a Neuron is serialized to markdown (F100 export, F130 llms.txt, admin neuron-reader footer):

```ts
const type = deriveType(doc.path);
const frontmatter = `---
title: ${doc.title}
type: ${type}
tags: [${doc.tags.join(', ')}]
sources: [${doc.sources.join(', ')}]
date: ${doc.date}
---`;
```

## Interface

### Shared export

```ts
// packages/shared/src/neuron-types.ts
export type NeuronType = ...;
export function deriveType(path: string): NeuronType;
```

No API endpoints, no DB changes. Internal utility only.

## Rollout

**Single-phase deploy.** No migration needed — type is computed from existing path data. All existing Neurons immediately get correct types on next serialization.

## Success Criteria

- Every exported Neuron has `type:` in frontmatter.
- Obsidian Dataview-query `LIST FROM "" WHERE type = "concept"` returns all concept-Neurons.
- Admin-UI neuron-reader shows "Type: concept" in footer.
- `deriveType()` correctly maps all 9 path prefixes to their expected types.

## Impact Analysis

### Files created (new)

- `packages/shared/src/neuron-types.ts`

### Files modified

- `apps/server/src/routes/export.ts` (F100 — include `type:` in exported frontmatter)
- `apps/admin/src/components/neuron-reader.tsx` (show type in footer)
- `apps/server/src/services/llms.ts` (F130 — use type in llms.txt generation)

### Downstream dependents

`packages/shared/src/neuron-types.ts` — New file; no existing dependents yet. Will be imported by export route, admin reader, and llms service.

`apps/server/src/routes/export.ts` — New file (F100); no existing dependents yet.

`apps/admin/src/components/neuron-reader.tsx` — Admin UI component. Adding type display in footer is additive; no downstream changes.

`apps/server/src/services/llms.ts` — New file (F130); no existing dependents yet.

### Blast radius

- All changes are additive (new helper, new frontmatter field, new UI display).
- `deriveType()` is a pure function with no side effects — safe to call anywhere.
- Existing Neurons with paths that don't match any prefix get `type: note` — acceptable fallback.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `deriveType()` correctly maps all 9 path prefixes to expected types
- [ ] Unit: `deriveType()` returns 'note' for unrecognized paths
- [ ] Integration: exported Neuron includes `type:` in frontmatter
- [ ] Manual: Obsidian Dataview-query `LIST FROM "" WHERE type = "concept"` returns all concept-Neurons
- [ ] Manual: admin neuron-reader footer shows "Type: concept"
- [ ] Regression: existing Neuron serialization (without type) still works for backward compat

## Implementation Steps

1. Create `packages/shared/src/neuron-types.ts` with `NeuronType` union and `deriveType()` helper.
2. Update F100 export route to include `type:` in serialized frontmatter.
3. Update admin neuron-reader component to display type in footer.
4. Update F130 llms.txt generation to use type for structuring output.
5. Test: verify `deriveType()` against all path prefixes, verify exported frontmatter, verify admin UI display.

## Dependencies

None. Standalone.

## Open Questions

None — all decisions made.

## Related Features

- **F100** (Obsidian Vault Export) — uses `type:` for Dataview compatibility
- **F102** (Auto-maintained Glossary) — glossary Neuron gets `type: glossary`
- **F109** (Synthesis Neuron Type) — synthesis Neurons get `type: synthesis`
- **F110** (Comparison Neuron Type) — comparison Neurons get `type: comparison`
- **F130** (llms.txt generation) — uses type for structuring output

## Effort Estimate

**Small** — 2-4 hours.

- Helper function + types: 30 min
- Export route update: 30 min
- Admin UI footer update: 30 min
- llms.txt update: 30 min
- Testing: 30 min
