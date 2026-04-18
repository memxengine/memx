import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  createLibsqlDatabase,
  DEFAULT_DB_PATH,
  knowledgeBases,
  documents,
  queueCandidates,
  wikiEvents,
  tenants,
  users,
  type TrailDatabase,
} from '@trail/db';
import { eq, and, like, sql, desc } from 'drizzle-orm';
import { createCandidate, slugify } from '@trail/core';

// MCP-initiated wiki mutations flow through the Curation Queue. The server's
// auto-approval policy (see @trail/core shouldAutoApprove) fires for LLM-actor
// candidates with ingest-originated kinds, so user-visible latency is unchanged
// but every write is audited and reversible.
const LLM_ACTOR = (userId: string) => ({ id: userId, kind: 'llm' as const });

// F40.1: the MCP server owns its own TrailDatabase instance, opened at boot.
// F40.2 will resolve `trail` per invocation based on the authenticated tenant
// injected via env — the tools here already receive it as a closure parameter,
// so that change will not require handler changes.
const trail = await createLibsqlDatabase({ path: DEFAULT_DB_PATH });
await trail.runMigrations();
await trail.initFTS();

const server = new McpServer({
  name: 'trail',
  version: '0.0.1',
});

// Context is injected via env when apps/server spawns the MCP for an ingest run.
// For interactive use (Christian curating via `cc`), the env is set manually.
const TENANT_ID = process.env.TRAIL_TENANT_ID ?? '';
const DEFAULT_KB_ID = process.env.TRAIL_KNOWLEDGE_BASE_ID ?? '';
const ACTOR_USER_ID = process.env.TRAIL_USER_ID ?? '';
// Each candidate emitted via this MCP server is tagged with a connector
// id in metadata — surfaces in the admin Queue filter and Neuron
// attribution panel. Set by the client's .mcp.json env config:
//   Claude Code → TRAIL_CONNECTOR=mcp:claude-code
//   Cursor      → TRAIL_CONNECTOR=mcp:cursor
//   apps/server ingest subprocess → TRAIL_CONNECTOR=upload
//   unset       → 'mcp' (generic fallback)
const CONNECTOR_ID = process.env.TRAIL_CONNECTOR ?? 'mcp';

interface ResolvedContext {
  tenantId: string;
  tenantName: string;
  userId: string;
}

async function requireContext(trail: TrailDatabase): Promise<ResolvedContext> {
  if (!TENANT_ID) {
    throw new Error(
      'MCP server needs TRAIL_TENANT_ID in the environment. ' +
        'Set it to the tenant ID you want to operate against (see `SELECT id FROM tenants` in the DB).',
    );
  }
  const tenant = await trail.db.select().from(tenants).where(eq(tenants.id, TENANT_ID)).get();
  if (!tenant) throw new Error(`Tenant ${TENANT_ID} not found.`);

  let userId = ACTOR_USER_ID;
  if (!userId) {
    // Fall back to the tenant's first owner; fail if there isn't one.
    const owner = await trail.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, TENANT_ID), eq(users.role, 'owner')))
      .get();
    if (!owner) {
      throw new Error(
        `No user found for tenant ${tenant.name}. Set TRAIL_USER_ID or create an owner first.`,
      );
    }
    userId = owner.id;
  }
  return { tenantId: tenant.id, tenantName: tenant.name, userId };
}

async function resolveKB(trail: TrailDatabase, nameOrSlug: string | undefined, tenantId: string) {
  const needle = nameOrSlug?.trim();
  if (!needle) {
    if (!DEFAULT_KB_ID) return null;
    return trail.db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, DEFAULT_KB_ID), eq(knowledgeBases.tenantId, tenantId)))
      .get();
  }
  return (
    (await trail.db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.slug, needle), eq(knowledgeBases.tenantId, tenantId)))
      .get()) ??
    (await trail.db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.name, needle), eq(knowledgeBases.tenantId, tenantId)))
      .get()) ??
    (await trail.db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, needle), eq(knowledgeBases.tenantId, tenantId)))
      .get())
  );
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

