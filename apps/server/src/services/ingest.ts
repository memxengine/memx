import { documents, knowledgeBases, ingestJobs, documentReferences, DATA_DIR, type TrailDatabase } from '@trail/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import {
  parseSchemaNeuron,
  renderSchemaForPrompt,
  resolveSchemaChain,
  type SchemaNeuronRow,
} from '@trail/core';
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

// F143 — durable per-KB queue. One row per pending job in `ingest_jobs`;
// status transitions queued → running → done|failed. The scheduler picks
// oldest-queued per KB atomically so two ticks can't double-claim the same
// job, and a boot sweep rolls interrupted `running` rows back to `queued`
// so a kill mid-ingest doesn't orphan the remaining upload batch.

export interface IngestJob {
  trail: TrailDatabase;
  docId: string;
  kbId: string;
  tenantId: string;
  userId: string;
}

// In-flight set, scoped to the current process. We still need to know when
// a KB has a running job locally so we don't pull two jobs into the same
// process concurrently and race on /neurons/overview.md. Durability lives
// in the DB column `status='running'`; this Set is purely an in-process
// guard that survives a single poll cycle.
const runningLocally = new Set<string>();

export function triggerIngest(job: IngestJob): void {
  // Fire-and-forget from the caller's point of view — same ergonomics as
  // the old in-memory version. The DB write + scheduler-tick happen async
  // on the event loop; any error is logged but doesn't block the upload
  // response.
  void enqueueAndTick(job);
}

async function enqueueAndTick(job: IngestJob): Promise<void> {
  try {
    const jobId = `job_${crypto.randomUUID().slice(0, 12)}`;
    await job.trail.db
      .insert(ingestJobs)
      .values({
        id: jobId,
        tenantId: job.tenantId,
        knowledgeBaseId: job.kbId,
        documentId: job.docId,
        status: 'queued',
      })
      .run();
    tickScheduler(job.trail, job.kbId, job.tenantId, job.userId);
  } catch (err) {
    console.error(`[ingest] enqueue failed for doc ${job.docId}:`, err);
  }
}

/**
 * Pull the oldest queued job for a KB, flip it to running, and fire
 * runIngest. Idempotent — if another tick is already running a job for
 * this KB (tracked via `runningLocally`), this call is a no-op. The
 * finally-block in runIngest calls tickScheduler again so the queue
 * drains one-by-one.
 */
function tickScheduler(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  userId: string,
): void {
  if (runningLocally.has(kbId)) return;
  runningLocally.add(kbId);
  // Fire-and-forget; every exit path clears the guard.
  void claimAndRun(trail, kbId, tenantId, userId).catch((err) => {
    console.error(`[ingest] scheduler error for KB ${kbId}:`, err);
    runningLocally.delete(kbId);
  });
}

async function claimAndRun(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  userId: string,
): Promise<void> {
  try {
    const next = await trail.db
      .select()
      .from(ingestJobs)
      .where(and(eq(ingestJobs.knowledgeBaseId, kbId), eq(ingestJobs.status, 'queued')))
      .orderBy(asc(ingestJobs.createdAt))
      .limit(1)
      .get();
    if (!next) {
      runningLocally.delete(kbId);
      return;
    }
    // Atomic claim — only one ticker can win the flip. A second concurrent
    // tick finds status='running' and skips this job on its next SELECT.
    const claimedAt = new Date().toISOString();
    const claimed = await trail.db
      .update(ingestJobs)
      .set({ status: 'running', startedAt: claimedAt, attempts: next.attempts + 1 })
      .where(and(eq(ingestJobs.id, next.id), eq(ingestJobs.status, 'queued')))
      .run();
    if (claimed.rowsAffected === 0) {
      // Another tick beat us to it — try again immediately in case there's
      // still work queued.
      runningLocally.delete(kbId);
      tickScheduler(trail, kbId, tenantId, userId);
      return;
    }
    await runJob(trail, next.id, {
      trail,
      docId: next.documentId,
      kbId,
      tenantId: next.tenantId,
      userId,
    });
  } finally {
    runningLocally.delete(kbId);
    // Drain: if more queued, schedule another tick. A fresh tickScheduler
    // call re-takes the guard and loops until the queue is empty.
    const more = await trail.db
      .select({ id: ingestJobs.id })
      .from(ingestJobs)
      .where(and(eq(ingestJobs.knowledgeBaseId, kbId), eq(ingestJobs.status, 'queued')))
      .limit(1)
      .get();
    if (more) tickScheduler(trail, kbId, tenantId, userId);
  }
}

