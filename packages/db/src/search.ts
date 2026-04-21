/**
 * FTS5-backed search helpers. Kept as standalone functions so the
 * TrailDatabase adapter can dispatch to them without carrying a
 * class-method shape — and so tests can unit-test them with a plain
 * libSQL client without instantiating the full adapter.
 */
import type { Client as LibSqlClient } from '@libsql/client';
import type { DocumentSearchHit, ChunkSearchHit } from './interface.js';

const DOCUMENTS_SQL = `
  SELECT d.id                                               AS id,
         d.knowledge_base_id                                AS knowledgeBaseId,
         d.filename                                         AS filename,
         d.title                                            AS title,
         d.path                                             AS path,
         d.kind                                             AS kind,
         d.seq                                              AS seq,
         highlight(documents_fts, 0, '<mark>', '</mark>')   AS highlight,
         rank                                               AS rank
    FROM documents_fts
    JOIN documents d ON d.rowid = documents_fts.rowid
   WHERE documents_fts MATCH ?
     AND d.knowledge_base_id = ?
     AND d.tenant_id = ?
     AND d.archived = 0
   ORDER BY rank
   LIMIT ?
`;

const CHUNKS_SQL = `
  SELECT dc.id                                              AS id,
         dc.document_id                                     AS documentId,
         dc.knowledge_base_id                               AS knowledgeBaseId,
         dc.chunk_index                                     AS chunkIndex,
         dc.content                                         AS content,
         dc.header_breadcrumb                               AS headerBreadcrumb,
         highlight(chunks_fts, 0, '<mark>', '</mark>')      AS highlight,
         rank                                               AS rank
    FROM chunks_fts
    JOIN document_chunks dc ON dc.rowid = chunks_fts.rowid
   WHERE chunks_fts MATCH ?
     AND dc.knowledge_base_id = ?
     AND dc.tenant_id = ?
   ORDER BY rank
   LIMIT ?
`;

export async function searchDocuments(
  client: LibSqlClient,
  query: string,
  kbId: string,
  tenantId: string,
  limit = 10,
): Promise<DocumentSearchHit[]> {
  const result = await client.execute({ sql: DOCUMENTS_SQL, args: [query, kbId, tenantId, limit] });
  return result.rows.map((row) => ({
    id: row.id as string,
    knowledgeBaseId: row.knowledgeBaseId as string,
    filename: row.filename as string,
    title: (row.title as string | null) ?? null,
    path: row.path as string,
    kind: row.kind as 'source' | 'wiki',
    highlight: row.highlight as string,
    rank: row.rank as number,
    seq: (row.seq as number | null) ?? null,
  }));
}

export async function searchChunks(
  client: LibSqlClient,
  query: string,
  kbId: string,
  tenantId: string,
  limit = 10,
): Promise<ChunkSearchHit[]> {
  const result = await client.execute({ sql: CHUNKS_SQL, args: [query, kbId, tenantId, limit] });
  return result.rows.map((row) => ({
    id: row.id as string,
    documentId: row.documentId as string,
    knowledgeBaseId: row.knowledgeBaseId as string,
    chunkIndex: row.chunkIndex as number,
    content: row.content as string,
    headerBreadcrumb: (row.headerBreadcrumb as string | null) ?? null,
    highlight: row.highlight as string,
    rank: row.rank as number,
  }));
}
