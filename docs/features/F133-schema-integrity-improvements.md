# F133 — Schema Integrity Improvements

> Tilføj manglende indexes + constraints fra trail-optimizer-audit: uniqueIndex på `(knowledgeBaseId, path, filename)`, index på `documents.updatedAt`, CHECK constraint mod self-links i `wikiBacklinks`. Rent hygiejne-fix — ingen ny funktionalitet, færre edge-case-bugs. Tier: infrastruktur. Effort: 0.5 day. Status: Planned.

## Problem

Trail-optimizer-audit identificerede flere schema-niveau gaps (KARPATHY-ALIGNMENT.md + round 2 findings til trail):

1. **Ingen uniqueIndex på (kbId, path, filename)** — to concurrent candidate-approvals kan skabe dublet-Neurons med identisk sti. Sjældent men muligt.
2. **Ingen index på `documents.updatedAt`** — F118 sampling-scheduler + F1's stale-pushdown benefits fra indekseret range-query.
3. **Ingen CHECK constraint på `wikiBacklinks`** — `from_document_id` kan være lig `to_document_id`; backlink-extractor har app-level guard, men DB accepterer stadig self-links.

## Secondary Pain Points

- Ingen index på `documents.updatedAt` gør stale-detector queries langsommere ved store KBs
- Dublet-Neurons kræver manuel cleanup via admin UI
- Self-links i backlink-graphen forurener F99 graph-visualiseringen

## Solution

Migration tilføjer tre ting:

```sql
-- 1. Unique filename per path per KB
CREATE UNIQUE INDEX idx_docs_kb_path_filename
  ON documents(knowledge_base_id, path, filename)
  WHERE archived = false;

-- 2. Index for stale-detector pushdown
CREATE INDEX idx_docs_updated_at ON documents(knowledge_base_id, kind, updated_at)
  WHERE archived = false;

-- 3. Self-link prevention (wikiBacklinks)
-- SQLite tillader ikke ALTER TABLE ADD CONSTRAINT — skal omgøres via
-- rename + recreate hvis backwards-compat kræves. Alternativ:
-- trigger-baseret check.
CREATE TRIGGER IF NOT EXISTS trg_no_self_backlink
  BEFORE INSERT ON wiki_backlinks
  FOR EACH ROW
  WHEN NEW.from_document_id = NEW.to_document_id
  BEGIN
    SELECT RAISE(ABORT, 'self-link not allowed');
  END;
```

## Non-Goals

- Refactorere hele schemaet — kun de tre specifikke gaps fra audit
- Tilføje flere indexes end nødvendigt — hvert index har en skrive-omkostning
- Ændre på app-level guards (backlink-extractor har allerede sin egen validation)

## Technical Design

### Migration

```sql
-- packages/db/drizzle/migrations/
-- 1. Unique index
CREATE UNIQUE INDEX idx_docs_kb_path_filename
  ON documents(knowledge_base_id, path, filename)
  WHERE archived = false;

-- 2. UpdatedAt index
CREATE INDEX idx_docs_updated_at ON documents(knowledge_base_id, kind, updated_at)
  WHERE archived = false;

-- 3. Self-link trigger
CREATE TRIGGER IF NOT EXISTS trg_no_self_backlink
  BEFORE INSERT ON wiki_backlinks
  FOR EACH ROW
  WHEN NEW.from_document_id = NEW.to_document_id
  BEGIN
    SELECT RAISE(ABORT, 'self-link not allowed');
  END;
```

### Conflict Handling

Unique-index-tilføjelse afviser INSERT på dublet → candidate-approve må håndtere konstraint-fejl med retry + conflict-resolution:

```typescript
// In approve handler
try {
  await tx.insert(documents).values(...);
} catch (err) {
  if (isUniqueConstraintViolation(err)) {
    // Existing document at this path — update instead
    await tx.update(documents).set(...).where(...);
  }
}
```

## Interface

### Internal only — no public interface

Indexes og triggers er interne DB-implementationsdetaljer. Ingen API changes.

## Rollout

**Single-phase deploy.** Migration kører ved server-start. Eksisterende data skal verificeres for dubletter før unique-index tilføjes (kan kræve cleanup-script).

## Success Criteria

- `EXPLAIN QUERY PLAN SELECT ... WHERE updatedAt < ?` viser `USING INDEX idx_docs_updated_at`
- Forsøg på at oprette wiki-backlink til sig selv fejler med trigger-error
- Concurrent approves af samme filename-to-path candidate → anden approve får constraint-error (eller graceful retry-logic i approve-path)

## Impact Analysis

### Files created (new)
- Migration fil i `packages/db/drizzle/migrations/`
- `apps/server/src/scripts/cleanup-duplicate-documents.ts` (pre-migration cleanup script)

### Files modified
- `apps/server/src/queue/approve.ts` (handle unique constraint violation with retry)
- `packages/db/src/schema.ts` (add index definitions for Drizzle awareness)

### Downstream dependents
`apps/server/src/queue/approve.ts` is imported by 2 files:
- `apps/server/src/routes/queue.ts` (1 ref) — calls approveCandidate, needs error handling update
- `apps/server/src/services/ingest.ts` (1 ref) — calls approve for auto-approve, needs error handling update
Both need retry logic for constraint violations.

`packages/db/src/schema.ts` is imported by 22 files (see F131 analysis). Adding index definitions is additive.

### Blast radius
- Medium — unique-index kan afvise eksisterende concurrent-approve flows
- Pre-migration cleanup nødvendig for at fjerne eventuelle eksisterende dubletter
- Edge case: stor KB med mange dubletter → cleanup kan tage tid

### Breaking changes
None to API. Internal behavior change: concurrent approves of same path now fail with constraint error instead of creating duplicates.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Migration kører uden fejl på clean DB
- [ ] `EXPLAIN QUERY PLAN` viser index-brug for `updatedAt` queries
- [ ] INSERT af self-link i wiki_backlinks → trigger error
- [ ] Concurrent approve af samme path → anden approve får constraint error
- [ ] Approve handler gracefully håndterer constraint violation med retry/update
- [ ] Regression: normale approve-flows virker uændret
- [ ] Regression: stale-detector queries er hurtigere med nyt index

## Implementation Steps
1. Skriv cleanup-script til at identificere og fjerne eksisterende dubletter
2. Kør cleanup på production DB (hvis nødvendigt)
3. Skriv migration med unique index + updatedAt index + trigger
4. Opdater approve-handler med constraint-violation retry logic
5. Tilføj index-definitioner i `packages/db/src/schema.ts`
6. Verificér med `EXPLAIN QUERY PLAN` at indexes bruges
7. Typecheck + regression tests

## Dependencies
None.

## Open Questions
None — all decisions made.

## Related Features
- **F1** (Stale detector pushdown) — benefits fra `updatedAt` index
- **F17** (Curation Queue API) — approve-handler håndterer constraint violations
- **F99** (Neuron graph) — self-links forurener graph-visualisering
- **F118** (Sampling scheduler) — bruger `updatedAt` range queries

## Effort Estimate
**Small** — 0.5 day
- 0.15 day: migration + schema updates
- 0.15 day: approve-handler retry logic
- 0.1 day: cleanup script (hvis nødvendigt)
- 0.1 day: testing + verification
