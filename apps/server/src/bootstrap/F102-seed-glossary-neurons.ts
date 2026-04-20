/**
 * F102 bootstrap — idempotent.
 *
 * Two responsibilities:
 *
 * 1. Ensure every KB has a `/neurons/glossary.md` Neuron. KBs created
 *    before F102 shipped never got one at creation-time.
 *
 * 2. Clean up glossaries that landed with the WRONG seed content. The
 *    first F102 ship (commit 8770194) mis-seeded the Neuron with the
 *    trail-APP terminology (Trail, Neuron, Curator, …) drawn from
 *    data/glossary.json. That's app vocabulary — it lives in the
 *    global /glossary admin panel. Per-KB glossaries are meant for
 *    DOMAIN-specific fagtermer the compile-pipeline harvests from
 *    Sources. This bootstrap detects the polluted content via a
 *    signature marker (see glossary-seed.ts POLLUTED_SEED_MARKERS)
 *    and overwrites it with the empty template via a direct
 *    documents-table UPDATE. A wiki_events row is written so the
 *    rewrite is visible in the history rather than looking like a
 *    silent mutation.
 *
 * Safe to leave in place forever: both the SELECT guard (creates
 *    only when missing) and the content-marker check (rewrites only
 *    still-polluted seeds) idempotent-ize out after one run.
 */
import {
  documents,
  knowledgeBases,
  wikiEvents,
  type TrailDatabase,
} from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { createCandidate } from '@trail/core';
import {
  buildSeedGlossary,
  POLLUTED_SEED_MARKERS,
} from '../services/glossary-seed.js';

const GLOSSARY_FILENAME = 'glossary.md';
const GLOSSARY_PATH = '/neurons/';

type Kb = {
  id: string;
  tenantId: string;
  createdBy: string;
  name: string;
  language: string | null;
};

export async function seedMissingGlossaryNeurons(trail: TrailDatabase): Promise<void> {
  const kbs = (await trail.db
    .select({
      id: knowledgeBases.id,
      tenantId: knowledgeBases.tenantId,
      createdBy: knowledgeBases.createdBy,
      name: knowledgeBases.name,
      language: knowledgeBases.language,
    })
    .from(knowledgeBases)
    .all()) as Kb[];

  if (kbs.length === 0) return;

  let seeded = 0;
  let rewritten = 0;
  for (const kb of kbs) {
    const existing = await trail.db
      .select({
        id: documents.id,
        content: documents.content,
        version: documents.version,
      })
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

    if (!existing) {
      if (await seedGlossary(trail, kb)) seeded += 1;
      continue;
    }

    const content = existing.content ?? '';
    const isPolluted = POLLUTED_SEED_MARKERS.some((m) => content.includes(m));
    if (isPolluted) {
      const replacement = buildSeedGlossary(kb.language);
      await rewriteGlossary(trail, kb, existing.id, existing.version, replacement);
      rewritten += 1;
    }
  }

  if (seeded > 0) {
    console.log(`  F102 bootstrap: seeded glossary.md in ${seeded} KB(s)`);
  }
  if (rewritten > 0) {
    console.log(`  F102 bootstrap: rewrote polluted glossary in ${rewritten} KB(s) (reverted to empty template)`);
  }
}

async function seedGlossary(trail: TrailDatabase, kb: Kb): Promise<boolean> {
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
    return true;
  } catch (err) {
    console.error(
      `[F102 bootstrap] failed to seed glossary for KB "${kb.name}":`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function rewriteGlossary(
  trail: TrailDatabase,
  kb: Kb,
  docId: string,
  currentVersion: number,
  content: string,
): Promise<void> {
  const nextVersion = currentVersion + 1;
  const nowIso = new Date().toISOString();
  try {
    await trail.db
      .update(documents)
      .set({ content, version: nextVersion, updatedAt: nowIso })
      .where(eq(documents.id, docId))
      .run();

    // History trail so the rewrite is auditable rather than a silent
    // mutation. Actor kind 'system' (the bootstrap ran the update, not
    // a human), eventType 'edited' matches the normal rewrite event.
    await trail.db.insert(wikiEvents).values({
      id: crypto.randomUUID(),
      tenantId: kb.tenantId,
      documentId: docId,
      eventType: 'edited',
      actorId: kb.createdBy,
      actorKind: 'system',
      previousVersion: currentVersion,
      newVersion: nextVersion,
      summary: 'F102 bootstrap: replaced polluted glossary seed with empty template',
      contentSnapshot: content,
      createdAt: nowIso,
    }).run();
  } catch (err) {
    console.error(
      `[F102 bootstrap] failed to rewrite polluted glossary for KB "${kb.name}":`,
      err instanceof Error ? err.message : err,
    );
  }
}
