/**
 * F149 Phase 2a — CandidateQueueAPI.
 *
 * The in-process ingest-tooling API. Provides the four operations that
 * ingest backends need (guide, search, read, write) as async functions
 * returning structured data. Callers format the structured data into
 * whatever shape their protocol needs:
 *
 *   - apps/mcp's stdio server wraps into `{content: [{type:'text',
 *     text}]}` for MCP responses.
 *   - apps/server's OpenRouterBackend wraps into OpenAI-compatible
 *     `{role: 'tool', tool_call_id, content}` messages.
 *
 * Shared logic: DB queries, slugify, createCandidate. Formatting stays
 * at the protocol boundary so each transport can render as it wishes.
 *
 * All operations take an explicit `CandidateQueueContext` rather than
 * relying on module-level env vars — that makes them composable across
 * tenants + safe for in-process use where the calling runner already
 * has the context resolved.
 */

import { and, eq, like } from 'drizzle-orm';
import {
  documents,
  documentAccess,
  knowledgeBases,
  type TrailDatabase,
} from '@trail/db';
import { formatSeqId } from '@trail/shared';
import { createCandidate } from '../queue/candidates.js';
import { slugify } from '../slug.js';

export interface CandidateQueueContext {
  trail: TrailDatabase;
  tenantId: string;
  tenantName: string;
  userId: string;
  connector: string;
  ingestJobId: string | null;
  /**
   * Default KB for operations that don't pass a `knowledge_base`
   * argument. When this is set and the caller omits the arg, it wins.
   */
  defaultKbId?: string;
}

const LLM_ACTOR = (userId: string) => ({ id: userId, kind: 'llm' as const });

// ── KB resolution helper ────────────────────────────────────────────────

interface ResolvedKb {
  id: string;
  name: string;
  slug: string;
  tenantId: string;
  language: string;
}

async function resolveKB(
  ctx: CandidateQueueContext,
  nameOrSlug: string | undefined,
): Promise<ResolvedKb | null> {
  const trail = ctx.trail;
  const needle = nameOrSlug?.trim();
  if (!needle) {
    if (!ctx.defaultKbId) return null;
    const row = await trail.db
      .select({
        id: knowledgeBases.id,
        name: knowledgeBases.name,
        slug: knowledgeBases.slug,
        tenantId: knowledgeBases.tenantId,
        language: knowledgeBases.language,
      })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, ctx.defaultKbId), eq(knowledgeBases.tenantId, ctx.tenantId)))
      .get();
    return row ?? null;
  }
  const conds = [
    [eq(knowledgeBases.slug, needle), eq(knowledgeBases.tenantId, ctx.tenantId)],
    [eq(knowledgeBases.name, needle), eq(knowledgeBases.tenantId, ctx.tenantId)],
    [eq(knowledgeBases.id, needle), eq(knowledgeBases.tenantId, ctx.tenantId)],
  ] as const;
  for (const c of conds) {
    const row = await trail.db
      .select({
        id: knowledgeBases.id,
        name: knowledgeBases.name,
        slug: knowledgeBases.slug,
        tenantId: knowledgeBases.tenantId,
        language: knowledgeBases.language,
      })
      .from(knowledgeBases)
      .where(and(...c))
      .get();
    if (row) return row;
  }
  return null;
}

function globMatch(filename: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true;
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  );
  return re.test(filename);
}

function sanitizeFtsQuery(raw: string): string {
  // Mirror of MCP server's sanitizer. FTS5 special chars → spaces so
  // the parser doesn't choke on user-supplied quotes, dashes, etc.
  return raw
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => (/\s/.test(w) ? `"${w}"` : w))
    .join(' ');
}

// ── guide ───────────────────────────────────────────────────────────────

export interface GuideKb {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sourceCount: number;
  wikiPageCount: number;
}

export interface GuideResult {
  tenantName: string;
  kbs: GuideKb[];
}

