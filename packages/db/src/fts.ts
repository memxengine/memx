/**
 * FTS5 setup — contentless virtual tables backed by `documents` and
 * `document_chunks` via rowid. Triggers keep the indices in sync on
 * INSERT / UPDATE / DELETE so searches always see fresh content with
 * no manual bookkeeping.
 *
 * Runs on every boot (`initFTS()` below). The DROP+CREATE pattern is
 * deliberate: it keeps the FTS schema canonical and prevents stale
 * definitions from a prior deploy leaking in. Cheap on Phase 1
 * volumes; F40.2 can move to a "only-rebuild-if-changed" path if
 * boot cost becomes material.
 */
import type { Client as LibSqlClient } from '@libsql/client';

const DROP_ALL = `
  DROP TRIGGER IF EXISTS documents_ai;
  DROP TRIGGER IF EXISTS documents_au;
  DROP TRIGGER IF EXISTS documents_ad;
  DROP TRIGGER IF EXISTS chunks_ai;
  DROP TRIGGER IF EXISTS chunks_au;
  DROP TRIGGER IF EXISTS chunks_ad;
  DROP TABLE IF EXISTS documents_fts;
  DROP TABLE IF EXISTS chunks_fts;
`;

const CREATE_DOCUMENTS_FTS = `
  CREATE VIRTUAL TABLE documents_fts USING fts5(
    content, title, filename,
    content='documents',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );
`;

const CREATE_CHUNKS_FTS = `
  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    content, header_breadcrumb,
    content='document_chunks',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );
`;

const DOCUMENTS_TRIGGERS = `
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
`;

const CHUNKS_TRIGGERS = `
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
`;

/**
 * Rebuild all FTS5 tables + triggers from scratch, then backfill from
 * existing rows. Safe on empty databases. Call once per boot.
 *
 * libSQL's `executeMultiple` handles statement-separated DDL in one
 * round-trip, which matters here because the triggers must land in
 * the same WAL checkpoint as the table creation or the first write
 * after boot could race.
 */
export async function initFTS(client: LibSqlClient): Promise<void> {
  await client.executeMultiple(DROP_ALL);
  await client.execute(CREATE_DOCUMENTS_FTS);
  await client.execute(CREATE_CHUNKS_FTS);
  await client.executeMultiple(DOCUMENTS_TRIGGERS);
  await client.executeMultiple(CHUNKS_TRIGGERS);
  await client.execute(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild');`);
  await client.execute(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');`);
}
