/**
 * One-shot cleanup — strip 6071 duplicate Neurons from the buddy-sessions
 * KB created by buddy's SessionEnd-hook spam loop (fixed in buddy commit
 * 5ae0e1e). Keeps the oldest Neuron per (path, filename); cascades handle
 * document_chunks / wiki_events / document_references / wiki_backlinks.
 *
 * Run once via:  bun run scripts/cleanup-buddy-spam.ts
 */
import { createLibsqlDatabase } from '@trail/db';
import { sql } from 'drizzle-orm';

const trail = await createLibsqlDatabase({
  path: process.env.TRAIL_DB_PATH ?? '/Users/cb/Apps/broberg/trail/data/trail.db',
});

const countBefore = await trail.db.all(sql`
  SELECT COUNT(*) AS n
  FROM documents d
  JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
  WHERE kb.slug = 'buddy-sessions' AND d.kind = 'wiki' AND d.archived = 0
`);
console.log('docs before:', (countBefore[0] as { n: number }).n);

// Null out resulting_document_id on any downstream candidate that
// points at a to-be-deleted duplicate (contradictions, orphan-lints,
// ingest-summaries produced against a dup). queue_candidates.FK is
// nullable + non-cascade — without this the DELETE fails with
// SQLITE_CONSTRAINT_FOREIGNKEY.
await trail.db.run(sql`
  UPDATE queue_candidates
  SET resulting_document_id = NULL
  WHERE resulting_document_id IN (
    SELECT d.id FROM documents d
    JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
    WHERE kb.slug = 'buddy-sessions'
      AND d.kind = 'wiki' AND d.archived = 0
      AND d.id NOT IN (
        SELECT MIN(id) FROM documents d2
        WHERE d2.knowledge_base_id = d.knowledge_base_id
          AND d2.kind = 'wiki' AND d2.archived = 0
        GROUP BY d2.path, d2.filename
      )
  )
`);

const res = await trail.db.run(sql`
  DELETE FROM documents
  WHERE id IN (
    SELECT d.id FROM documents d
    JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
    WHERE kb.slug = 'buddy-sessions'
      AND d.kind = 'wiki' AND d.archived = 0
      AND d.id NOT IN (
        SELECT MIN(id) FROM documents d2
        WHERE d2.knowledge_base_id = d.knowledge_base_id
          AND d2.kind = 'wiki' AND d2.archived = 0
        GROUP BY d2.path, d2.filename
      )
  )
`);
console.log('deleted:', (res as { rowsAffected?: number }).rowsAffected ?? '?');

const countAfter = await trail.db.all(sql`
  SELECT COUNT(*) AS n
  FROM documents d
  JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
  WHERE kb.slug = 'buddy-sessions' AND d.kind = 'wiki' AND d.archived = 0
`);
console.log('docs after:', (countAfter[0] as { n: number }).n);

process.exit(0);