// ── guide ──────────────────────────────────────────────────────────────────────
server.tool('guide', 'List knowledge bases and explain how trail works', {}, async () => {
  const ctx = await requireContext(trail);

  const result = await trail.execute(GUIDE_KBS_SQL, [ctx.tenantId]);
  const kbs = result.rows as Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    sourceCount: number;
    wikiPageCount: number;
  }>;

  let text = `# trail — How It Works

You maintain a persistent, compounding knowledge base. Three layers:
1. **Sources** — immutable raw materials (PDFs, articles, notes)
2. **Wiki** — LLM-compiled markdown pages at \`/neurons/\` (summaries, entity + concept pages, cross-references with [[wiki-links]])
3. **Schema** — conventions guiding the compiler

## Operations
- **Ingest**: Read a source → search wiki → create/update pages → append to log
- **Query**: Search wiki → synthesize answer with citations
- **Curate**: Review queue candidates (chat answers, auto-summaries) → approve → compile back
- **Lint**: Health-check for contradictions, orphans, missing cross-references

## Tools
- \`guide\` — this message
- \`search\` — browse (list mode) or FTS (search mode) a KB
- \`read\` — fetch a single doc or a glob pattern
- \`write\` — create / str_replace / append on a wiki page
- \`delete\` — soft-archive a doc

## Knowledge bases for ${ctx.tenantName}
`;

  if (kbs.length === 0) {
    text += '\nNo knowledge bases yet. Create one via the admin UI.\n';
  } else {
    for (const kb of kbs) {
      text += `\n- **${kb.name}** (\`${kb.slug}\`) — ${kb.sourceCount} sources, ${kb.wikiPageCount} wiki pages`;
      if (kb.description) text += `\n  ${kb.description}`;
    }
  }

  return { content: [{ type: 'text' as const, text }] };
});

// ── search ─────────────────────────────────────────────────────────────────────
server.tool(
  'search',
  'Browse or search documents in a knowledge base',
  {
    knowledge_base: z
      .string()
      .optional()
      .describe('Name, slug or id of the KB. Omit to use TRAIL_KNOWLEDGE_BASE_ID.'),
    mode: z.enum(['list', 'search']).default('list').describe('list = file tree, search = FTS'),
    query: z.string().optional().describe('Search query (required for search mode)'),
    path: z.string().default('*').describe('Path filter glob (e.g. "/neurons/*", "/")'),
    kind: z
      .enum(['source', 'wiki', 'any'])
      .default('any')
      .describe('Filter by document kind'),
  },
  async ({ knowledge_base, mode, query, path, kind }) => {
    const ctx = await requireContext(trail);
    const kb = await resolveKB(trail, knowledge_base, ctx.tenantId);
    if (!kb) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Knowledge base "${knowledge_base ?? '(default)'}" not found in tenant ${ctx.tenantName}.`,
          },
        ],
      };
    }

    if (mode === 'search') {
      if (!query?.trim()) {
        return { content: [{ type: 'text' as const, text: 'Search query required for search mode.' }] };
      }
      const ftsQuery = sanitizeFtsQuery(query);
      const docResults = ftsQuery
        ? await trail.searchDocuments(ftsQuery, kb.id, ctx.tenantId, 20)
        : [];
      const chunkResults = ftsQuery
        ? await trail.searchChunks(ftsQuery, kb.id, ctx.tenantId, 10)
        : [];

      let text = `## Search results for "${query}" in ${kb.name}\n\n`;
      if (docResults.length === 0 && chunkResults.length === 0) {
        text += 'No results found.\n';
      } else {
        text += `### Documents (${docResults.length})\n`;
        for (const r of docResults) {
          text += `- [${r.kind}] \`${r.path}${r.filename}\` — ${r.title ?? r.filename}\n`;
        }
        text += `\n### Chunks (${chunkResults.length})\n`;
        for (const c of chunkResults) {
          text += `- chunk #${c.chunkIndex}: ${c.content.slice(0, 200)}...\n`;
        }
      }
      return { content: [{ type: 'text' as const, text }] };
    }

    const conditions = [
      eq(documents.tenantId, ctx.tenantId),
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.archived, false),
    ];
    if (path && path !== '*') conditions.push(like(documents.path, path.replace('*', '%')));
    if (kind !== 'any') conditions.push(eq(documents.kind, kind));

    const docs = await trail.db
      .select({
        filename: documents.filename,
        path: documents.path,
        title: documents.title,
        kind: documents.kind,
        fileType: documents.fileType,
        status: documents.status,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(and(...conditions))
      .orderBy(documents.path, documents.filename)
      .all();

    let text = `## ${kb.name} — ${docs.length} documents\n\n`;
    for (const doc of docs) {
      const statusIcon = doc.status === 'ready' ? '✓' : doc.status === 'processing' ? '⏳' : '•';
      text += `${statusIcon} [${doc.kind}] \`${doc.path}${doc.filename}\` — ${doc.title ?? doc.filename} (${doc.fileType})\n`;
    }
    return { content: [{ type: 'text' as const, text }] };
  },
);

