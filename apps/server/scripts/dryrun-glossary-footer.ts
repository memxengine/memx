/**
 * One-shot dry-run for the F102 glossary backfill footer feature.
 * Not wired into normal boot — invoke directly:
 *   cd apps/server && bun run scripts/dryrun-glossary-footer.ts
 * Clears the local glossary content back to the empty-template
 * signature, runs backfillGlossaryForKb, prints the produced
 * content so we can see whether "Se også: [[...]]" footers appear.
 */
import { createLibsqlDatabase, DEFAULT_DB_PATH, knowledgeBases, documents } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { backfillGlossaryForKb } from '../src/services/glossary-backfill.js';
import { buildSeedGlossary } from '../src/services/glossary-seed.js';

const trail = await createLibsqlDatabase({ path: DEFAULT_DB_PATH });
await trail.runMigrations();

const kb = await trail.db
  .select({
    id: knowledgeBases.id,
    tenantId: knowledgeBases.tenantId,
    createdBy: knowledgeBases.createdBy,
    name: knowledgeBases.name,
    language: knowledgeBases.language,
  })
  .from(knowledgeBases)
  .get();

if (!kb) {
  console.log('no KB in local DB — seed one first');
  process.exit(1);
}

console.log('KB:', kb.name, 'language=', kb.language);

// Reset glossary to empty template so backfill sees it as a candidate
const emptyTemplate = buildSeedGlossary(kb.language);
await trail.db
  .update(documents)
  .set({ content: emptyTemplate, updatedAt: new Date().toISOString() })
  .where(
    and(
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.filename, 'glossary.md'),
      eq(documents.path, '/neurons/'),
    ),
  )
  .run();

console.log('reset glossary to empty template, running backfill...');
const n = await backfillGlossaryForKb(trail, kb);
console.log('wrote', n, 'entries');

const doc = await trail.db
  .select({ content: documents.content })
  .from(documents)
  .where(
    and(
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.filename, 'glossary.md'),
      eq(documents.path, '/neurons/'),
    ),
  )
  .get();

console.log('\n--- glossary content (first 3000 chars) ---\n');
console.log(doc?.content?.slice(0, 3000) ?? '(no glossary)');

process.exit(0);
