# F109 — Synthesis Neuron Type

> Tier: all. Effort: Small (1 day). Status: Planned.
> New `/neurons/synthesis/` hierarchy with proactively-generated synthesis pages — cross-cutting thematic linking of multiple sources. Clarifies the value-add that Karpathy's gist explicitly mentions as distinct from concept pages.

## Problem

Our current ingest prompt produces source-summaries, concept-pages, and entity-pages. We have **no** explicit category for "ties multiple sources together around a theme" — Karpathy's synthesis page. Such pages may arise implicitly as concept-pages, but without clear intent or prompt guidance to CREATE them.

## Secondary Pain Points

- No dedicated wiki-tree branch for synthesis pages.
- Graph view doesn't show synthesis pages as hubs with many incoming links.
- Users can't browse "what themes emerge from my KB" as a distinct view.

## Solution

The ingest prompt (via F104 per-KB profile) adds a step:

> "After step 5 (entity pages): reflect on whether this new source creates a **theme** that spans across 3+ existing Neurons. If yes, create or update a synthesis page in `/neurons/synthesis/<theme>.md` that:
> - Identifies the theme in one sentence
> - Lists the contributing Neurons via `[[wiki-links]]`
> - Summarizes what the cross-section reveals (contradictions, common patterns, temporal development)
> - Has `type: synthesis` in frontmatter"

## Non-Goals

- Auto-generating synthesis pages without LLM involvement (LLM decides if a theme exists).
- Synthesis pages for themes with fewer than 3 contributing Neurons.
- Manual synthesis page creation UI (curator can create via Neuron editor, but the focus is LLM-generated).
- Synthesis-specific lint rules (handled by general lint).

## Technical Design

### Path convention

`/neurons/synthesis/<slug>.md`

### F101 deriveType

Path prefix `/neurons/synthesis/` → `type: synthesis`

### Ingest prompt addition

Added as an optional step (not mandatory — LLM can assess there are none) to the ingest prompt in `apps/server/src/services/ingest.ts` (or profile-specific templates in F104).

### F113 auto-fix-lint

Can suggest synthesis candidates when orphan-lint finds 3+ concepts that are often cited together.

## Interface

Internal only — no new API endpoints. Synthesis pages are regular Neurons created via the existing ingest pipeline.

## Rollout

**Single-phase deploy.** Prompt change only. Existing KBs get synthesis pages on next ingest. No migration needed.

## Success Criteria

- Ingest of a source that relates to 3+ existing concepts produces (or updates) a synthesis page.
- Synthesis pages are browsable in the wiki-tree under a dedicated `/neurons/synthesis/` branch.
- Obsidian export (F100) places them in `wiki/synthesis/` subfolder.
- Graph view in Obsidian shows synthesis pages as hubs with many incoming links.

## Impact Analysis

### Files created (new)

None.

### Files modified

- `apps/server/src/services/ingest.ts` (add synthesis evaluation step to prompt)
- `apps/server/src/services/ingest-profiles/researcher.md` (F104 — include synthesis prompt)
- `packages/shared/src/neuron-types.ts` (F101 — add 'synthesis' to NeuronType union)

### Downstream dependents

`apps/server/src/services/ingest.ts` is imported by 5 files:
- `apps/server/src/routes/uploads.ts` (1 ref) — triggers ingest, prompt change is internal
- `apps/server/src/routes/knowledge-bases.ts` (1 ref) — re-ingest, prompt change is internal
- `apps/server/src/mcp/tools/ingest.ts` (1 ref) — MCP tool, prompt change is internal
- `apps/server/src/services/ingest-profiles.ts` (1 ref) — profile loading, may need synthesis prompt
- `apps/server/test/ingest.test.ts` (1 ref) — test file, may need synthesis fixture

`packages/shared/src/neuron-types.ts` — New file (F101). Adding 'synthesis' to the union is additive.

### Blast radius

- Synthesis page creation adds extra LLM work per ingest — may increase token usage slightly.
- If the LLM creates synthesis pages too eagerly, the wiki-tree may fill with low-value synthesis pages. Prompt guidance on the 3+ Neuron threshold is important.
- Edge case: if a synthesis page with the same slug already exists, the LLM should update it rather than create a duplicate.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: ingest prompt includes synthesis evaluation step
- [ ] Integration: ingest a source relating to 3+ concepts → synthesis page created
- [ ] Integration: ingest a source with no thematic connection → no synthesis page created
- [ ] Manual: wiki-tree shows `/neurons/synthesis/` branch with synthesis pages
- [ ] Manual: F100 export places synthesis pages in `wiki/synthesis/`
- [ ] Regression: existing ingest flow completes without errors
- [ ] Regression: F101 type-frontmatter shows `type: synthesis` for synthesis pages

## Implementation Steps

1. **Prompt addition** — add synthesis evaluation step to ingest prompt in `apps/server/src/services/ingest.ts` or F104 profile templates.
2. **Type registration** — ensure 'synthesis' is in the NeuronType union (F101).
3. **Test** — ingest a source that relates to 3+ concepts, verify synthesis page is created.
4. **Verify** — check wiki-tree shows synthesis branch, export places in correct subfolder.

## Dependencies

- F101 (type-frontmatter)
- F104 (prompt profiles — synthesis prompt in researcher.md)

## Open Questions

1. **Synthesis page slug generation.** How does the LLM decide the slug? Theme name? First concept name? Prompt guidance needed.
2. **Update vs create.** When should the LLM update an existing synthesis page vs. create a new one? Leaning: update if theme matches existing page within 80% similarity.
3. **Synthesis page size limits.** A very active KB could produce a 5000-word synthesis page. Should there be a cap? Not for MVP.

## Related Features

- **F101** (type-frontmatter) — synthesis type
- **F104** (Per-KB Prompt Profiles) — synthesis prompt in researcher profile
- **F110** (Comparison Neuron Type) — related but distinct (comparison is side-by-side, synthesis is thematic)
- **F113** (Auto-fix lint findings) — can suggest synthesis candidates

## Effort Estimate

**Small** — 1 day.

- Prompt addition: 30 min
- Type registration: 15 min
- Testing: 2 hours
- Verification: 1 hour
