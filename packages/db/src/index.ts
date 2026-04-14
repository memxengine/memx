import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export * from './schema.js';
export { schema };

const DATA_DIR = process.env.MEMX_DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = process.env.MEMX_DB_PATH ?? join(DATA_DIR, 'memx.db');

mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.exec('PRAGMA busy_timeout = 5000;');

export const db = drizzle(sqlite, { schema });

export function runMigrations(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = join(__dirname, '..', 'drizzle');
  migrate(db, { migrationsFolder });
}

export function initFTS(): void {
  // Contentless FTS5 tables backed by the main tables via rowid. Triggers keep
  // the indices in sync on INSERT/UPDATE/DELETE so searches always see fresh
  // content without manual bookkeeping.
  //
  // We rebuild on every boot so the schema is canonical and stale FTS state
  // (e.g. from a prior shape) doesn't linger. Cheap for Phase 1 volumes.
  sqlite.exec(`
    DROP TRIGGER IF EXISTS documents_ai;
    DROP TRIGGER IF EXISTS documents_au;
    DROP TRIGGER IF EXISTS documents_ad;
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_au;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TABLE IF EXISTS documents_fts;
    DROP TABLE IF EXISTS chunks_fts;
  `);

  sqlite.exec(`
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      content, title, filename,
      content='documents',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );
  `);
  sqlite.exec(`
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content, header_breadcrumb,
      content='document_chunks',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );
  `);

  sqlite.exec(`
    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, content, title, filename)
        VALUES (new.rowid, new.content, new.title, new.filename);
    END;
    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, content, title, filename)
        VALUES ('delete', old.rowid, old.content, old.title, old.filename);
    END;
    CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, content, title, filename)
        VALUES ('delete', old.rowid, old.content, old.title, old.filename);
      INSERT INTO documents_fts(rowid, content, title, filename)
        VALUES (new.rowid, new.content, new.title, new.filename);
    END;

    CREATE TRIGGER chunks_ai AFTER INSERT ON document_chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, header_breadcrumb)
        VALUES (new.rowid, new.content, new.header_breadcrumb);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON document_chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, header_breadcrumb)
        VALUES ('delete', old.rowid, old.content, old.header_breadcrumb);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON document_chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, header_breadcrumb)
        VALUES ('delete', old.rowid, old.content, old.header_breadcrumb);
      INSERT INTO chunks_fts(rowid, content, header_breadcrumb)
        VALUES (new.rowid, new.content, new.header_breadcrumb);
    END;
  `);

  // Backfill from existing rows (safe on empty DBs, cheap on Phase 1 volumes).
  sqlite.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild');`);
  sqlite.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');`);
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
}

export function searchDocuments(
  query: string,
  kbId: string,
  tenantId: string,
  limit = 10,
): DocumentSearchHit[] {
  return sqlite
    .prepare(
      `SELECT d.id AS id,
              d.knowledge_base_id AS knowledgeBaseId,
              d.filename AS filename,
              d.title AS title,
              d.path AS path,
              d.kind AS kind,
              highlight(documents_fts, 0, '<mark>', '</mark>') AS highlight,
              rank
         FROM documents_fts
         JOIN documents d ON d.rowid = documents_fts.rowid
        WHERE documents_fts MATCH ?
          AND d.knowledge_base_id = ?
          AND d.tenant_id = ?
          AND d.archived = 0
        ORDER BY rank
        LIMIT ?`,
    )
    .all(query, kbId, tenantId, limit) as DocumentSearchHit[];
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

export function searchChunks(
  query: string,
  kbId: string,
  tenantId: string,
  limit = 10,
): ChunkSearchHit[] {
  return sqlite
    .prepare(
      `SELECT dc.id AS id,
              dc.document_id AS documentId,
              dc.knowledge_base_id AS knowledgeBaseId,
              dc.chunk_index AS chunkIndex,
              dc.content AS content,
              dc.header_breadcrumb AS headerBreadcrumb,
              highlight(chunks_fts, 0, '<mark>', '</mark>') AS highlight,
              rank
         FROM chunks_fts
         JOIN document_chunks dc ON dc.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
          AND dc.knowledge_base_id = ?
          AND dc.tenant_id = ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(query, kbId, tenantId, limit) as ChunkSearchHit[];
}

export { sqlite as rawDb, DB_PATH, DATA_DIR };
