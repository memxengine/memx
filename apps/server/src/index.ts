import { createLibsqlDatabase, DEFAULT_DB_PATH } from '@trail/db';
import { createApp } from './app.js';
import { ensureIngestUser } from './bootstrap/ingest-user.js';
import { recoverZombieIngests } from './bootstrap/zombie-ingest.js';
import { rewriteWikiToNeurons } from './bootstrap/rewrite-wiki-paths.js';
import { startContradictionLint } from './services/contradiction-lint.js';
import { backfillReferences, startReferenceExtractor } from './services/reference-extractor.js';
import { backfillBacklinks, startBacklinkExtractor } from './services/backlink-extractor.js';
import { startLintScheduler } from './services/lint-scheduler.js';
import { startQueueBackfill } from './services/queue-backfill.js';

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
await backfillReferences(trail);
await backfillBacklinks(trail);

// F15 — reference extractor subscribes to candidate_approved.
const stopReferenceExtractor = startReferenceExtractor(trail);

// F15 iter 2 — wiki-wiki backlink extractor subscribes to the same event.
// Graph of [[link]]s between Neurons, populated live + at boot.
const stopBacklinkExtractor = startBacklinkExtractor(trail);

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
  stopContradictionLint();
  stopLintScheduler();
  stopQueueBackfill();
  server.stop();
  await trail.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