// ── read ───────────────────────────────────────────────────────────────────────
server.tool(
  'read',
  'Read document content from a knowledge base',
  {
    knowledge_base: z.string().optional().describe('Name, slug or id of the KB'),
    path: z
      .string()
      .describe('Full path to document (e.g. "/neurons/overview.md") or glob (e.g. "/neurons/*.md")'),
  },
  async ({ knowledge_base, path: docPath }) => {
    const ctx = await requireContext(trail);
    const kb = await resolveKB(trail, knowledge_base, ctx.tenantId);
    if (!kb) {
      return {
        content: [
          { type: 'text' as const, text: `KB "${knowledge_base ?? '(default)'}" not found.` },
        ],
      };
    }

    const isGlob = docPath.includes('*') || docPath.includes('?');

    if (isGlob) {
      const lastSlash = docPath.lastIndexOf('/');
      const dirPath = docPath.slice(0, lastSlash + 1) || '/';
      const filePattern = docPath.slice(lastSlash + 1);

      const docs = (await trail.db
        .select({
          id: documents.id,
          filename: documents.filename,
          path: documents.path,
          title: documents.title,
          content: documents.content,
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
        .all()).filter((d) => globMatch(d.filename, filePattern));

      let text = '';
      let totalChars = 0;
      const MAX_CHARS = 120_000;
      for (const doc of docs) {
        if (totalChars > MAX_CHARS) {
          text += `\n\n---\n_Truncated: ${docs.length - docs.indexOf(doc)} more documents not shown._\n`;
          break;
        }
        text += `\n\n---\n## ${doc.path}${doc.filename}\n\n`;
        const content = doc.content ?? '_No content_';
        text += content;
        totalChars += content.length;
      }
      if (docs.length === 0) text = `No documents match "${docPath}" in ${kb.name}.`;
      return { content: [{ type: 'text' as const, text }] };
    }

    const lastSlash = docPath.lastIndexOf('/');
    const dirPath = docPath.slice(0, lastSlash + 1) || '/';
    const filename = docPath.slice(lastSlash + 1);

    const doc = await trail.db
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

    if (!doc) {
      return {
        content: [{ type: 'text' as const, text: `Document "${docPath}" not found in ${kb.name}.` }],
      };
    }
    return { content: [{ type: 'text' as const, text: doc.content ?? '_No content_' }] };
  },
);

// ── write ──────────────────────────────────────────────────────────────────────
server.tool(
  'write',
  'Create or edit wiki pages in a knowledge base',
  {
    knowledge_base: z.string().optional().describe('Name, slug or id of the KB'),
    command: z
      .enum(['create', 'str_replace', 'append'])
      .describe('create = new wiki page, str_replace = find/replace, append = add to end'),
    path: z.string().default('/neurons/').describe('Directory path (e.g. "/neurons/", "/neurons/concepts/")'),
    title: z
      .string()
      .optional()
      .describe(
        'For create: the page title. For str_replace/append: the full document path (e.g. "/neurons/overview.md").',
      ),
    content: z.string().optional().describe('Content for create or append'),
    tags: z.string().optional().describe('Comma-separated tags'),
    old_text: z.string().optional().describe('Text to find (for str_replace)'),
    new_text: z.string().optional().describe('Replacement text (for str_replace)'),
  },
  async ({ knowledge_base, command, path: dirPath, title, content, tags, old_text, new_text }) => {
    const ctx = await requireContext(trail);
    const kb = await resolveKB(trail, knowledge_base, ctx.tenantId);
    if (!kb) {
      return {
        content: [
          { type: 'text' as const, text: `KB "${knowledge_base ?? '(default)'}" not found.` },
        ],
      };
    }

    if (command === 'create') {
      if (!title) return { content: [{ type: 'text' as const, text: 'Title required for create.' }] };

      const filename = (slugify(title) || 'untitled') + '.md';
      const fullContent = content ?? `# ${title}\n`;
      const path = dirPath.endsWith('/') ? dirPath : dirPath + '/';

      const { approval } = await createCandidate(
        trail,
        ctx.tenantId,
        {
          knowledgeBaseId: kb.id,
          kind: 'ingest-summary',
          title,
          content: fullContent,
          metadata: JSON.stringify({ op: 'create', filename, path, tags: tags ?? null, connector: CONNECTOR_ID }),
          confidence: 1,
        },
        LLM_ACTOR(ctx.userId),
      );

      if (!approval) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Candidate queued for curator review (auto-approval policy did not fire).`,
            },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Created \`${path}${filename}\` — "${title}"` }],
      };
    }

    const locate = (): { path: string; filename: string } | null => {
      if (!title) return null;
      const sp = title.slice(0, title.lastIndexOf('/') + 1) || dirPath;
      const sf = title.slice(title.lastIndexOf('/') + 1);
      if (!sf) return null;
      return { path: sp.endsWith('/') ? sp : sp + '/', filename: sf };
    };

    if (command === 'str_replace') {
      if (!old_text || new_text === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'old_text and new_text required for str_replace.' }],
        };
      }
      const loc = locate();
      if (!loc) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Provide the full document path as `title` (e.g. "/neurons/overview.md").',
            },
          ],
        };
      }

      const doc = await trail.db
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

      if (!doc) {
        return { content: [{ type: 'text' as const, text: `Document "${title}" not found.` }] };
      }

      const current = doc.content ?? '';
      const occurrences = current.split(old_text).length - 1;
      if (occurrences === 0) {
        return {
          content: [{ type: 'text' as const, text: `old_text not found in ${doc.path}${doc.filename}.` }],
        };
      }
      if (occurrences > 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `old_text found ${occurrences} times — must be unique. Add more surrounding context.`,
            },
          ],
        };
      }

      const updated = current.replace(old_text, new_text);
      const { approval } = await createCandidate(
        trail,
        ctx.tenantId,
        {
          knowledgeBaseId: kb.id,
          kind: 'ingest-page-update',
          title: doc.title ?? doc.filename,
          content: updated,
          metadata: JSON.stringify({ op: 'update', targetDocumentId: doc.id, connector: CONNECTOR_ID }),
          confidence: 1,
        },
        LLM_ACTOR(ctx.userId),
      );
      if (!approval) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Update queued for curator review on ${doc.path}${doc.filename}.`,
            },
          ],
        };
      }
      return {
        content: [
          { type: 'text' as const, text: `Updated \`${doc.path}${doc.filename}\` (v${doc.version + 1})` },
        ],
      };
    }

    if (command === 'append') {
      const loc = locate();
      if (!loc) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Provide the full document path as `title` (e.g. "/neurons/log.md").',
            },
          ],
        };
      }

      const doc = await trail.db
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

      if (!doc) {
        return { content: [{ type: 'text' as const, text: `Document "${title}" not found.` }] };
      }

      const updated = (doc.content ?? '') + '\n' + (content ?? '');
      const { approval } = await createCandidate(
        trail,
        ctx.tenantId,
        {
          knowledgeBaseId: kb.id,
          kind: 'ingest-page-update',
          title: doc.title ?? doc.filename,
          content: updated,
          metadata: JSON.stringify({ op: 'update', targetDocumentId: doc.id, connector: CONNECTOR_ID }),
          confidence: 1,
        },
        LLM_ACTOR(ctx.userId),
      );
      if (!approval) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Append queued for curator review on ${doc.path}${doc.filename}.`,
            },
          ],
        };
      }
      return {
        content: [
          { type: 'text' as const, text: `Appended to \`${doc.path}${doc.filename}\` (v${doc.version + 1})` },
        ],
      };
    }

    return { content: [{ type: 'text' as const, text: `Unknown command: ${command}` }] };
  },
);