/**
 * Boot recovery. Any `running` row in ingest_jobs at startup is from a
 * previous process that didn't finish — roll it back to `queued` so the
 * scheduler picks it up again. The zombie-doc sweep (separate, on the
 * documents table) still runs for doc rows stuck at status='processing'
 * from pre-F143 state; after F143 the job row is the source of truth.
 */
export async function recoverIngestJobs(trail: TrailDatabase): Promise<void> {
  const res = await trail.db
    .update(ingestJobs)
    .set({ status: 'queued', startedAt: null })
    .where(eq(ingestJobs.status, 'running'))
    .run();
  if (res.rowsAffected > 0) {
    console.log(`[ingest] recovered ${res.rowsAffected} running jobs → queued`);
  }
  // Kick one tick per KB that has queued work, so the scheduler starts
  // draining without waiting for the next upload.
  const kbsWithWork = await trail.db
    .selectDistinct({ kbId: ingestJobs.knowledgeBaseId, tenantId: ingestJobs.tenantId })
    .from(ingestJobs)
    .where(eq(ingestJobs.status, 'queued'))
    .all();
  for (const row of kbsWithWork) {
    // User context on boot-recovered jobs: use the tenant's ingest service
    // user. runJob will load the document and use the tenant id on it.
    tickScheduler(trail, row.kbId, row.tenantId, 'service-ingest');
  }
}

