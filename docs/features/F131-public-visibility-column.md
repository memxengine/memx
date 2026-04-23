# F131 — documents.public_visibility Column

> Ny kolonne `documents.public_visibility` ENUM('public','internal','hidden') der styrer om Neurons inkluderes i F130 llms.txt-output + fremtidig connector-API-eksposition. Selv om Trail ikke leverer public UI-visninger, er filteret stadig nødvendigt — nogle Neurons skal ikke engang være i llms-full.txt der kunne pipe ind i LLM-agenter. Tier: alle. Effort: 0.5 day.

## Problem

Nogle Neurons indeholder intern info (kunde-navne, hemmelige interne processer, draft-content) der ikke skal eksponeres — selv ikke via authenticated llms.txt. I dag har vi ingen måde at markere en Neuron som "indekseret men ikke eksponeret".

## Secondary Pain Points

- Ingen visuel indikator i admin for hvilke Neurons der er sensitive
- Kurator kan ikke midlertidigt "skjule" en Neuron mens den er under revision
- Fremtidige public-APIs har ingen granularitetskontrol

## Solution

```sql
ALTER TABLE documents ADD COLUMN public_visibility TEXT
  CHECK (public_visibility IN ('public', 'internal', 'hidden'))
  NOT NULL DEFAULT 'internal';
```

Semantik:
- `public` — inkluderes overalt (admin-UI, llms.txt, fremtidig public-API hvis den kommer)
- `internal` (default) — kun for authenticated members af tenant'en (admin, chat, llms.txt for auth'ed consumers)
- `hidden` — skjules også for ikke-owner-members (draft, arkiveret-pending, personlige notes)

F130 llms.txt inkluderer KUN `public` og `internal`. Nogle fremtidige public-features kunne kun vise `public`. Ingen nu-public-endpoint — kolonnen er forbered-til-fremtiden.

Kurator-UI i Neuron-editor får en "Synlighed"-dropdown.

## Non-Goals

- Public read-endpoint — kolonnen er forberedelse, ikke implementation
- RBAC per-Neuron — visibility er tre-niveau, ikke per-user
- Auto-skjul baseret på indhold — manuel kurator-kontrol

## Technical Design

### Migration

```sql
ALTER TABLE documents ADD COLUMN public_visibility TEXT
  CHECK (public_visibility IN ('public', 'internal', 'hidden'))
  NOT NULL DEFAULT 'internal';
```

### Schema update

```typescript
// packages/db/src/schema.ts
export const documents = sqliteTable('documents', {
  // ... existing columns
  publicVisibility: text('public_visibility', { enum: ['public', 'internal', 'hidden'] })
    .notNull()
    .default('internal'),
});
```

### Admin UI

Neuron-editor sidebar tilføjer dropdown:

```typescript
// apps/admin/src/components/neuron-editor.tsx
<select value={neuron.publicVisibility} onChange={(e) => updateVisibility(e.target.value)}>
  <option value="public">Public — visible everywhere</option>
  <option value="internal">Internal — authenticated members only</option>
  <option value="hidden">Hidden — owner only</option>
</select>
```

Wiki-tree viser ikon for non-default visibility (🔒 for hidden, 👁 for public).

### Query filter

F130 llms.txt og andre consumers filtrerer:

```typescript
const visibleDocs = db.select().from(documents)
  .where(ne(documents.publicVisibility, 'hidden'));
```

## Interface

### DB Column

| Column | Type | Default | Description |
|---|---|---|---|
| `public_visibility` | TEXT ENUM | `'internal'` | Visibility level |

### Admin UI

- Dropdown i Neuron-editor sidebar: Public / Internal / Hidden
- Wiki-tree ikon: 🔒 (hidden), 👁 (public), ingen ikon (internal/default)

### API

- `PATCH /api/v1/documents/:id` accepterer `publicVisibility` field
- GET endpoints filtrerer automatisk baseret på caller's role

## Rollout

**Single-phase deploy med backfill:**
1. Migration tilføjer kolonne med default='internal' for alle eksisterende rows
2. Admin UI opdateres med visibility-dropdown
3. F130 llms.txt query filtrerer på `public_visibility != 'hidden'`

## Success Criteria

- Kurator kan markere Neuron som 'hidden' → forsvinder fra llms.txt output
- Default for alle eksisterende Neurons er 'internal' (backwards-compatible)
- Admin Wiki-tree har visuel indikator (ikon) for non-default visibility

## Impact Analysis

### Files created (new)
None — migration only.

### Files modified
- `packages/db/src/schema.ts` — add `publicVisibility` column
- `apps/admin/src/components/neuron-editor.tsx` — visibility dropdown
- `apps/admin/src/components/wiki-tree.tsx` — visibility icons
- `apps/server/src/routes/llms-txt.ts` (F130) — visibility filter
- `apps/server/src/routes/documents.ts` — PATCH accepts publicVisibility

### Downstream dependents
`packages/db/src/schema.ts` is imported by 4 files:
- `packages/db/src/interface.ts` (1 ref) — uses schema for Drizzle interface, unaffected
- `packages/db/src/index.ts` (1 ref) — exports schema, unaffected
- `packages/db/src/libsql-adapter.ts` (1 ref) — uses schema for queries, unaffected
- Multiple server routes (many refs) — all additive, no breaking changes

`apps/admin/src/components/neuron-editor.tsx` — imported by admin panel components. Adding dropdown is additive.

`apps/admin/src/components/wiki-tree.tsx` — imported by admin panels. Adding icon is additive.

### Blast radius

Low. Additive column med default-værdi. Ingen eksisterende queries brydes — de får bare 'internal' som default.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Migration kører uden fejl på eksisterende DB
- [ ] Eksisterende Neurons får `public_visibility = 'internal'`
- [ ] Kurator kan ændre visibility til 'hidden' via editor
- [ ] Hidden Neuron forsvinder fra llms.txt output
- [ ] Wiki-tree viser 🔒 ikon for hidden Neurons
- [ ] Regression: search, chat, graph fungerer uændret med nye rows

## Implementation Steps

1. Skriv migration: `ALTER TABLE documents ADD COLUMN public_visibility`.
2. Opdater `packages/db/src/schema.ts` med `publicVisibility` kolonne.
3. Tilføj visibility-dropdown i Neuron-editor.
4. Tilføj visibility-ikoner i wiki-tree.
5. Opdater F130 llms.txt route med visibility-filter.
6. Opdater documents PATCH route til at acceptere `publicVisibility`.

## Dependencies

- F130 (primær consumer — llms.txt filtrering)

## Open Questions

None — all decisions made.

## Related Features

- **F130** — llms.txt endpoints (primær consumer af visibility-filter)
- **F101** — Type frontmatter (visibility kan combine med type)
- **F140** — Hierarchical context inheritance (schema-filer har egen visibility)

## Effort Estimate

**Small** — 0.5 day.
- 0.15 day: migration + schema update
- 0.2 day: admin UI (dropdown + icons)
- 0.15 day: F130 integration + testing
