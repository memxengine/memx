/**
 * `@trail/db` — database access for the Trail engine.
 *
 * Primary export is the `TrailDatabase` interface + `createLibsqlDatabase`
 * factory. Callers receive a `TrailDatabase` instance (from bootstrap
 * in `apps/server` and `apps/mcp`) and reach Drizzle via `trail.db`.
 *
 * F40.1 (now): one TrailDatabase per process, backed by one local .db
 * file via `@libsql/client` embedded. Drop-in for the legacy
 * `bun:sqlite` client with an async-everywhere surface.
 *
 * F40.2 (next): a per-tenant pool routes each request to one of many
 * TrailDatabase instances. The interface here is unchanged; only the
 * factory + a middleware that selects `trail` by tenant changes.
 *
 * Design rules (carried forward to F40.2):
 *   1. No top-level database side effects. Tests can import this file
 *      without opening a file handle.
 *   2. No global singleton. Callers instantiate explicitly in bootstrap.
 *   3. Raw SQL only via `TrailDatabase.execute()` — never via a raw
 *      client handle that leaks the driver.
 *   4. Lifecycle calls (`runMigrations`, `initFTS`, `close`) are always
 *      awaited explicitly — they do not run automatically.
 */

// ── Public contract ────────────────────────────────────────────────
export type {
  TrailDatabase,
  DatabaseConfig,
  ExecuteResult,
  SqlArg,
  DocumentSearchHit,
  ChunkSearchHit,
} from './interface.js';

// ── Factory ────────────────────────────────────────────────────────
export { createLibsqlDatabase, LibsqlTrailDatabase } from './libsql-adapter.js';

// ── F153 Backup primitive ──────────────────────────────────────────
export { snapshotDb } from './backup.js';
export type { SnapshotResult, SnapshotOptions } from './backup.js';

// ── Schema (re-exports — tables, enums, relations) ─────────────────
export * from './schema.js';
import * as schema from './schema.js';
export { schema };

// ── Default path resolution ────────────────────────────────────────
//
// Exposed as constants (not side effects) so tests and alternative
// bootstraps (F40.2 per-tenant paths) can consume them without
// reaching into process.env directly.
import { join } from 'node:path';

export const DATA_DIR: string =
  process.env.TRAIL_DATA_DIR ?? join(process.cwd(), 'data');

export const DEFAULT_DB_PATH: string =
  process.env.TRAIL_DB_PATH ?? join(DATA_DIR, 'trail.db');
