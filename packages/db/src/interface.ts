import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type * as schema from './schema.js';

/**
 * F40 abstraction — the contract every consumer depends on.
 *
 * F40.1 (now): one TrailDatabase per process, wrapping the engine's
 * single `.db` file. Drop-in for the legacy `bun:sqlite` client with
 * async-everywhere surface.
 *
 * F40.2 (next): a pool returns one TrailDatabase per authenticated
 * tenant, keyed by tenantId. The interface here is unchanged — only
 * the factory + middleware changes. Nothing in the call-site code
 * moves at F40.2 if we consume the interface cleanly today.
 *
 * Design commitments:
 *   1. Drizzle stays the primary query API (`db.select().from(...)`).
 *   2. Raw SQL goes through `execute(sql, args)` — never via a rawDb
 *      handle that leaks the underlying driver into callers.
 *   3. Search helpers live on the interface so consumers never reach
 *      into adapter internals for FTS5.
 *   4. Lifecycle is explicit: `runMigrations()` + `initFTS()` on boot,
 *      `close()` on shutdown. No top-level-module side effects.
 */
export interface TrailDatabase {
  /** Drizzle query builder bound to the schema. */
  readonly db: LibSQLDatabase<typeof schema>;

  /** Tenant identity. F40.1: always `"default"`. F40.2: real tenant id. */
  readonly tenantId: string;

  /** The canonical path of the underlying database file. */
  readonly path: string;

  /**
   * Raw SQL escape hatch for FTS5 / pragma / anything outside Drizzle.
   * Returns rows as plain objects (keys match SQL column aliases).
   */
  execute(sql: string, args?: ReadonlyArray<SqlArg>): Promise<ExecuteResult>;

  /** Apply schema migrations. Idempotent; safe to call on every boot. */
  runMigrations(): Promise<void>;

  /**
   * (Re)install FTS5 virtual tables + triggers + rebuild. Idempotent.
   * Cheap on Phase 1 volumes; F40.2 may move to lazy-per-tenant.
   */
  initFTS(): Promise<void>;

  /** FTS5 search over `documents`. */
  searchDocuments(query: string, kbId: string, tenantId: string, limit?: number): Promise<DocumentSearchHit[]>;

  /** FTS5 search over `document_chunks`. */
  searchChunks(query: string, kbId: string, tenantId: string, limit?: number): Promise<ChunkSearchHit[]>;

  /** Release the connection. Idempotent. */
  close(): Promise<void>;
}

export type SqlArg = string | number | bigint | boolean | null | Uint8Array;

export interface ExecuteResult {
  rows: Record<string, unknown>[];
  rowsAffected: number;
}

export interface DocumentSearchHit {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  title: string | null;
  path: string;
  kind: 'source' | 'wiki';
  highlight: string;
  rank: number;
  seq: number | null;
}

export interface ChunkSearchHit {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  content: string;
  headerBreadcrumb: string | null;
  highlight: string;
  rank: number;
}

export interface DatabaseConfig {
  /** Filesystem path (absolute or relative). Will be created if missing. */
  path: string;
  /** Tenant id — F40.1: `"default"`, F40.2: the real tenant's id. */
  tenantId?: string;
  /** Optional libSQL auth token (unused in F40.1 local-file mode). */
  authToken?: string;
}
