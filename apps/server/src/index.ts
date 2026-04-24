import { createLibsqlDatabase, DEFAULT_DB_PATH } from '@trail/db';
import { createApp } from './app.js';
import { ensureIngestUser } from './bootstrap/ingest-user.js';
import { recoverZombieIngests } from './bootstrap/zombie-ingest.js';
import { rewriteWikiToNeurons } from './bootstrap/rewrite-wiki-paths.js';
import { cleanupExternalOrphans } from './bootstrap/F98-cleanup-external-orphans.js';
import { seedMissingGlossaryNeurons } from './bootstrap/F102-seed-glossary-neurons.js';
import { recoverPendingSources } from './bootstrap/recover-pending-sources.js';
import { recoverIngestJobs, startBackpressureScheduler } from './services/ingest.js';
import { startContradictionLint } from './services/contradiction-lint.js';
import { backfillReferences, startReferenceExtractor } from './services/reference-extractor.js';
import { backfillBacklinks, startBacklinkExtractor } from './services/backlink-extractor.js';
import { backfillLinkCheck, startLinkChecker } from './services/link-checker.js';
import { startLintScheduler } from './services/lint-scheduler.js';
import { startQueueBackfill } from './services/queue-backfill.js';
import { startActionRecommender, backfillRecommendations } from './services/action-recommender.js';

const PORT = Number(process.env.PORT ?? 3031);

// F40.1: one TrailDatabase per process. F40.2 replaces this with a
// per-tenant pool selected by tenant-context middleware — the rest
// of the engine already receives `trail` via Hono context, so that
// change will not require handler refactors.
const trail = await createLibsqlDatabase({ path: DEFAULT_DB_PATH });
await trail.runMigrations();
await trail.initFTS();
await ensureIngestUser(trail);
await recoverZombieIngests(trail);
await rewriteWikiToNeurons(trail);
// F98 — dismiss pending orphan-findings targeting external-originated
// Neurons (buddy, MCP, chat, api). Their sources live outside Trail;
// the orphan detector used to falsely flag them. Idempotent — zero
// rows to update after the first run is the steady state.
await cleanupExternalOrphans(trail);
// F102 — ensure every KB has /neurons/glossary.md. Idempotent; seeds
// the Neuron for KBs created before F102 landed so the compile-pipeline
// has something to str_replace into on subsequent ingests.
await seedMissingGlossaryNeurons(trail);
// Re-run extractor on any source stuck in `status='pending'` with a
// supported file type (pdf/docx/pptx/xlsx). Covers two cases:
// (1) uploads that predate the extractor for their type (e.g. a PPTX
// uploaded before the PPTX pipeline shipped), (2) server-crashed-
// mid-upload rows. Unsupported types stay pending — they need new
// pipelines. Fire-and-forget: the processXAsync helpers own their
// status transitions.
await recoverPendingSources(trail);
// F143 — roll any `running` ingest-jobs back to `queued` and kick the
// scheduler for each KB with work outstanding. Survives restarts without
// dropping half a 65-file upload batch on the floor.
await recoverIngestJobs(trail);
// F21 — start the periodic backpressure scheduler. It re-ticks queued
// work every 30s so jobs blocked by global concurrency cap or per-tenant
// rate cap don't hang waiting for a new enqueue event.
startBackpressureScheduler(trail);
await backfillReferences(trail);
await backfillBacklinks(trail);
// F148 — populate broken_links table so the admin link-report panel
// surfaces any unresolvable [[wiki-link]]s immediately on first deploy.
// Idempotent; runs after backfillBacklinks so the fresh backlinks table
// reflects the fold-enabled resolution.
await backfillLinkCheck(trail);

// F15 — reference extractor subscribes to candidate_approved.
const stopReferenceExtractor = startReferenceExtractor(trail);

// F15 iter 2 — wiki-wiki backlink extractor subscribes to the same event.
// Graph of [[link]]s between Neurons, populated live + at boot.
const stopBacklinkExtractor = startBacklinkExtractor(trail);

// F148 — link-checker subscribes to candidate_approved too. Re-scans the
// committed doc's [[wiki-link]]s against the KB pool; unresolved links
// land in broken_links for the curator.
const stopLinkChecker = startLinkChecker(trail);

// F19 axis 3 — contradiction detection subscribes to candidate_approved.
const stopContradictionLint = startContradictionLint(trail);

// F32.2 — scheduled dreaming pass (orphans+stale + contradictions over
// every KB, default every 24h). Complements the reactive subscribers above
// by catching Neurons that changed OUT of scope (e.g. a source archival
// made an existing Neuron orphaned), which no event flow would notice.
const stopLintScheduler = startLintScheduler(trail);

// F90 — one-shot enrichment of existing queue candidates: populate
// actions[] on rows that landed before the primitive existed, and
// pre-translate pending candidates into every configured locale so the
// Danish admin boots with Danish content already cached. Runs 30s after
// boot; sequential so the CLI subprocess doesn't fan out.
const stopQueueBackfill = startQueueBackfill(trail);

// F96 — action recommender subscribes to candidate_created. LLM call
// per pending candidate; stamps metadata.recommendation with a
// suggested action id + reasoning. Admin renders the badge; bulk-
// accept route uses it for per-candidate dispatch.
const stopActionRecommender = startActionRecommender(trail);

// One-shot backfill for existing pending candidates that landed
// before the recommender was wired up. Runs 60s after boot so it
// doesn't compete with queue-backfill's translation work. Serial, so
// it cooks at CLI pace (~5s/candidate). The process owns its own
// error isolation — a single bad candidate doesn't abort the batch.
setTimeout(() => {
  void backfillRecommendations(trail).catch((err) => {
    console.error('[action-recommender] backfill failed:', err);
  });
}, 60_000);

const app = createApp(trail);

const server = Bun.serve({
  port: PORT,
  // Disable the 10-second default idle timeout: it killed SSE streams mid-
  // flight (pings are 30s apart) and EventSource reconnected every ~10s,
  // dropping any candidate_* event that fired inside the gap. That silent
  // drop was the root cause of the "badge is stuck on N" symptom — the
  // client never saw the decrement. SSE connections live as long as the
  // client keeps them; stream.onAbort handles real disconnects.
  idleTimeout: 0,
  fetch: app.fetch,
});

console.log(`trail server running on http://localhost:${server.port}`);
console.log(`  database: ${trail.path}`);

// Graceful shutdown: tear down background subscribers first so no async
// handler can race an event against a closing libSQL client, then stop
// the HTTP server, then close the DB so the WAL checkpoints cleanly.
const shutdown = async () => {
  console.log('\nshutting down…');
  stopReferenceExtractor();
  stopBacklinkExtractor();
  stopLinkChecker();
  stopContradictionLint();
  stopLintScheduler();
  stopQueueBackfill();
  server.stop();
  await trail.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
