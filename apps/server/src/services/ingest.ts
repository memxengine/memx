import { documents, knowledgeBases, DATA_DIR, type TrailDatabase } from '@trail/db';
import { eq } from 'drizzle-orm';
import { broadcaster } from './broadcast.js';
import { spawnClaude } from './claude.js';
import { ensureMcpConfig } from '../lib/mcp-config.js';
import { listKbTags } from './tag-aggregate.js';

/**
 * Collapse a raw spawnClaude error into a one-sentence reason the
 * curator can act on. spawnClaude surfaces:
 *   - "claude timed out after <s>s"              → keep verbatim
 *   - "claude exited 1: { ... JSON blob ... }"   → parse stop_reason
 *                                                   / subtype + render
 *                                                   a human sentence
 *   - anything else                              → first 200 chars
 */
function humaniseIngestError(raw: string): string {
  if (raw.startsWith('claude timed out')) {
    return `${raw}. Source may be too large for the current compile budget — bump TRAIL_INGEST_TIMEOUT_MS or split the file.`;
  }
  const jsonStart = raw.indexOf('{');
  if (jsonStart > -1) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      if (parsed.subtype === 'error_max_turns') {
        return `Compile hit the turn limit (${parsed.num_turns ?? '?'}). Source needs more budget — raise TRAIL_INGEST_MAX_TURNS or split into smaller files.`;
      }
      if (parsed.stop_reason) {
        return `Claude stopped with ${parsed.stop_reason} after ${parsed.num_turns ?? '?'} turns. Retry — transient.`;
      }
    } catch {
      // fall through to generic
    }
  }
  return raw.slice(0, 200);
}

const INGEST_MODEL = process.env.INGEST_MODEL ?? '';
// Interim safety-net budgets while F137 (Chunked Ingest) is in flight.
// Originals (180s / 25 turns) sized for 3-8 page test PDFs; these bumps
// cover medium-scale 14-40 page sources without architectural change.
// F137 will split large PDFs into page-chunks so per-call budgets can
// shrink back to tight values — these ceilings are a transitional
// "engine should never fail because of a parameter" contract.
const INGEST_TIMEOUT_MS = Number(process.env.INGEST_TIMEOUT_MS ?? 1_800_000); // 30 min
const INGEST_MAX_TURNS = Number(process.env.INGEST_MAX_TURNS ?? 200);

