/**
 * One-shot: re-run reference-extractor for every Neuron in the DB.
 * Populates document_references rows that may have been missed by the
 * live candidate_approved subscriber (timing bug suspected: approve-
 * then-emit can fire before doc.content is fully committed).
 *
 * Run with:
 *   cd apps/server && TRAIL_DB_PATH=../../data/trail.db \
 *     bun run scripts/backfill-refs.ts
 */
import { createLibsqlDatabase } from '@trail/db';
import { backfillReferences } from '../src/services/reference-extractor.js';

const trail = await createLibsqlDatabase({
  path: process.env.TRAIL_DB_PATH ?? '/Users/cb/Apps/broberg/trail/data/trail.db',
});

console.log('running backfillReferences across all Neurons…');
await backfillReferences(trail);
console.log('done.');
process.exit(0);
