import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  db,
  rawDb,
  knowledgeBases,
  documents,
  tenants,
  users,
  runMigrations,
  initFTS,
  searchDocuments,
  searchChunks,
} from '@trail/db';
import { eq, and, like } from 'drizzle-orm';
import { createCandidate, slugify } from '@trail/core';

// MCP-initiated wiki mutations flow through the Curation Queue. The server's
// auto-approval policy (see @trail/core shouldAutoApprove) fires for LLM-actor
// candidates with ingest-originated kinds, so user-visible latency is unchanged
// but every write is audited and reversible.
const LLM_ACTOR = (userId: string) => ({ id: userId, kind: 'llm' as const });

// Ensure DB is ready (MCP server may be spawned before or after apps/server).
runMigrations();
initFTS();

const server = new McpServer({
  name: 'trail',
  version: '0.0.1',
});

// Context is injected via env when apps/server spawns the MCP for an ingest run.
// For interactive use (Christian curating via `cc`), the env is set manually.
const TENANT_ID = process.env.TRAIL_TENANT_ID ?? '';
const DEFAULT_KB_ID = process.env.TRAIL_KNOWLEDGE_BASE_ID ?? '';
const ACTOR_USER_ID = process.env.TRAIL_USER_ID ?? '';

interface ResolvedContext {
  tenantId: string;
  tenantName: string;
  userId: string;
}

function requireContext(): ResolvedContext {
  if (!TENANT_ID) {
    throw new Error(
      'MCP server needs TRAIL_TENANT_ID in the environment. ' +
        'Set it to the tenant ID you want to operate against (see `SELECT id FROM tenants` in the DB).',
    );
  }
  const tenant = db.select().from(tenants).where(eq(tenants.id, TENANT_ID)).get();
  if (!tenant) throw new Error(`Tenant ${TENANT_ID} not found.`);

  let userId = ACTOR_USER_ID;
  if (!userId) {
    // Fall back to the tenant's first owner; fail if there isn't one.
    const owner = db
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

function resolveKB(nameOrSlug: string | undefined, tenantId: string) {
  const needle = nameOrSlug?.trim();
  if (!needle) {
    if (!DEFAULT_KB_ID) return null;
    return db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, DEFAULT_KB_ID), eq(knowledgeBases.tenantId, tenantId)))
      .get();
  }
  return (
    db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.slug, needle), eq(knowledgeBases.tenantId, tenantId)))
      .get() ??
    db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.name, needle), eq(knowledgeBases.tenantId, tenantId)))
      .get() ??
    db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, needle), eq(knowledgeBases.tenantId, tenantId)))
      .get()
  );
}

