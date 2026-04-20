/**
 * F102 bootstrap — idempotent.
 *
 * Ensure every existing KB has a `/neurons/glossary.md` Neuron. KBs
 * created before F102 shipped never got one at creation-time, so
 * the compile-pipeline's glossary-maintenance step has nothing to
 * str_replace into. This bootstrap seeds the missing ones.
 *
 * Safe to leave in place forever: once a KB has a glossary Neuron,
 * the SELECT guard skips it on subsequent boots.
 *
 * The seed write goes through `createCandidate` (as every wiki write
 * must per the Curation Queue invariant) with `actor.kind='system'`
 * and `kind='ingest-summary'`, which the auto-approval policy accepts
 * on sight — same shape the post-/knowledge-bases handler uses.
 */
import { documents, knowledgeBases, type TrailDatabase } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { createCandidate } from '@trail/core';
import { buildSeedGlossary } from '../services/glossary-seed.js';

const GLOSSARY_FILENAME = 'glossary.md';
const GLOSSARY_PATH = '/neurons/';

export async function seedMissingGlossaryNeurons(trail: TrailDatabase): Promise<void> {
  // Actor = kb.createdBy. The service-ingest user only exists when
  // TRAIL_INGEST_TOKEN is configured; leaning on it here would fail
  // on fresh installs and on dev DBs that never set the token.
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

  if (kbs.length === 0) return;

  let seeded = 0;
  for (const kb of kbs) {
    const existing = await trail.db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.knowledgeBaseId, kb.id),
          eq(documents.tenantId, kb.tenantId),
          eq(documents.filename, GLOSSARY_FILENAME),
          eq(documents.path, GLOSSARY_PATH),
          eq(documents.archived, false),
        ),
      )
      .get();
    if (existing) continue;

    const lang = kb.language ?? 'da';
    const title = lang === 'da' ? 'Ordliste' : 'Glossary';
    const content = buildSeedGlossary(lang);

    try {
      await createCandidate(
        trail,
        kb.tenantId,
        {
          knowledgeBaseId: kb.id,
          kind: 'ingest-summary',
          title,
          content,
          metadata: JSON.stringify({
            op: 'create',
            filename: GLOSSARY_FILENAME,
            path: GLOSSARY_PATH,
            source: 'bootstrap:F102',
          }),
          confidence: 1,
        },
        { id: kb.createdBy, kind: 'system' },
      );
      seeded += 1;
    } catch (err) {
      console.error(
        `[F102 bootstrap] failed to seed glossary for KB "${kb.name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (seeded > 0) {
    console.log(`  F102 bootstrap: seeded glossary.md in ${seeded} KB(s)`);
  }
}
