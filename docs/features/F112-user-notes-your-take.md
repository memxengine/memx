# F112 — User Notes / "Your Take" Field (Luhmann friction)

> Tier: alle. Effort: 2-3 days. Planned.

## Problem

Trail's Neuron-reader viser kun LLM's output. Brugeren har ingen vej til at tilføje sin egen refleksion **uden at edit selve Neuron-content'et** (som så risikerer at blive overskrevet ved næste ingest/compile). Karpathy's artikel citerer Luhmann-kritikken: *"Reading someone else's summary is not the same as formulating the idea yourself."* Vi signalerer implicit at Trail erstatter brugerens tænkning — det er forkert positionering.

## Secondary Pain Points

- LLM-compileret body kan blive overskrevet ved re-ingest, hvilket sletter brugerens egne tanker hvis de blev indlejret i content
- Ingen visuel adskillelse mellem "LLM's words" og "my words" i UI
- Export (F100) smelter alt sammen — user notes forsvinder i LLM-body

## Solution

Ny kolonne på documents: `user_note TEXT`. Admin's Neuron-reader rendrer feltet som dedikeret sektion ("**Din tanke**") under LLM-body'en. Brugeren kan redigere det inline — det gemmes automatisk via dedikeret endpoint `PUT /api/v1/documents/:docId/user-note` (bypasser queue, user-note er eksplicit ikke LLM-compileret indhold). Eksport inkluderer user-note som separat markdown-sektion.

## Non-Goals

- Queue-baseret approval for user notes — de er brugerens egne ord, ingen LLM-validation nødvendig
- Rich-text editing i note-feltet — plain text / markdown kun
- Sharing / collaboration på user notes mellem brugere
- LLM-modifikation af user-note-feltet (LLM-prompten i F103 instrueres eksplicit til aldrig at modificere det)

## Technical Design

### Schema Migration

```sql
ALTER TABLE documents ADD COLUMN user_note TEXT;
```

Kolonne kan være NULL — eksisterende Neurons får ingen note.

### Endpoint

```
PUT /api/v1/documents/:docId/user-note
Authorization: Bearer <token>
Content-Type: application/json

{ "userNote": "My reflection on this topic..." }

→ 200 { documentId, updatedAt }
```

Handler bypasser queue fuldstændigt — user-note er meta-anotation, ikke wiki-content.

### Neuron Reader UI

- Dedikeret sektion under LLM-body med "Din tanke" header
- Inline redigerbar med "Skriv din egen take her…" placeholder
- Auto-save på blur eller 1s debounce
- Visuel adskillelse (blockquote eller farvet baggrund) fra LLM-body

### Export Integration (F100)

```markdown
<!-- auto-generated LLM body above -->

---

## Din tanke

{user_note content — fremhævet med blockquote eller andet visuelt anker}
```

## Interface

```typescript
// PUT /api/v1/documents/:docId/user-note
interface UpdateUserNoteRequest {
  userNote: string; // max 4000 chars
}

interface UpdateUserNoteResponse {
  documentId: string;
  updatedAt: string; // ISO timestamp
}
```

## Rollout

**Single-phase deploy.** Migration er additive (ALTER TABLE med NULL default). Ingen breaking changes. Deploy migration → endpoint → UI update i samme PR.

## Success Criteria

- Brugeren kan tilføje / redigere note uden at trigge queue (<200ms response)
- Noten bevares på tværs af re-ingest og compile-runs (verificeret ved: ingest → note persists → re-ingest → note unchanged)
- Eksport (F100) inkluderer noter som separat markdown-sektion
- Settings tooltip/help viser: "Luhmann-pattern: write in your own words to understand"

## Impact Analysis

### Files created (new)
- `apps/server/src/routes/documents-user-note.ts`
- `apps/server/src/services/user-note.ts`

### Files modified
- `packages/db/src/schema.ts` (add `user_note` column to documents schema)
- `apps/server/src/app.ts` (mount user-note route)
- `apps/server/src/routes/documents.ts` (export note in document detail response)
- `packages/db/src/migrate.ts` (migration entry)

### Downstream dependents
`packages/db/src/schema.ts` is imported by 1 file:
- `packages/core/src/kb/resolve.ts` (1 ref) — reads document schema, unaffected by additive column

`apps/server/src/app.ts` is imported by 1 file:
- `apps/server/src/index.ts` (1 ref) — creates app via `createApp(trail)`, unaffected by additive route

`apps/server/src/routes/documents.ts` is imported by 1 file:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected

`packages/db/src/migrate.ts` is imported by 1 file:
- `apps/server/src/index.ts` (1 ref) — calls `trail.runMigrations()`, unaffected

### Blast radius

- Additive column — zero risk to existing queries (SELECT * not used, explicit column lists)
- New endpoint is isolated — no shared handler logic with existing document routes
- Export format change: F100 export adds a section; consumers parsing export markdown must handle optional "## Din tanke" section

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Migration adds `user_note` column to documents table (nullable)
- [ ] `PUT /documents/:docId/user-note` with valid payload → 200, column updated
- [ ] `PUT /documents/:docId/user-note` with empty string → clears note
- [ ] Re-ingest of same source does NOT overwrite user_note
- [ ] Export includes "## Din tanke" section when user_note is present
- [ ] Export omits "## Din tanke" section when user_note is null
- [ ] Regression: existing document CRUD operations unaffected
- [ ] Regression: ingest pipeline still works end-to-end

## Implementation Steps

1. Add `user_note TEXT` column migration to `packages/db/src/migrate.ts`.
2. Create `apps/server/src/services/user-note.ts` with `updateUserNote(db, docId, note)` function.
3. Create `apps/server/src/routes/documents-user-note.ts` with `PUT /documents/:docId/user-note` handler.
4. Mount route in `apps/server/src/app.ts`.
5. Update Neuron reader UI to render editable "Din tanke" section below LLM body.
6. Update F100 export to include user_note as separate markdown section.
7. Add tooltip/help text in Settings: "Luhmann-pattern: write in your own words to understand".

## Dependencies

None — standalone feature.

## Open Questions

None — all decisions made.

## Related Features

- **F100** (Export) — export includes user_note as separate section
- **F103** (Compile prompt) — LLM instructed to never modify user_note field
- **F115** (Idea File Gist) — can exemplify: "LLM's job: compile. Your job: think."

## Effort Estimate

**Small** — 2-3 days.
- Day 1: Migration + endpoint + service
- Day 2: UI integration + export update
- Day 3: Testing + polish