const GUIDE_KBS_SQL = `
  SELECT kb.id, kb.name, kb.slug, kb.description,
         (SELECT COUNT(*) FROM documents d
            WHERE d.knowledge_base_id = kb.id
              AND d.kind = 'source'
              AND d.archived = 0) AS sourceCount,
         (SELECT COUNT(*) FROM documents d
            WHERE d.knowledge_base_id = kb.id
              AND d.kind = 'wiki'
              AND d.archived = 0) AS wikiPageCount
    FROM knowledge_bases kb
   WHERE kb.tenant_id = ?
`;

export async function guide(ctx: CandidateQueueContext): Promise<GuideResult> {
  const result = await ctx.trail.execute(GUIDE_KBS_SQL, [ctx.tenantId]);
  return {
    tenantName: ctx.tenantName,
    kbs: result.rows as unknown as GuideKb[],
  };
}

// ── search ──────────────────────────────────────────────────────────────

export interface SearchArgs {
  knowledge_base?: string;
  mode?: 'list' | 'search';
  query?: string;
  path?: string;
  kind?: 'source' | 'wiki' | 'any';
}

export interface SearchDocListHit {
  filename: string;
  path: string;
  title: string | null;
  kind: 'source' | 'wiki' | 'work';
  fileType: string;
  status: string;
  seq: number | null;
  /** F145 formatted handle (e.g. `sanne_00000042`); null when seq absent. */
  seqId: string | null;
  updatedAt: string;
}

export interface SearchDocFtsHit {
  filename: string;
  path: string;
  title: string | null;
  kind: 'source' | 'wiki';
  seq: number | null;
  seqId: string | null;
  highlight: string;
  rank: number;
}

export interface SearchChunk {
  chunkIndex: number;
  content: string;
}

export type SearchResult =
  | { ok: false; error: 'kb-not-found'; kbInput: string | undefined }
  | { ok: false; error: 'search-mode-requires-query' }
  | {
      ok: true;
      mode: 'list';
      kbName: string;
      kbId: string;
      docs: SearchDocListHit[];
    }
  | {
      ok: true;
      mode: 'search';
      kbName: string;
      kbId: string;
      query: string;
      docs: SearchDocFtsHit[];
      chunks: SearchChunk[];
    };

