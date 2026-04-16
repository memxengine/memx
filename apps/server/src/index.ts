import { createLibsqlDatabase, DEFAULT_DB_PATH } from '@trail/db';
import { createApp } from './app.js';
import { ensureIngestUser } from './bootstrap/ingest-user.js';
import { recoverZombieIngests } from './bootstrap/zombie-ingest.js';

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

const app = createApp(trail);

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`trail server running on http://localhost:${server.port}`);
console.log(`  database: ${trail.path}`);

// Graceful shutdown: release the libSQL client so the WAL file is
// checkpointed cleanly. Bun will otherwise kill the process without
// letting libSQL flush.
const shutdown = async () => {
  console.log('\nshutting down…');
  server.stop();
  await trail.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
