/**
 * Ad-hoc script — F102 glossary backfill for every KB in the DB,
 * without waiting for an engine restart. Reuses the same logic the
 * bootstrap runs at boot: detect empty-template or AI-populated-
 * without-footers glossaries, backfill them via Haiku, commit through
 * the createCandidate auto-approve path.
 *
 * Usage (from repo root or apps/server, doesn't matter — pass the DB
 * path explicitly so we don't guess):
 *
 *   TRAIL_DB_PATH=/Users/cb/Apps/broberg/trail/data/trail.db \
 *     bun run apps/server/scripts/backfill-all-glossaries.ts
 *
 * Prints per-KB status; exits cleanly when all KBs are done. Serial
 * across KBs so concurrent CLI spawns don't swamp the model.
 */
import { createLibsqlDatabase, DEFAULT_DB_PATH, knowledgeBases, documents } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { backfillGlossaryForKb } from '../src/services/glossary-backfill.js';

// Mirrored from F102-seed-glossary-neurons.ts — keep in sync.
const EMPTY_TEMPLATE_MARKERS = [
  'Domæne-specifikke fagtermer fra denne vidensbase. Ingen endnu',
  'Domain-specific terms from this knowledge base. None yet',
];
const AI_POPULATED_MARKERS = [
  'Genereret retroaktivt fra eksisterende Neuroner',
  'Generated retroactively from existing Neurons',
];
const FOOTER_MARKERS = ['_Se også:', '_See also:'];

console.log(`[backfill-all] opening DB at ${DEFAULT_DB_PATH}`);
const trail = await createLibsqlDatabase({ path: DEFAULT_DB_PATH });

const kbs = await trail.db
  .select({
    id: knowledgeBases.id,
    tenantId: knowledgeBases.tenantId,
    createdBy: knowledgeBases.createdBy,
    name: knowledgeBases.name,
    language: knowledgeBases.language,
  })
  .from(knowledgeBases)
  .all();

console.log(`[backfill-all] found ${kbs.length} KB(s)`);

let processed = 0;
let totalEntries = 0;
const t0 = Date.now();

for (const kb of kbs) {
  const doc = await trail.db
    .select({ content: documents.content })
    .from(documents)
    .where(
      and(
        eq(documents.knowledgeBaseId, kb.id),
        eq(documents.tenantId, kb.tenantId),
        eq(documents.filename, 'glossary.md'),
        eq(documents.path, '/neurons/'),
        eq(documents.archived, false),
      ),
    )
    .get();

  if (!doc) {
    console.log(`[backfill-all] "${kb.name}": no glossary.md — skipping (seed first via boot)`);
    continue;
  }

  const content = doc.content ?? '';
  const isEmptyTemplate = EMPTY_TEMPLATE_MARKERS.some((m) => content.includes(m));
  const isAiPopulated = AI_POPULATED_MARKERS.some((m) => content.includes(m));
  const hasFooters = FOOTER_MARKERS.some((m) => content.includes(m));

  let reason: string;
  if (isEmptyTemplate) {
    reason = 'empty template';
  } else if (isAiPopulated && !hasFooters) {
    reason = 'AI-populated without footers';
  } else if (isAiPopulated && hasFooters) {
    console.log(`[backfill-all] "${kb.name}": already has footers — skipping`);
    continue;
  } else {
    console.log(`[backfill-all] "${kb.name}": curator-edited (no AI marker) — leaving alone`);
    continue;
  }

  console.log(`[backfill-all] "${kb.name}": ${reason} — running backfill...`);
  try {
    const n = await backfillGlossaryForKb(trail, kb);
    totalEntries += n;
    processed += 1;
  } catch (err) {
    console.error(
      `[backfill-all] "${kb.name}": unhandled error —`,
      err instanceof Error ? err.message : err,
    );
  }
}

const elapsed = Math.round((Date.now() - t0) / 1000);
console.log(
  `[backfill-all] complete: processed ${processed}/${kbs.length} KB(s), ${totalEntries} total entries, ${elapsed}s`,
);

process.exit(0);
