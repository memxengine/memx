import { documents, knowledgeBases, DATA_DIR, type TrailDatabase } from '@trail/db';
import { eq } from 'drizzle-orm';
import { broadcaster } from './broadcast.js';
import { spawnClaude } from './claude.js';
import { ensureMcpConfig } from '../lib/mcp-config.js';

const INGEST_MODEL = process.env.INGEST_MODEL ?? '';
const INGEST_TIMEOUT_MS = Number(process.env.INGEST_TIMEOUT_MS ?? 180_000);

// Per-KB serialisation — one ingest at a time per KB, rest queued.
// (A KB is the correct granularity here: ingest rewrites shared wiki pages, so
// two concurrent ingests into the same KB would race on /wiki/overview.md etc.)
const activeIngests = new Map<string, boolean>();
const ingestQueue = new Map<string, IngestJob[]>();

export interface IngestJob {
  trail: TrailDatabase;
  docId: string;
  kbId: string;
  tenantId: string;
  userId: string;
}

export function triggerIngest(job: IngestJob): void {
  if (activeIngests.get(job.kbId)) {
    const queue = ingestQueue.get(job.kbId) ?? [];
    queue.push(job);
    ingestQueue.set(job.kbId, queue);
    console.log(`[ingest] Queued ${job.docId} in KB ${job.kbId} (${queue.length} waiting)`);
    return;
  }
  runIngest(job);
}

async function runIngest(job: IngestJob): Promise<void> {
  activeIngests.set(job.kbId, true);
  const { trail } = job;

  const doc = await trail.db.select().from(documents).where(eq(documents.id, job.docId)).get();
  const kb = await trail.db.select().from(knowledgeBases).where(eq(knowledgeBases.id, job.kbId)).get();

  if (!doc || !kb) {
    activeIngests.delete(job.kbId);
    return;
  }

  await trail.db
    .update(documents)
    .set({ status: 'processing', updatedAt: new Date().toISOString() })
    .where(eq(documents.id, job.docId))
    .run();

  broadcaster.emit({
    type: 'ingest_started',
    tenantId: job.tenantId,
    kbId: job.kbId,
    docId: job.docId,
    filename: doc.filename,
  });

  const today = new Date().toISOString().slice(0, 10);
  const sourcePath = `${doc.path}${doc.filename}`;

  const prompt = `You are the wiki compiler for knowledge base "${kb.name}" (slug: "${kb.slug}").

A new source has been added: "${doc.filename}" at path "${sourcePath}".

Your job is to ingest this source into the wiki. Follow these steps exactly:

1. Call \`read\` with path="${sourcePath}" to read the new source.

2. Call \`search\` with mode="list" and kind="wiki" to see the current wiki structure.

3. Call \`read\` with path="/wiki/overview.md" to understand the current wiki state.

4. Create a source summary page:
   Call \`write\` with command="create", path="/wiki/sources/", title="${doc.title ?? doc.filename.replace(/\.\w+$/, '')}", and content that includes:
   - YAML frontmatter with title, tags (array), date (${today}), sources (["${doc.filename}"])
   - Key takeaways and findings
   - Important quotes or data points

5. For each KEY CONCEPT found in the source (aim for 2-5 concepts):
   - Check if a concept page already exists (you saw the wiki listing in step 2).
   - If it exists: \`read\` it, then \`write\` with command="str_replace" to integrate new information. Use the full path (e.g. "/wiki/concepts/concept-name.md") as the title parameter.
   - If it doesn't exist: \`write\` with command="create", path="/wiki/concepts/", and full content with frontmatter.

6. For each KEY ENTITY (person, organization, tool) found:
   - Same pattern under /wiki/entities/.

7. Update the overview page:
   \`write\` with command="str_replace", title="/wiki/overview.md" — reflect the new knowledge and link to the new pages.

8. Log the ingest:
   \`write\` with command="append", title="/wiki/log.md", content:

   ## [${today}] ingest | ${doc.title ?? doc.filename}
   - Summary: (1-2 sentences)
   - Pages created: (list)
   - Pages updated: (list)
   - Contradictions: (any found, or "None")

IMPORTANT RULES:
- Be thorough but concise. Every claim should reference its source.
- Use [[page-name]] for internal wiki cross-references.
- All pages must have YAML frontmatter with title, tags, date.
- Do NOT create pages for trivial concepts. Focus on the 2-5 most important ones.
- If the source is very short or trivial, just create the summary and update overview/log.
- You do not need to pass knowledge_base to tool calls — the default KB is already set.`;

  console.log(`[ingest] Starting for "${doc.filename}" in "${kb.name}" (tenant ${job.tenantId})`);

  const mcpConfigPath = ensureMcpConfig();
  const args = [
    '-p',
    prompt,
    '--mcp-config',
    mcpConfigPath,
    '--allowedTools',
    'mcp__trail__guide,mcp__trail__search,mcp__trail__read,mcp__trail__write',
    '--dangerously-skip-permissions',
    '--max-turns',
    '25',
    '--output-format',
    'json',
    ...(INGEST_MODEL ? ['--model', INGEST_MODEL] : []),
  ];

  try {
    await spawnClaude(args, {
      timeoutMs: INGEST_TIMEOUT_MS,
      env: {
        TRAIL_TENANT_ID: job.tenantId,
        TRAIL_USER_ID: job.userId,
        TRAIL_KNOWLEDGE_BASE_ID: job.kbId,
        TRAIL_DATA_DIR: DATA_DIR,
      },
    });

    await trail.db
      .update(documents)
      .set({ status: 'ready', updatedAt: new Date().toISOString() })
      .where(eq(documents.id, job.docId))
      .run();

    broadcaster.emit({
      type: 'ingest_completed',
      tenantId: job.tenantId,
      kbId: job.kbId,
      docId: job.docId,
      filename: doc.filename,
    });

    console.log(`[ingest] Completed "${doc.filename}"`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[ingest] Failed for "${doc.filename}":`, errorMsg);

    await trail.db
      .update(documents)
      .set({
        status: 'failed',
        errorMessage: errorMsg.slice(0, 1000),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(documents.id, job.docId))
      .run();

    broadcaster.emit({
      type: 'ingest_failed',
      tenantId: job.tenantId,
      kbId: job.kbId,
      docId: job.docId,
      filename: doc.filename,
      error: errorMsg.slice(0, 200),
    });
  } finally {
    activeIngests.delete(job.kbId);

    const queue = ingestQueue.get(job.kbId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) ingestQueue.delete(job.kbId);
      runIngest(next);
    }
  }
}
