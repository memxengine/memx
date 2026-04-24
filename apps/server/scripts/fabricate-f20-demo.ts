/**
 * F20 demo fabricator — inject a single pending `op: update` candidate
 * into the queue targeting an existing Neuron, with a content-diff
 * that's substantial enough to render meaningfully.
 *
 * Runs once, prints the candidate ID + the URL the curator should open
 * to see the diff UI live. Idempotent: re-running creates a NEW demo
 * candidate each time (doesn't replace prior runs — curator can reject
 * the old ones if they pile up).
 *
 * Run: `bun run apps/server/scripts/fabricate-f20-demo.ts`
 */

import { createLibsqlDatabase, DEFAULT_DB_PATH, documents, queueCandidates, knowledgeBases } from '@trail/db';
import { eq, and } from 'drizzle-orm';

const TARGET_DOC_ID = 'doc_f97a9fd7-a34';

const trail = await createLibsqlDatabase({ path: DEFAULT_DB_PATH });

const doc = await trail.db
  .select({
    id: documents.id,
    tenantId: documents.tenantId,
    knowledgeBaseId: documents.knowledgeBaseId,
    filename: documents.filename,
    title: documents.title,
    content: documents.content,
    version: documents.version,
  })
  .from(documents)
  .where(eq(documents.id, TARGET_DOC_ID))
  .get();

if (!doc) {
  console.error(`target doc ${TARGET_DOC_ID} not found`);
  process.exit(1);
}

const kb = await trail.db
  .select({ slug: knowledgeBases.slug, name: knowledgeBases.name })
  .from(knowledgeBases)
  .where(eq(knowledgeBases.id, doc.knowledgeBaseId))
  .get();

if (!kb) {
  console.error(`kb not found`);
  process.exit(1);
}

// Fabricate a content modification: append a new section + remove one
// paragraph + rewrite one line. Substantial enough that the diff shows
// both additions and removals across the body.
const currentContent = doc.content ?? '';
const lines = currentContent.split('\n');

// Find and modify a line near the top of the body (after frontmatter)
let bodyStart = 0;
let frontmatterEnds = 0;
for (let i = 0; i < lines.length; i++) {
  if (i > 0 && lines[i] === '---') {
    frontmatterEnds = i;
    bodyStart = i + 1;
    break;
  }
}

const modified = [...lines];

// 1) Replace the first substantive paragraph line with a rewritten version
for (let i = bodyStart; i < modified.length; i++) {
  if (modified[i]!.length > 120) {
    const original = modified[i]!;
    modified[i] = original.replace(
      /^(.{0,100})/,
      '**OPDATERET 2026-04-25:** Zoneterapi — også kaldet refleksologi — er en evidens-informeret komplementær praksis hvor',
    );
    break;
  }
}

// 2) Remove a paragraph somewhere in the middle
for (let i = bodyStart + 5; i < modified.length - 5; i++) {
  if (modified[i]!.trim() === '' && modified[i + 1]?.trim().length === 0) {
    modified.splice(i, 2);
    break;
  }
}

// 3) Append a new section at the bottom
modified.push('');
modified.push('## Ny sektion (fabrikeret til F20-demo)');
modified.push('');
modified.push('Denne sektion er tilføjet af `fabricate-f20-demo.ts` for at demonstrere Curator Diff UI.');
modified.push('Den findes ikke i den rigtige kilde. Afvis kandidaten når du er færdig med at kigge på diff\'en.');

const proposedContent = modified.join('\n');

// Insert the pending candidate
const candidateId = `cnd_${crypto.randomUUID().slice(0, 12)}`;
const now = new Date().toISOString();

await trail.db
  .insert(queueCandidates)
  .values({
    id: candidateId,
    tenantId: doc.tenantId,
    knowledgeBaseId: doc.knowledgeBaseId,
    kind: 'ingest-page-update',
    title: `F20 demo — opdatering af ${doc.title ?? doc.filename}`,
    content: proposedContent,
    metadata: JSON.stringify({
      op: 'update',
      targetDocumentId: doc.id,
      filename: doc.filename,
      expectedVersion: doc.version,
      connector: 'curator',
    }),
    confidence: 70,
    impactEstimate: 3,
    status: 'pending',
    createdAt: now,
    actions: JSON.stringify([
      {
        id: 'approve',
        effect: 'approve',
        label: { en: 'Approve', da: 'Godkend' },
        explanation: {
          en: 'Apply the proposed content to the Neuron and mark this candidate approved.',
          da: 'Anvend det foreslåede indhold på Neuronen og markér denne kandidat som godkendt.',
        },
      },
      {
        id: 'reject',
        effect: 'reject',
        label: { en: 'Reject', da: 'Afvis' },
        explanation: {
          en: 'Discard the proposed change. The Neuron stays as it is.',
          da: 'Forkast den foreslåede ændring. Neuronen forbliver som den er.',
        },
      },
    ]),
  })
  .run();

console.log(`✓ fabricated pending update-candidate`);
console.log(`  id:       ${candidateId}`);
console.log(`  target:   ${doc.id} (${doc.filename})`);
console.log(`  kb:       ${kb.slug} (${kb.name})`);
console.log(`  added:    ~5 lines (new '## Ny sektion')`);
console.log(`  removed:  1 paragraph`);
console.log(`  modified: 1 opening paragraph`);
console.log();
console.log(`open:  http://127.0.0.1:58031/kb/${kb.slug}/queue`);
console.log(`then expand '${candidateId.slice(0, 12)}…' and click "Vis diff"`);

await trail.close();