// Per-KB serialisation — one ingest at a time per KB, rest queued.
// (A KB is the correct granularity here: ingest rewrites shared wiki pages, so
// two concurrent ingests into the same KB would race on /neurons/overview.md etc.)
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

  // User-controlled strings (filename, title, KB name/slug, path) are
  // wrapped with JSON.stringify so quote/backtick/newline payloads can't
  // break out of their string literals and redirect the compiler's
  // behaviour. JSON produces a valid quoted literal AND the LLM
  // round-trips the unescaped form when echoing the value back in a
  // tool call — so `foo"bar.pdf` stays `foo"bar.pdf` at the MCP boundary.
  const sFilename = JSON.stringify(doc.filename);
  const sSourcePath = JSON.stringify(sourcePath);
  const sKbName = JSON.stringify(kb.name);
  const sKbSlug = JSON.stringify(kb.slug);
  const summaryTitle = doc.title ?? doc.filename.replace(/\.\w+$/, '');
  const sSummaryTitle = JSON.stringify(summaryTitle);
  const sLogHeading = JSON.stringify(doc.title ?? doc.filename);

  // F92.1 — feed the existing KB tag vocabulary into the compile
  // prompt so the LLM prefers REUSING tags over inventing fresh ones.
  // Without this the compile LLM generates a new unique tag per
  // Neuron, producing a long tail of count=1 tags that destroys the
  // facet-filter's value (we saw 100% unique-tag rate on Sanne's KB).
  // Top-60 covers any KB we'll realistically see; the aggregate is
  // already cached (60s TTL) so repeated ingests don't pay per-call.
  let existingTags: string[] = [];
  try {
    const aggregate = await listKbTags(trail, job.tenantId, job.kbId);
    existingTags = aggregate.slice(0, 60).map((t) => t.tag);
  } catch (err) {
    // Aggregate failure isn't fatal — the LLM can still propose
    // fresh tags without the vocabulary hint. Log so the cause is
    // visible if Christian notices count=1 tags coming back.
    console.warn(
      '[ingest] tag vocabulary fetch failed; compile will run without hint:',
      err instanceof Error ? err.message : err,
    );
  }
  const tagBlock = existingTags.length > 0
    ? `\n\nEXISTING TAG VOCABULARY IN THIS KB (prefer reusing over inventing new ones — exact spelling required):\n${existingTags.map((t) => `  - ${t}`).join('\n')}\n\nOnly propose a new tag when nothing in the list fits the concept.`
    : '\n\n(This KB has no tags yet — you are establishing the vocabulary. Keep tags short, lowercase, and specific.)';

  const prompt = `You are the wiki compiler for knowledge base ${sKbName} (slug: ${sKbSlug}).${tagBlock}

A new source has been added: ${sFilename} at path ${sSourcePath}.

Your job is to ingest this source into the wiki. Follow these steps exactly:

1. Call \`read\` with path=${sSourcePath} to read the new source.

2. Call \`search\` with mode="list" and kind="wiki" to see the current wiki structure.

3. Call \`read\` with path="/neurons/overview.md" to understand the current wiki state.

4. Create a source summary page:
   Call \`write\` with command="create", path="/neurons/sources/", title=${sSummaryTitle}, and content that includes:
   - YAML frontmatter with title, tags (array), date (${today}), sources ([${sFilename}])
   - Key takeaways and findings
   - Important quotes or data points

5. For each KEY CONCEPT found in the source (aim for 2-5 concepts):
   - Check if a concept page already exists (you saw the wiki listing in step 2).
   - If it exists: \`read\` it, then \`write\` with command="str_replace" to integrate new information. Use the full path (e.g. "/neurons/concepts/concept-name.md") as the title parameter. CRITICAL: preserve existing frontmatter but ADD ${sFilename} to its \`sources: [...]\` array (de-dup if already listed). If the page has no \`sources\` field yet, insert one listing ${sFilename}.
   - If it doesn't exist: \`write\` with command="create", path="/neurons/concepts/", and full content INCLUDING frontmatter with \`sources: [${sFilename}]\`.

6. For each KEY ENTITY (person, organization, tool) found:
   - Same pattern under /neurons/entities/. Same \`sources\` frontmatter rule applies — every entity page MUST list ${sFilename} in its \`sources: [...]\`.

7. Maintain the glossary (F102):
   - Call \`read\` with path="/neurons/glossary.md" to see the current vocabulary. This Neuron collects DOMAIN-SPECIFIC fagtermer drawn from Sources — starts empty, grows as Sources are ingested.
   - If this source INTRODUCES or clearly REFINES 1–3 domain-specific terms that belong in a glossary (not casual mentions — terms that have a defined meaning the reader would want to look up), add or update them:
     * For a new term: \`write\` with command="str_replace", title="/neurons/glossary.md" — append a new \`## <Term>\\n\\n<1–3 sentence definition drawn from this source>\\n\` section. Place it alphabetically if possible.
     * For an existing term whose definition this source sharpens or extends: \`write\` str_replace the existing definition block with a revised version. Preserve the heading.
   - If the source introduces no glossary-worthy terms, SKIP this step. Glossary entries are for durable fagtermer, not one-off vocabulary.

8. Update the overview page:
   \`write\` with command="str_replace", title="/neurons/overview.md" — reflect the new knowledge and link to the new pages.

9. Log the ingest:
   \`write\` with command="append", title="/neurons/log.md", content:

   ## [${today}] ingest | ${sLogHeading}
   - Summary: (1-2 sentences)
   - Pages created: (list)
   - Pages updated: (list)
   - Contradictions: (any found, or "None")

IMPORTANT RULES:
- Be thorough but concise. Every claim should reference its source.
- Use [[page-name]] for internal wiki cross-references. When the relation is stronger than a plain mention, annotate it via [[page-name|edge-type]] so the knowledge-graph can reason about it. Valid edge-types:
  * \`[[target|is-a]]\` — hierarchical specialisation (NADA is-a acupuncture-protocol)
  * \`[[target|part-of]]\` — composition (ear-point-lung is part-of NADA)
  * \`[[target|contradicts]]\` — explicit disagreement between claims
  * \`[[target|supersedes]]\` — versioning; this Neuron replaces an older one
  * \`[[target|example-of]]\` — concrete instance of an abstract concept
  * \`[[target|caused-by]]\` — causal dependency
  Bare \`[[target]]\` (no edge-type) means a plain citation/reference. Use typed edges sparingly — only when the relation is semantically load-bearing, not just "I mentioned this page."
- ALL pages you create or update under /neurons/concepts/, /neurons/entities/, or /neurons/sources/ MUST have a \`sources: [...]\` field in their YAML frontmatter listing every Source filename the page draws claims from. The orphan-detector flags pages missing this field, so a missing \`sources\` list is a bug, not a shortcut. When updating an existing page, merge — don't replace — its existing sources array.
- Required frontmatter fields on every page: title, tags, date, sources.
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
    String(INGEST_MAX_TURNS),
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
        // Tag candidates emitted by this ingest run with connector=upload
        // so the admin Queue filter shows them grouped with other upload-
        // originated work (as distinct from mcp:claude-code, buddy, etc.).
        TRAIL_CONNECTOR: 'upload',
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
    const rawMsg = err instanceof Error ? err.message : String(err);
    const errorMsg = humaniseIngestError(rawMsg);
    // Keep the raw stack/JSON in the server console for debugging but
    // show the curator a short plain-language sentence.
    console.error(`[ingest] Failed for "${doc.filename}":`, rawMsg);

    await trail.db
      .update(documents)
      .set({
        status: 'failed',
        errorMessage: errorMsg,
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
      error: errorMsg,
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