export async function search(
  ctx: CandidateQueueContext,
  args: SearchArgs,
): Promise<SearchResult> {
  const kb = await resolveKB(ctx, args.knowledge_base);
  if (!kb) return { ok: false, error: 'kb-not-found', kbInput: args.knowledge_base };

  const mode = args.mode ?? 'list';
  if (mode === 'search') {
    const query = (args.query ?? '').trim();
    if (!query) return { ok: false, error: 'search-mode-requires-query' };
    const ftsQuery = sanitizeFtsQuery(query);
    const docResults = ftsQuery
      ? await ctx.trail.searchDocuments(ftsQuery, kb.id, ctx.tenantId, 20)
      : [];
    const chunkResults = ftsQuery
      ? await ctx.trail.searchChunks(ftsQuery, kb.id, ctx.tenantId, 10)
      : [];

    return {
      ok: true,
      mode: 'search',
      kbName: kb.name,
      kbId: kb.id,
      query,
      docs: docResults.map((r) => ({
        filename: r.filename,
        path: r.path,
        title: r.title,
        kind: r.kind,
        seq: r.seq,
        seqId: formatSeqId(kb.name, r.seq),
        highlight: r.highlight,
        rank: r.rank,
      })),
      chunks: chunkResults.map((c) => ({ chunkIndex: c.chunkIndex, content: c.content })),
    };
  }

  // list mode
  const conditions = [
    eq(documents.tenantId, ctx.tenantId),
    eq(documents.knowledgeBaseId, kb.id),
    eq(documents.archived, false),
  ];
  const pathFilter = args.path ?? '*';
  if (pathFilter && pathFilter !== '*') {
    conditions.push(like(documents.path, pathFilter.replace('*', '%')));
  }
  const kindFilter = args.kind ?? 'any';
  if (kindFilter !== 'any') {
    conditions.push(eq(documents.kind, kindFilter));
  }

  const docs = await ctx.trail.db
    .select({
      filename: documents.filename,
      path: documents.path,
      title: documents.title,
      kind: documents.kind,
      fileType: documents.fileType,
      status: documents.status,
      seq: documents.seq,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(and(...conditions))
    .orderBy(documents.path, documents.filename)
    .all();

  return {
    ok: true,
    mode: 'list',
    kbName: kb.name,
    kbId: kb.id,
    docs: docs.map((d) => ({
      ...d,
      seqId: formatSeqId(kb.name, d.seq),
    })),
  };
}

// ── read ────────────────────────────────────────────────────────────────

export interface ReadArgs {
  knowledge_base?: string;
  /** Full path (e.g. /neurons/foo.md) or glob (e.g. /neurons/*.md) */
  path: string;
}

export interface ReadDocHit {
  documentId: string;
  path: string;
  filename: string;
  title: string | null;
  seq: number | null;
  /** F145 formatted handle; null when seq absent. */
  seqId: string | null;
  content: string;
}

export type ReadResult =
  | { ok: false; error: 'kb-not-found'; kbInput: string | undefined }
  | { ok: false; error: 'not-found'; pathArg: string; kbName: string }
  | { ok: true; kind: 'single'; kbName: string; doc: ReadDocHit }
  | { ok: true; kind: 'glob'; kbName: string; docs: ReadDocHit[]; truncatedAt: number | null };

export async function read(
  ctx: CandidateQueueContext,
  args: ReadArgs,
): Promise<ReadResult> {
  const kb = await resolveKB(ctx, args.knowledge_base);
  if (!kb) return { ok: false, error: 'kb-not-found', kbInput: args.knowledge_base };

  const isGlob = args.path.includes('*') || args.path.includes('?');

  if (isGlob) {
    const lastSlash = args.path.lastIndexOf('/');
    const dirPath = args.path.slice(0, lastSlash + 1) || '/';
    const filePattern = args.path.slice(lastSlash + 1);

    const rows = await ctx.trail.db
      .select({
        id: documents.id,
        filename: documents.filename,
        path: documents.path,
        title: documents.title,
        content: documents.content,
        seq: documents.seq,
      })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, ctx.tenantId),
          eq(documents.knowledgeBaseId, kb.id),
          eq(documents.archived, false),
          like(documents.path, dirPath.replace('*', '%')),
        ),
      )
      .all();
    const filtered = rows.filter((d) => globMatch(d.filename, filePattern));

    const docs: ReadDocHit[] = [];
    let totalChars = 0;
    let truncatedAt: number | null = null;
    const MAX_CHARS = 120_000;
    for (const [i, d] of filtered.entries()) {
      const content = d.content ?? '';
      if (totalChars > MAX_CHARS) {
        truncatedAt = i;
        break;
      }
      docs.push({
        documentId: d.id,
        path: d.path,
        filename: d.filename,
        title: d.title,
        seq: d.seq,
        seqId: formatSeqId(kb.name, d.seq),
        content,
      });
      totalChars += content.length;
    }
    return { ok: true, kind: 'glob', kbName: kb.name, docs, truncatedAt };
  }

  const lastSlash = args.path.lastIndexOf('/');
  const dirPath = args.path.slice(0, lastSlash + 1) || '/';
  const filename = args.path.slice(lastSlash + 1);
  const doc = await ctx.trail.db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, ctx.tenantId),
        eq(documents.knowledgeBaseId, kb.id),
        eq(documents.archived, false),
        eq(documents.path, dirPath),
        eq(documents.filename, filename),
      ),
    )
    .get();
  if (!doc) return { ok: false, error: 'not-found', pathArg: args.path, kbName: kb.name };

  // F141 — record wiki-doc reads for rollup. 'service-ingest' excluded
  // because compiler reads cover every Neuron per ingest and would
  // dominate the rollup. Fire-and-forget.
  if (doc.kind === 'wiki' && ctx.userId !== 'service-ingest') {
    void ctx.trail.db
      .insert(documentAccess)
      .values({
        id: `acc_${crypto.randomUUID().slice(0, 12)}`,
        tenantId: ctx.tenantId,
        knowledgeBaseId: kb.id,
        documentId: doc.id,
        source: 'mcp',
        actorKind: 'llm',
      })
      .run()
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[candidate-api] access-track failed:', err instanceof Error ? err.message : err);
      });
  }

  return {
    ok: true,
    kind: 'single',
    kbName: kb.name,
    doc: {
      documentId: doc.id,
      path: doc.path,
      filename: doc.filename,
      title: doc.title,
      seq: doc.seq,
      seqId: formatSeqId(kb.name, doc.seq),
      content: doc.content ?? '',
    },
  };
}