// ── guide ──────────────────────────────────────────────────────────────────────
server.tool('guide', 'List knowledge bases and explain how trail works', {}, () => {
  const ctx = requireContext();

  const kbs = rawDb
    .prepare(
      `SELECT kb.id, kb.name, kb.slug, kb.description,
              (SELECT COUNT(*) FROM documents d
                 WHERE d.knowledge_base_id = kb.id
                   AND d.kind = 'source'
                   AND d.archived = 0) AS sourceCount,
              (SELECT COUNT(*) FROM documents d
                 WHERE d.knowledge_base_id = kb.id
                   AND d.kind = 'wiki'
                   AND d.archived = 0) AS wikiPageCount
         FROM knowledge_bases kb
        WHERE kb.tenant_id = ?`,
    )
    .all(ctx.tenantId) as Array<{
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
2. **Wiki** — LLM-compiled markdown pages at \`/wiki/\` (summaries, entity + concept pages, cross-references with [[wiki-links]])
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
    path: z.string().default('*').describe('Path filter glob (e.g. "/wiki/*", "/")'),
    kind: z
      .enum(['source', 'wiki', 'any'])
      .default('any')
      .describe('Filter by document kind'),
  },
  ({ knowledge_base, mode, query, path, kind }) => {
    const ctx = requireContext();
    const kb = resolveKB(knowledge_base, ctx.tenantId);
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
      const docResults = ftsQuery ? searchDocuments(ftsQuery, kb.id, ctx.tenantId, 20) : [];
      const chunkResults = ftsQuery ? searchChunks(ftsQuery, kb.id, ctx.tenantId, 10) : [];

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

    const docs = db
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
      .describe('Full path to document (e.g. "/wiki/overview.md") or glob (e.g. "/wiki/*.md")'),
  },
  ({ knowledge_base, path: docPath }) => {
    const ctx = requireContext();
    const kb = resolveKB(knowledge_base, ctx.tenantId);
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

      const docs = db
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
        .all()
        .filter((d) => globMatch(d.filename, filePattern));

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

    const doc = db
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
    path: z.string().default('/wiki/').describe('Directory path (e.g. "/wiki/", "/wiki/concepts/")'),
    title: z
      .string()
      .optional()
      .describe(
        'For create: the page title. For str_replace/append: the full document path (e.g. "/wiki/overview.md").',
      ),
    content: z.string().optional().describe('Content for create or append'),
    tags: z.string().optional().describe('Comma-separated tags'),
    old_text: z.string().optional().describe('Text to find (for str_replace)'),
    new_text: z.string().optional().describe('Replacement text (for str_replace)'),
  },
  ({ knowledge_base, command, path: dirPath, title, content, tags, old_text, new_text }) => {
    const ctx = requireContext();
    const kb = resolveKB(knowledge_base, ctx.tenantId);
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

      const { approval } = createCandidate(
        ctx.tenantId,
        {
          knowledgeBaseId: kb.id,
          kind: 'ingest-summary',
          title,
          content: fullContent,
          metadata: JSON.stringify({ op: 'create', filename, path, tags: tags ?? null }),
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
              text: 'Provide the full document path as `title` (e.g. "/wiki/overview.md").',
            },
          ],
        };
      }

      const doc = db
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
      const { approval } = createCandidate(
        ctx.tenantId,
        {
          knowledgeBaseId: kb.id,
          kind: 'ingest-page-update',
          title: doc.title ?? doc.filename,
          content: updated,
          metadata: JSON.stringify({ op: 'update', targetDocumentId: doc.id }),
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
              text: 'Provide the full document path as `title` (e.g. "/wiki/log.md").',
            },
          ],
        };
      }

      const doc = db
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
      const { approval } = createCandidate(
        ctx.tenantId,
        {
          knowledgeBaseId: kb.id,
          kind: 'ingest-page-update',
          title: doc.title ?? doc.filename,
          content: updated,
          metadata: JSON.stringify({ op: 'update', targetDocumentId: doc.id }),
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
    path: z.string().describe('Full path to document (e.g. "/wiki/old.md")'),
  },
  ({ knowledge_base, path: docPath }) => {
    const ctx = requireContext();
    const kb = resolveKB(knowledge_base, ctx.tenantId);
    if (!kb) {
      return {
        content: [
          { type: 'text' as const, text: `KB "${knowledge_base ?? '(default)'}" not found.` },
        ],
      };
    }

    if (docPath === '/wiki/overview.md' || docPath === '/wiki/log.md') {
      return {
        content: [{ type: 'text' as const, text: `Cannot delete ${docPath} — it's a protected wiki page.` }],
      };
    }

    const lastSlash = docPath.lastIndexOf('/');
    const dirPath = docPath.slice(0, lastSlash + 1) || '/';
    const filename = docPath.slice(lastSlash + 1);

    const doc = db
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

    const { approval } = createCandidate(
      ctx.tenantId,
      {
        knowledgeBaseId: kb.id,
        kind: 'source-retraction',
        title: doc.title ?? doc.filename,
        content: `Archived via MCP: ${docPath}`,
        metadata: JSON.stringify({ op: 'archive', targetDocumentId: doc.id }),
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

// ── helpers ────────────────────────────────────────────────────────────────────
// slugify lives in @trail/core; see imports above.

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

main().catch((err) => {
  console.error('trail MCP error:', err);
  process.exit(1);
});
