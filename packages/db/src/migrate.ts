/**
 * Standalone migrator — runs outside the engine process to apply
 * schema migrations + FTS setup to the default database file.
 *
 * Usage: `bun run packages/db/src/migrate.ts`
 */
import { createLibsqlDatabase, DEFAULT_DB_PATH } from './index.js';

const trail = await createLibsqlDatabase({ path: DEFAULT_DB_PATH });

console.log(`Running trail migrations against ${trail.path} ...`);
await trail.runMigrations();
console.log('Installing FTS5 ...');
await trail.initFTS();
await trail.close();
console.log('Done.');