async function runJob(
  trail: TrailDatabase,
  jobId: string,
  job: IngestJob,
): Promise<void> {

  const doc = await trail.db.select().from(documents).where(eq(documents.id, job.docId)).get();
  const kb = await trail.db.select().from(knowledgeBases).where(eq(knowledgeBases.id, job.kbId)).get();

  if (!doc || !kb) {
    // Orphaned job — document or KB deleted between enqueue and claim.
    // Mark terminal so the row doesn't linger as "running" forever.
    await trail.db
      .update(ingestJobs)
      .set({
        status: 'failed',
        errorMessage: 'document or KB no longer exists',
        completedAt: new Date().toISOString(),
      })
      .where(eq(ingestJobs.id, jobId))
      .run();
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

  // F140 — hierarchical schema inheritance. Load every `_schema.md`
  // under this KB, merge those whose scope covers the source's
  // destination path, render as a prompt-ready block. Empty when no
  // _schema.md exists anywhere in the tree. Scoped-to-target so a
  // source dropped into /neurons/concepts/akupunktur/ picks up the
  // akupunktur-domain schema (if any) on top of the KB-level one.
  let schemaBlock = '';
  try {
    const schemaRows = await loadSchemaNeurons(trail, job.tenantId, job.kbId);
    if (schemaRows.length > 0) {
      const profile = resolveSchemaChain(doc.path, schemaRows);
      schemaBlock = renderSchemaForPrompt(profile);
    }
  } catch (err) {
    console.warn(
      '[ingest] schema inheritance failed; compile will run without path-schema:',
      err instanceof Error ? err.message : err,
    );
  }

  const prompt = `You are the wiki compiler for knowledge base ${sKbName} (slug: ${sKbSlug}).${tagBlock}${schemaBlock}

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

  const jobStartedAt = new Date().toISOString();
  try {
    await spawnClaude(args, {
      timeoutMs: INGEST_TIMEOUT_MS,
      env: {
        TRAIL_TENANT_ID: job.tenantId,
        TRAIL_USER_ID: job.userId,
        TRAIL_KNOWLEDGE_BASE_ID: job.kbId,
        TRAIL_DATA_DIR: DATA_DIR,
        // Tag candidates emitted by this ingest run with the source's
        // original connector so web-clipper / API uploads retain their
        // attribution through to the compiled Neuron. Fall back to
        // 'upload' for plain file drops.
        TRAIL_CONNECTOR: (() => {
          if (!doc.metadata) return 'upload';
          try {
            const m = JSON.parse(doc.metadata) as { connector?: unknown };
            return typeof m.connector === 'string' ? m.connector : 'upload';
          } catch { return 'upload'; }
        })(),
      },
    });

    const finishedAt = new Date().toISOString();
    await trail.db
      .update(documents)
      .set({ status: 'ready', updatedAt: finishedAt })
      .where(eq(documents.id, job.docId))
      .run();
    await trail.db
      .update(ingestJobs)
      .set({ status: 'done', completedAt: finishedAt })
      .where(eq(ingestJobs.id, jobId))
      .run();

    // Deterministic source→Neuron ref wiring. Any wiki doc created in this
    // KB since the job started is a product of this ingest run — wire it to
    // the source doc directly, without relying on LLM frontmatter.
    await wireSourceRefs(trail, doc, jobStartedAt);

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

    const finishedAt = new Date().toISOString();
    await trail.db
      .update(documents)
      .set({
        status: 'failed',
        errorMessage: errorMsg,
        updatedAt: finishedAt,
      })
      .where(eq(documents.id, job.docId))
      .run();
    await trail.db
      .update(ingestJobs)
      .set({ status: 'failed', errorMessage: errorMsg, completedAt: finishedAt })
      .where(eq(ingestJobs.id, jobId))
      .run();

    broadcaster.emit({
      type: 'ingest_failed',
      tenantId: job.tenantId,
      kbId: job.kbId,
      docId: job.docId,
      filename: doc.filename,
      error: errorMsg,
    });
  }
  // Draining happens in the caller (claimAndRun's finally-block) — it
  // looks up whether any queued jobs remain and re-ticks the scheduler.
  // That keeps the drain loop in one place and free of the Map-based
  // state the old implementation relied on.
}

/**
 * Deterministic source→Neuron reference wiring.
 *
 * After the LLM subprocess completes, we know exactly which wiki docs were
 * created during this ingest run: all wiki docs in this KB with
 * `created_at >= jobStartedAt`. We write a document_references row for each
 * of them pointing at the source doc that was just compiled.
 *
 * This is the authoritative path — it doesn't depend on the LLM including
 * `sources: [...]` in frontmatter. The frontmatter-based reference extractor
 * (reference-extractor.ts) remains active and handles cross-source citations
 * that the LLM explicitly declares. These two paths are additive, and
 * insertRef is idempotent via the unique index.
 */
async function wireSourceRefs(
  trail: TrailDatabase,
  sourceDoc: { id: string; tenantId: string; knowledgeBaseId: string },
  jobStartedAt: string,
): Promise<void> {
  const newWikiDocs = await trail.db
    .select({ id: documents.id, tenantId: documents.tenantId, knowledgeBaseId: documents.knowledgeBaseId, filename: documents.filename })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, sourceDoc.tenantId),
        eq(documents.knowledgeBaseId, sourceDoc.knowledgeBaseId),
        eq(documents.kind, 'wiki'),
        eq(documents.archived, false),
        gt(documents.createdAt, jobStartedAt),
      ),
    )
    .all();

  let inserted = 0;
  for (const wiki of newWikiDocs) {
    const id = `ref_${crypto.randomUUID().slice(0, 12)}`;
    try {
      await trail.db
        .insert(documentReferences)
        .values({
          id,
          tenantId: wiki.tenantId,
          knowledgeBaseId: wiki.knowledgeBaseId,
          wikiDocumentId: wiki.id,
          sourceDocumentId: sourceDoc.id,
          claimAnchor: null,
        })
        .run();
      inserted += 1;
    } catch {
      // unique-index hit — ref already exists, skip silently
    }
  }
  if (inserted > 0) {
    console.log(`[ingest] wired ${inserted} source ref${inserted === 1 ? '' : 's'} → ${sourceDoc.id.slice(0, 8)}…`);
  }
}

/**
 * F140 — fetch every `_schema.md` Neuron in a KB and parse its
 * frontmatter. Called once per ingest. Small cardinality (one per
 * directory that wants local rules) so a single SELECT is plenty.
 */
async function loadSchemaNeurons(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
): Promise<SchemaNeuronRow[]> {
  const rows = await trail.db
    .select({
      path: documents.path,
      content: documents.content,
    })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.knowledgeBaseId, kbId),
        eq(documents.kind, 'wiki'),
        eq(documents.archived, false),
        eq(documents.filename, '_schema.md'),
      ),
    )
    .all();

  const out: SchemaNeuronRow[] = [];
  for (const r of rows) {
    const parsed = parseSchemaNeuron(r.path, r.content ?? '');
    if (parsed) out.push(parsed);
  }
  return out;
}