// ── write ───────────────────────────────────────────────────────────────

export interface WriteArgs {
  knowledge_base?: string;
  command: 'create' | 'str_replace' | 'append';
  path?: string;  // default '/neurons/'
  title?: string;
  content?: string;
  tags?: string;
  old_text?: string;
  new_text?: string;
}

export type WriteResult =
  | { ok: false; error: 'kb-not-found'; kbInput: string | undefined }
  | { ok: false; error: 'title-required' }
  | { ok: false; error: 'locate-failed'; hint: string }
  | { ok: false; error: 'old-text-not-found'; target: string }
  | { ok: false; error: 'old-text-ambiguous'; target: string; occurrences: number }
  | { ok: false; error: 'doc-not-found'; target: string; kbName: string }
  | { ok: false; error: 'missing-fields'; hint: string }
  | { ok: false; error: 'unknown-command'; command: string }
  | {
      ok: true;
      command: 'create';
      approved: boolean;
      path: string;
      filename: string;
      title: string;
    }
  | {
      ok: true;
      command: 'str_replace' | 'append';
      approved: boolean;
      path: string;
      filename: string;
      newVersion: number;
    };

export async function write(
  ctx: CandidateQueueContext,
  args: WriteArgs,
): Promise<WriteResult> {
  const kb = await resolveKB(ctx, args.knowledge_base);
  if (!kb) return { ok: false, error: 'kb-not-found', kbInput: args.knowledge_base };

  const dirPath = args.path ?? '/neurons/';

  if (args.command === 'create') {
    if (!args.title) return { ok: false, error: 'title-required' };
    const filename = (slugify(args.title) || 'untitled') + '.md';
    const fullContent = args.content ?? `# ${args.title}\n`;
    const path = dirPath.endsWith('/') ? dirPath : dirPath + '/';

    const { approval } = await createCandidate(
      ctx.trail,
      ctx.tenantId,
      {
        knowledgeBaseId: kb.id,
        kind: 'ingest-summary',
        title: args.title,
        content: fullContent,
        metadata: JSON.stringify({
          op: 'create',
          filename,
          path,
          tags: args.tags ?? null,
          connector: ctx.connector,
          ingestJobId: ctx.ingestJobId,
        }),
        confidence: 1,
      },
      LLM_ACTOR(ctx.userId),
    );
    return {
      ok: true,
      command: 'create',
      approved: !!approval,
      path,
      filename,
      title: args.title,
    };
  }

  // str_replace + append share the "locate doc" logic
  const locate = (): { path: string; filename: string } | null => {
    if (!args.title) return null;
    const sp = args.title.slice(0, args.title.lastIndexOf('/') + 1) || dirPath;
    const sf = args.title.slice(args.title.lastIndexOf('/') + 1);
    if (!sf) return null;
    return { path: sp.endsWith('/') ? sp : sp + '/', filename: sf };
  };

  if (args.command === 'str_replace') {
    if (!args.old_text || args.new_text === undefined) {
      return { ok: false, error: 'missing-fields', hint: 'old_text and new_text required for str_replace' };
    }
    const loc = locate();
    if (!loc) return { ok: false, error: 'locate-failed', hint: 'Provide full document path as title (e.g. "/neurons/overview.md")' };

    const doc = await ctx.trail.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, ctx.tenantId),
          eq(documents.knowledgeBaseId, kb.id),
          eq(documents.archived, false),
          eq(documents.path, loc.path),
          eq(documents.filename, loc.filename),
        ),
      )
      .get();
    if (!doc) return { ok: false, error: 'doc-not-found', target: args.title!, kbName: kb.name };

    const current = doc.content ?? '';
    const occurrences = current.split(args.old_text).length - 1;
    if (occurrences === 0) return { ok: false, error: 'old-text-not-found', target: `${doc.path}${doc.filename}` };
    if (occurrences > 1) return { ok: false, error: 'old-text-ambiguous', target: `${doc.path}${doc.filename}`, occurrences };

    const updated = current.replace(args.old_text, args.new_text);
    const { approval } = await createCandidate(
      ctx.trail,
      ctx.tenantId,
      {
        knowledgeBaseId: kb.id,
        kind: 'ingest-page-update',
        title: doc.title ?? doc.filename,
        content: updated,
        metadata: JSON.stringify({
          op: 'update',
          targetDocumentId: doc.id,
          connector: ctx.connector,
          ingestJobId: ctx.ingestJobId,
        }),
        confidence: 1,
      },
      LLM_ACTOR(ctx.userId),
    );
    return {
      ok: true,
      command: 'str_replace',
      approved: !!approval,
      path: doc.path,
      filename: doc.filename,
      newVersion: doc.version + 1,
    };
  }

  if (args.command === 'append') {
    const loc = locate();
    if (!loc) return { ok: false, error: 'locate-failed', hint: 'Provide full document path as title (e.g. "/neurons/log.md")' };

    const doc = await ctx.trail.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, ctx.tenantId),
          eq(documents.knowledgeBaseId, kb.id),
          eq(documents.archived, false),
          eq(documents.path, loc.path),
          eq(documents.filename, loc.filename),
        ),
      )
      .get();
    if (!doc) return { ok: false, error: 'doc-not-found', target: args.title!, kbName: kb.name };

    const updated = (doc.content ?? '') + '\n' + (args.content ?? '');
    const { approval } = await createCandidate(
      ctx.trail,
      ctx.tenantId,
      {
        knowledgeBaseId: kb.id,
        kind: 'ingest-page-update',
        title: doc.title ?? doc.filename,
        content: updated,
        metadata: JSON.stringify({
          op: 'update',
          targetDocumentId: doc.id,
          connector: ctx.connector,
          ingestJobId: ctx.ingestJobId,
        }),
        confidence: 1,
      },
      LLM_ACTOR(ctx.userId),
    );
    return {
      ok: true,
      command: 'append',
      approved: !!approval,
      path: doc.path,
      filename: doc.filename,
      newVersion: doc.version + 1,
    };
  }

  return { ok: false, error: 'unknown-command', command: args.command };
}

// ── Factory: one API object with bound context ─────────────────────────

export interface CandidateQueueAPI {
  guide(): Promise<GuideResult>;
  search(args: SearchArgs): Promise<SearchResult>;
  read(args: ReadArgs): Promise<ReadResult>;
  write(args: WriteArgs): Promise<WriteResult>;
}

export function createCandidateQueueAPI(ctx: CandidateQueueContext): CandidateQueueAPI {
  return {
    guide: () => guide(ctx),
    search: (args) => search(ctx, args),
    read: (args) => read(ctx, args),
    write: (args) => write(ctx, args),
  };
}