// ── delete ─────────────────────────────────────────────────────────────────────
server.tool(
  'delete',
  'Archive documents (soft delete)',
  {
    knowledge_base: z.string().optional().describe('Name, slug or id of the KB'),
    path: z.string().describe('Full path to document (e.g. "/neurons/old.md")'),
  },
  async ({ knowledge_base, path: docPath }) => {
    const ctx = await requireContext(trail);
    const kb = await resolveKB(trail, knowledge_base, ctx.tenantId);
    if (!kb) {
      return {
        content: [
          { type: 'text' as const, text: `KB "${knowledge_base ?? '(default)'}" not found.` },
        ],
      };
    }

    if (docPath === '/neurons/overview.md' || docPath === '/neurons/log.md') {
      return {
        content: [{ type: 'text' as const, text: `Cannot delete ${docPath} — it's a protected wiki page.` }],
      };
    }

    const lastSlash = docPath.lastIndexOf('/');
    const dirPath = docPath.slice(0, lastSlash + 1) || '/';
    const filename = docPath.slice(lastSlash + 1);

    const doc = await trail.db
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

    if (!doc) {
      return { content: [{ type: 'text' as const, text: `Document "${docPath}" not found.` }] };
    }

    const { approval } = await createCandidate(
      trail,
      ctx.tenantId,
      {
        knowledgeBaseId: kb.id,
        kind: 'source-retraction',
        title: doc.title ?? doc.filename,
        content: `Archived via MCP: ${docPath}`,
        metadata: JSON.stringify({ op: 'archive', targetDocumentId: doc.id, connector: CONNECTOR_ID }),
        confidence: 1,
      },
      LLM_ACTOR(ctx.userId),
    );
    if (!approval) {
      return {
        content: [
          { type: 'text' as const, text: `Archive of ${docPath} queued for curator review.` },
        ],
      };
    }
    return { content: [{ type: 'text' as const, text: `Archived \`${docPath}\`` }] };
  },
);

