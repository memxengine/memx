# F133 — Schema Integrity Improvements

*Planned. Tier: infrastruktur. Effort: 0.5 day.*

> Tilføj manglende indexes + constraints fra trail-optimizer-audit: uniqueIndex på `(knowledgeBaseId, path, filename)`, index på `documents.updatedAt`, CHECK constraint mod self-links i `wikiBacklinks`. Rent hygiejne-fix — ingen ny funktionalitet, færre edge-case-bugs.

## Problem

Trail-optimizer-audit identificerede flere schema-niveau gaps (KARPATHY-ALIGNMENT.md + round 2 findings til trail):

1. **Ingen uniqueIndex på (kbId, path, filename)** — to concurrent candidate-approvals kan skabe dublet-Neurons med identisk sti. Sjældent men muligt.
2. **Ingen index på `documents.updatedAt`** — F118 sampling-scheduler + F1's stale-pushdown benefits fra indekseret range-query.
3. **Ingen CHECK constraint på `wikiBacklinks`** — `from_document_id` kan være lig `to_document_id`; backlink-extractor har app-level guard, men DB accepterer stadig self-links.

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

## How

- Migration-fil i `packages/db/drizzle/migrations/`
- Unique-index-tilføjelse afviser INSERT på dublet → candidate-approve må håndtere konstraint-fejl med retry + conflict-resolution
- Stale-detector (allerede F1-fixed med `lt(updatedAt, cutoff)`) får perf-boost fra nyt index
- Trigger-approach til wikiBacklinks fordi SQLite ikke supporterer ADD CHECK post-creation

## Dependencies

Ingen.

## Success criteria

- `EXPLAIN QUERY PLAN SELECT ... WHERE updatedAt < ?` viser `USING INDEX idx_docs_updated_at`
- Forsøg på at oprette wiki-backlink til sig selv fejler med trigger-error
- Concurrent approves af samme filename-to-path candidate → anden approve får constraint-error (eller graceful retry-logic i approve-path)