// ── F89 read-only introspection tools ─────────────────────────────────────────
// These answer structural questions Claude can't resolve from content alone:
// "hvor mange Neurons?", "hvad er der i køen?", "hvad er lavet for nyligt?".
// All five take an optional knowledge_base arg, fall back to TRAIL_KNOWLEDGE_BASE_ID.
// Every handler returns compact text so the chat LLM can read it in a single turn.

server.tool(
  'count_neurons',
  'Count wiki pages (Neurons) in a knowledge base, optionally filtered by path prefix or tag',
  {
    knowledge_base: z.string().optional().describe('Name, slug or id of the KB'),
    path_prefix: z
      .string()
      .optional()
      .describe('Only count Neurons whose path starts with this (e.g. "/neurons/concepts/")'),
    tag: z.string().optional().describe('Only count Neurons tagged with this'),
  },
  async ({ knowledge_base, path_prefix, tag }) => {
    const ctx = await requireContext(trail);
    const kb = await resolveKB(trail, knowledge_base, ctx.tenantId);
    if (!kb) {
      return {
        content: [{ type: 'text' as const, text: `KB "${knowledge_base ?? '(default)'}" not found.` }],
      };
    }
    const conds = [
      eq(documents.tenantId, ctx.tenantId),
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.kind, 'wiki'),
      eq(documents.archived, false),
    ];
    if (path_prefix) conds.push(like(documents.path, `${path_prefix}%`));
    if (tag) conds.push(like(documents.tags, `%${tag}%`));
    const row = await trail.db
      .select({ c: sql<number>`count(*)` })
      .from(documents)
      .where(and(...conds))
      .get();
    const count = row?.c ?? 0;
    const filters = [
      path_prefix ? `path_prefix="${path_prefix}"` : null,
      tag ? `tag="${tag}"` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const text = `${kb.name}: ${count} Neuron${count === 1 ? '' : 's'}${filters ? ` (${filters})` : ''}.`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'count_sources',
  'Count Source documents in a knowledge base, optionally filtered by file type',
  {
    knowledge_base: z.string().optional().describe('Name, slug or id of the KB'),
    file_type: z.string().optional().describe('Filter by extension (e.g. "pdf", "docx", "md")'),
  },
  async ({ knowledge_base, file_type }) => {
    const ctx = await requireContext(trail);
    const kb = await resolveKB(trail, knowledge_base, ctx.tenantId);
    if (!kb) {
      return {
        content: [{ type: 'text' as const, text: `KB "${knowledge_base ?? '(default)'}" not found.` }],
      };
    }
    const conds = [
      eq(documents.tenantId, ctx.tenantId),
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.kind, 'source'),
      eq(documents.archived, false),
    ];
    if (file_type) conds.push(eq(documents.fileType, file_type.toLowerCase()));
    const row = await trail.db
      .select({ c: sql<number>`count(*)` })
      .from(documents)
      .where(and(...conds))
      .get();
    const count = row?.c ?? 0;
    const filters = file_type ? ` (file_type="${file_type}")` : '';
    const text = `${kb.name}: ${count} source${count === 1 ? '' : 's'}${filters}.`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'queue_summary',
  'Summarize the Curation Queue for a knowledge base: pending/approved/rejected counts, plus breakdown by kind',
  {
    knowledge_base: z.string().optional().describe('Name, slug or id of the KB'),
  },
  async ({ knowledge_base }) => {
    const ctx = await requireContext(trail);
    const kb = await resolveKB(trail, knowledge_base, ctx.tenantId);
    if (!kb) {
      return {
        content: [{ type: 'text' as const, text: `KB "${knowledge_base ?? '(default)'}" not found.` }],
      };
    }
    const rows = await trail.db
      .select({
        status: queueCandidates.status,
        kind: queueCandidates.kind,
        c: sql<number>`count(*)`,
      })
      .from(queueCandidates)
      .where(
        and(
          eq(queueCandidates.tenantId, ctx.tenantId),
          eq(queueCandidates.knowledgeBaseId, kb.id),
        ),
      )
      .groupBy(queueCandidates.status, queueCandidates.kind)
      .all();

    const byStatus = { pending: 0, approved: 0, rejected: 0, ingested: 0 } as Record<string, number>;
    const byKind = new Map<string, number>();
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + r.c;
      byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + r.c);
    }

    let text = `## Queue for ${kb.name}\n\n`;
    text += `- pending: **${byStatus.pending}**\n`;
    text += `- approved: ${byStatus.approved}\n`;
    text += `- rejected: ${byStatus.rejected}\n`;
    text += `- ingested: ${byStatus.ingested}\n`;
    if (byKind.size > 0) {
      text += `\n### By kind\n`;
      for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
        text += `- ${k}: ${n}\n`;
      }
    }
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'recent_activity',
  'Show the last N wiki events (create/edit/archive/rename) with timestamps',
  {
    knowledge_base: z.string().optional().describe('Name, slug or id of the KB'),
    limit: z.number().int().min(1).max(50).default(10).describe('Max events to return (1-50)'),
  },
  async ({ knowledge_base, limit }) => {
    const ctx = await requireContext(trail);
    const kb = await resolveKB(trail, knowledge_base, ctx.tenantId);
    if (!kb) {
      return {
        content: [{ type: 'text' as const, text: `KB "${knowledge_base ?? '(default)'}" not found.` }],
      };
    }
    const rows = await trail.db
      .select({
        type: wikiEvents.eventType,
        actorKind: wikiEvents.actorKind,
        summary: wikiEvents.summary,
        createdAt: wikiEvents.createdAt,
        path: documents.path,
        filename: documents.filename,
        title: documents.title,
      })
      .from(wikiEvents)
      .innerJoin(documents, eq(documents.id, wikiEvents.documentId))
      .where(
        and(
          eq(wikiEvents.tenantId, ctx.tenantId),
          eq(documents.knowledgeBaseId, kb.id),
        ),
      )
      .orderBy(desc(wikiEvents.createdAt))
      .limit(limit)
      .all();
    if (rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `No wiki events yet in ${kb.name}.` }] };
    }
    let text = `## Recent activity in ${kb.name} (last ${rows.length})\n\n`;
    for (const r of rows) {
      const name = r.title ?? r.filename;
      text += `- **${r.createdAt}** [${r.type}] \`${r.path}${r.filename}\` — ${name} _(${r.actorKind})_`;
      if (r.summary) text += ` — ${r.summary}`;
      text += `\n`;
    }
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'trail_stats',
  'One-shot overview of a knowledge base: Neurons, Sources, queue, oldest/newest, total words',
  {
    knowledge_base: z.string().optional().describe('Name, slug or id of the KB'),
  },
  async ({ knowledge_base }) => {
    const ctx = await requireContext(trail);
    const kb = await resolveKB(trail, knowledge_base, ctx.tenantId);
    if (!kb) {
      return {
        content: [{ type: 'text' as const, text: `KB "${knowledge_base ?? '(default)'}" not found.` }],
      };
    }
    const kbWhere = and(
      eq(documents.tenantId, ctx.tenantId),
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.archived, false),
    );
    const [neurons, sources, pending, docDates] = await Promise.all([
      trail.db
        .select({ c: sql<number>`count(*)` })
        .from(documents)
        .where(and(kbWhere, eq(documents.kind, 'wiki')))
        .get(),
      trail.db
        .select({ c: sql<number>`count(*)` })
        .from(documents)
        .where(and(kbWhere, eq(documents.kind, 'source')))
        .get(),
      trail.db
        .select({ c: sql<number>`count(*)` })
        .from(queueCandidates)
        .where(
          and(
            eq(queueCandidates.tenantId, ctx.tenantId),
            eq(queueCandidates.knowledgeBaseId, kb.id),
            eq(queueCandidates.status, 'pending'),
          ),
        )
        .get(),
      trail.db
        .select({
          oldest: sql<string | null>`min(${documents.createdAt})`,
          newest: sql<string | null>`max(${documents.createdAt})`,
          // content can be null; coalesce to empty string so length(null) doesn't poison the sum
          totalChars: sql<number>`coalesce(sum(length(coalesce(${documents.content}, ''))), 0)`,
        })
        .from(documents)
        .where(and(kbWhere, eq(documents.kind, 'wiki')))
        .get(),
    ]);

    // Rough word count: total chars / 5. Good enough for an overview.
    const estWords = Math.round((docDates?.totalChars ?? 0) / 5);
    let text = `## ${kb.name}\n\n`;
    text += `- Neurons: **${neurons?.c ?? 0}**\n`;
    text += `- Sources: **${sources?.c ?? 0}**\n`;
    text += `- Pending queue: ${pending?.c ?? 0}\n`;
    text += `- Oldest Neuron: ${docDates?.oldest ?? '—'}\n`;
    text += `- Newest Neuron: ${docDates?.newest ?? '—'}\n`;
    text += `- Neuron content: ~${estWords.toLocaleString('en')} words\n`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

// ── helpers ────────────────────────────────────────────────────────────────────

function globMatch(filename: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  );
  return regex.test(filename);
}

function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return terms.join(' OR ');
}

// ── start ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Graceful shutdown — release the libSQL connection so the WAL file checkpoints
// cleanly when the parent (apps/server) kills the MCP subprocess at the end of
// an ingest run.
const shutdown = async () => {
  await trail.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('trail MCP error:', err);
  process.exit(1);
});
