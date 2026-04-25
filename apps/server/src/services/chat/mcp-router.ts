/**
 * F159 Phase 2 — In-process MCP-tool router.
 *
 * Equivalent re-implementation of the 8 read-only chat-allowed tools
 * from `apps/mcp/src/index.ts`, callable in-process so OpenRouter +
 * Claude-API backends can invoke them without spawning the MCP
 * subprocess (which would (a) need the MCP HTTP-stdio bridge and (b)
 * add 200-500ms per tool call). Same Drizzle queries, same output
 * format ({content:[{type:'text', text}]}).
 *
 * **TODO Phase 2b** — co-locate canonical handlers in
 * `packages/core/src/mcp-tools/` so this router + apps/mcp/src/index.ts
 * stop duplicating logic. Christian's resolved open question #1
 * mandates the lift; deferred from Phase 2a only because the
 * mechanical refactor of 8 handlers (~600 lines moved) is risky in the
 * same turn as introducing OpenRouter chat. Drift risk between the
 * two implementations is real — keep them logically equivalent until
 * the lift lands.
 *
 * Security:
 *   - Tenant context (`tenantId`, `knowledgeBaseId`, `userId`) is
 *     PASSED IN by the caller, never read from tool args. A model
 *     trying to override `knowledge_base` to another tenant's KB
 *     fails the resolveKB check (which scopes by tenantId).
 */

import {
  documents,
  knowledgeBases,
  queueCandidates,
  wikiEvents,
  type TrailDatabase,
} from '@trail/db';
import { and, eq, like, sql, desc } from 'drizzle-orm';
import { z } from 'zod';
import { formatSeqId } from '@trail/shared';

export interface ToolContext {
  trail: TrailDatabase;
  tenantId: string;
  /** The user's "current Trail" — used as default when the tool's
   *  `knowledge_base` arg is omitted. */
  defaultKbId: string;
  /** Tenant display name for human-readable error strings. */
  tenantName: string;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

// ── Internal helpers (mirror apps/mcp/src/index.ts) ───────────────────

async function resolveKB(
  trail: TrailDatabase,
  nameOrSlug: string | undefined,
  tenantId: string,
  defaultKbId: string,
) {
  const needle = nameOrSlug?.trim();
  if (!needle) {
    if (!defaultKbId) return null;
    return trail.db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, defaultKbId), eq(knowledgeBases.tenantId, tenantId)))
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

function sanitizeFtsQuery(raw: string): string {
  // Mirror MCP: drop FTS5 special chars, collapse whitespace.
  return raw
    .replace(/[^a-zA-Z0-9æøåÆØÅ\s\-_]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function notFoundResult(arg: string | undefined): ToolResult {
  return {
    content: [{ type: 'text', text: `KB "${arg ?? '(default)'}" not found.` }],
  };
}

// ── Tool definitions ──────────────────────────────────────────────────

const guideTool: ToolDefinition = {
  name: 'guide',
  description: 'List knowledge bases and explain how trail works',
  inputSchema: z.object({}),
  async handler(ctx) {
    const kbs = await ctx.trail.db
      .select({
        name: knowledgeBases.name,
        slug: knowledgeBases.slug,
        description: knowledgeBases.description,
      })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.tenantId, ctx.tenantId))
      .all();

    let text = `# trail — How It Works\n\n` +
      `You maintain a persistent, compounding knowledge base. Sources (raw uploads) → Neurons (LLM-compiled wiki pages) → Curator queue (human-approved). Cross-link Neurons with [[wiki-links]].\n\n` +
      `## Knowledge bases for ${ctx.tenantName}\n`;
    if (kbs.length === 0) {
      text += '\nNo knowledge bases yet. Create one via the admin UI.\n';
    } else {
      for (const kb of kbs) {
        text += `\n- **${kb.name}** (\`${kb.slug}\`)`;
        if (kb.description) text += ` — ${kb.description}`;
      }
    }
    return { content: [{ type: 'text', text }] };
  },
};

const searchTool: ToolDefinition = {
  name: 'search',
  description: 'Browse or search documents in a knowledge base',
  inputSchema: z.object({
    knowledge_base: z.string().optional(),
    mode: z.enum(['list', 'search']).default('list'),
    query: z.string().optional(),
    path: z.string().default('*'),
    kind: z.enum(['source', 'wiki', 'any']).default('any'),
  }),
  async handler(ctx, args) {
    const { knowledge_base, mode, query, path, kind } = args as {
      knowledge_base?: string;
      mode: 'list' | 'search';
      query?: string;
      path: string;
      kind: 'source' | 'wiki' | 'any';
    };
    const kb = await resolveKB(ctx.trail, knowledge_base, ctx.tenantId, ctx.defaultKbId);
    if (!kb) return notFoundResult(knowledge_base);

    if (mode === 'search') {
      if (!query?.trim()) {
        return { content: [{ type: 'text', text: 'Search query required for search mode.' }] };
      }
      const ftsQuery = sanitizeFtsQuery(query);
      const docResults = ftsQuery
        ? await ctx.trail.searchDocuments(ftsQuery, kb.id, ctx.tenantId, 20)
        : [];
      const chunkResults = ftsQuery
        ? await ctx.trail.searchChunks(ftsQuery, kb.id, ctx.tenantId, 10)
        : [];

      let text = `## Search results for "${query}" in ${kb.name}\n\n`;
      if (docResults.length === 0 && chunkResults.length === 0) {
        text += 'No results found.\n';
      } else {
        text += `### Documents (${docResults.length})\n`;
        for (const r of docResults) {
          const seqId = formatSeqId(kb.name, r.seq);
          const prefix = seqId ? `\`${seqId}\` ` : '';
          text += `- ${prefix}[${r.kind}] \`${r.path}${r.filename}\` — ${r.title ?? r.filename}\n`;
        }
        text += `\n### Chunks (${chunkResults.length})\n`;
        for (const c of chunkResults) {
          text += `- chunk #${c.chunkIndex}: ${c.content.slice(0, 200)}...\n`;
        }
      }
      return { content: [{ type: 'text', text }] };
    }

    // List mode
    const conditions = [
      eq(documents.tenantId, ctx.tenantId),
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.archived, false),
    ];
    if (path && path !== '*') conditions.push(like(documents.path, path.replace('*', '%')));
    if (kind !== 'any') conditions.push(eq(documents.kind, kind));

    const docs = await ctx.trail.db
      .select({
        filename: documents.filename,
        path: documents.path,
        title: documents.title,
        kind: documents.kind,
        fileType: documents.fileType,
        status: documents.status,
        seq: documents.seq,
      })
      .from(documents)
      .where(and(...conditions))
      .orderBy(documents.path, documents.filename)
      .all();

    let text = `## ${kb.name} — ${docs.length} documents\n\n`;
    for (const doc of docs) {
      const statusIcon = doc.status === 'ready' ? '✓' : doc.status === 'processing' ? '⏳' : '•';
      const seqId = formatSeqId(kb.name, doc.seq);
      const prefix = seqId ? `\`${seqId}\` ` : '';
      text += `${statusIcon} ${prefix}[${doc.kind}] \`${doc.path}${doc.filename}\` — ${doc.title ?? doc.filename} (${doc.fileType})\n`;
    }
    return { content: [{ type: 'text', text }] };
  },
};

const readTool: ToolDefinition = {
  name: 'read',
  description: 'Read document content from a knowledge base by full path',
  inputSchema: z.object({
    knowledge_base: z.string().optional(),
    path: z.string().describe('Full path including filename, e.g. "/neurons/overview.md"'),
  }),
  async handler(ctx, args) {
    const { knowledge_base, path: docPath } = args as { knowledge_base?: string; path: string };
    const kb = await resolveKB(ctx.trail, knowledge_base, ctx.tenantId, ctx.defaultKbId);
    if (!kb) return notFoundResult(knowledge_base);

    const lastSlash = docPath.lastIndexOf('/');
    if (lastSlash === -1) {
      return { content: [{ type: 'text', text: `Path "${docPath}" must include directory.` }] };
    }
    const dirPath = docPath.slice(0, lastSlash + 1);
    const filename = docPath.slice(lastSlash + 1);

    const doc = await ctx.trail.db
      .select({
        title: documents.title,
        path: documents.path,
        filename: documents.filename,
        content: documents.content,
        kind: documents.kind,
        seq: documents.seq,
      })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, ctx.tenantId),
          eq(documents.knowledgeBaseId, kb.id),
          eq(documents.path, dirPath),
          eq(documents.filename, filename),
          eq(documents.archived, false),
        ),
      )
      .get();
    if (!doc) {
      return { content: [{ type: 'text', text: `Document "${docPath}" not found in ${kb.name}.` }] };
    }
    const seqId = formatSeqId(kb.name, doc.seq);
    const prefix = seqId ? `\`${seqId}\` ` : '';
    const text = `## ${prefix}${doc.title ?? doc.filename}\n_${doc.path}${doc.filename}_\n\n${doc.content ?? '(empty)'}`;
    return { content: [{ type: 'text', text }] };
  },
};

const countNeuronsTool: ToolDefinition = {
  name: 'count_neurons',
  description: 'Count wiki pages (Neurons) in a knowledge base, optionally filtered',
  inputSchema: z.object({
    knowledge_base: z.string().optional(),
    path_prefix: z.string().optional(),
    tag: z.string().optional(),
  }),
  async handler(ctx, args) {
    const { knowledge_base, path_prefix, tag } = args as {
      knowledge_base?: string;
      path_prefix?: string;
      tag?: string;
    };
    const kb = await resolveKB(ctx.trail, knowledge_base, ctx.tenantId, ctx.defaultKbId);
    if (!kb) return notFoundResult(knowledge_base);

    const conds = [
      eq(documents.tenantId, ctx.tenantId),
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.kind, 'wiki'),
      eq(documents.archived, false),
    ];
    if (path_prefix) conds.push(like(documents.path, `${path_prefix}%`));
    if (tag) conds.push(like(documents.tags, `%${tag}%`));

    const row = await ctx.trail.db
      .select({ c: sql<number>`count(*)` })
      .from(documents)
      .where(and(...conds))
      .get();
    const count = row?.c ?? 0;
    const filters = [
      path_prefix ? `path_prefix="${path_prefix}"` : null,
      tag ? `tag="${tag}"` : null,
    ].filter(Boolean).join(', ');
    const text = `${kb.name}: ${count} Neuron${count === 1 ? '' : 's'}${filters ? ` (${filters})` : ''}.`;
    return { content: [{ type: 'text', text }] };
  },
};

const countSourcesTool: ToolDefinition = {
  name: 'count_sources',
  description: 'Count Source documents in a knowledge base, optionally filtered by file type',
  inputSchema: z.object({
    knowledge_base: z.string().optional(),
    file_type: z.string().optional(),
  }),
  async handler(ctx, args) {
    const { knowledge_base, file_type } = args as { knowledge_base?: string; file_type?: string };
    const kb = await resolveKB(ctx.trail, knowledge_base, ctx.tenantId, ctx.defaultKbId);
    if (!kb) return notFoundResult(knowledge_base);

    const conds = [
      eq(documents.tenantId, ctx.tenantId),
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.kind, 'source'),
      eq(documents.archived, false),
    ];
    if (file_type) conds.push(eq(documents.fileType, file_type.toLowerCase()));
    const row = await ctx.trail.db
      .select({ c: sql<number>`count(*)` })
      .from(documents)
      .where(and(...conds))
      .get();
    const count = row?.c ?? 0;
    const filters = file_type ? ` (file_type="${file_type}")` : '';
    const text = `${kb.name}: ${count} source${count === 1 ? '' : 's'}${filters}.`;
    return { content: [{ type: 'text', text }] };
  },
};

const queueSummaryTool: ToolDefinition = {
  name: 'queue_summary',
  description: 'Summarize the Curation Queue for a knowledge base: pending/approved/rejected/ingested counts + by kind',
  inputSchema: z.object({ knowledge_base: z.string().optional() }),
  async handler(ctx, args) {
    const { knowledge_base } = args as { knowledge_base?: string };
    const kb = await resolveKB(ctx.trail, knowledge_base, ctx.tenantId, ctx.defaultKbId);
    if (!kb) return notFoundResult(knowledge_base);

    const rows = await ctx.trail.db
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

    const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0, ingested: 0 };
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
    return { content: [{ type: 'text', text }] };
  },
};

const recentActivityTool: ToolDefinition = {
  name: 'recent_activity',
  description: 'Show the last N wiki events (create/edit/archive/rename) with timestamps',
  inputSchema: z.object({
    knowledge_base: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async handler(ctx, args) {
    const { knowledge_base, limit } = args as { knowledge_base?: string; limit: number };
    const kb = await resolveKB(ctx.trail, knowledge_base, ctx.tenantId, ctx.defaultKbId);
    if (!kb) return notFoundResult(knowledge_base);

    const rows = await ctx.trail.db
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
      return { content: [{ type: 'text', text: `No wiki events yet in ${kb.name}.` }] };
    }
    let text = `## Recent activity in ${kb.name} (last ${rows.length})\n\n`;
    for (const r of rows) {
      const name = r.title ?? r.filename;
      text += `- **${r.createdAt}** [${r.type}] \`${r.path}${r.filename}\` — ${name} _(${r.actorKind})_`;
      if (r.summary) text += ` — ${r.summary}`;
      text += `\n`;
    }
    return { content: [{ type: 'text', text }] };
  },
};

const trailStatsTool: ToolDefinition = {
  name: 'trail_stats',
  description: 'One-shot overview: Neurons, Sources, queue, oldest/newest dates, total words',
  inputSchema: z.object({ knowledge_base: z.string().optional() }),
  async handler(ctx, args) {
    const { knowledge_base } = args as { knowledge_base?: string };
    const kb = await resolveKB(ctx.trail, knowledge_base, ctx.tenantId, ctx.defaultKbId);
    if (!kb) return notFoundResult(knowledge_base);

    const kbWhere = and(
      eq(documents.tenantId, ctx.tenantId),
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.archived, false),
    );
    const [neurons, sources, pending, dates] = await Promise.all([
      ctx.trail.db.select({ c: sql<number>`count(*)` }).from(documents)
        .where(and(kbWhere, eq(documents.kind, 'wiki'))).get(),
      ctx.trail.db.select({ c: sql<number>`count(*)` }).from(documents)
        .where(and(kbWhere, eq(documents.kind, 'source'))).get(),
      ctx.trail.db.select({ c: sql<number>`count(*)` }).from(queueCandidates)
        .where(and(
          eq(queueCandidates.tenantId, ctx.tenantId),
          eq(queueCandidates.knowledgeBaseId, kb.id),
          eq(queueCandidates.status, 'pending'),
        )).get(),
      ctx.trail.db.select({
        oldest: sql<string | null>`min(${documents.createdAt})`,
        newest: sql<string | null>`max(${documents.createdAt})`,
        totalChars: sql<number>`coalesce(sum(length(coalesce(${documents.content}, ''))), 0)`,
      }).from(documents).where(and(kbWhere, eq(documents.kind, 'wiki'))).get(),
    ]);

    const estWords = Math.round((dates?.totalChars ?? 0) / 5);
    let text = `## ${kb.name}\n\n`;
    text += `- Neurons: **${neurons?.c ?? 0}**\n`;
    text += `- Sources: **${sources?.c ?? 0}**\n`;
    text += `- Pending queue: ${pending?.c ?? 0}\n`;
    text += `- Oldest Neuron: ${dates?.oldest ?? '—'}\n`;
    text += `- Newest Neuron: ${dates?.newest ?? '—'}\n`;
    text += `- Neuron content: ~${estWords.toLocaleString('en')} words\n`;
    return { content: [{ type: 'text', text }] };
  },
};

// ── Registry + dispatch ───────────────────────────────────────────────

/**
 * The 8 chat-allowed tools. Strict mapping: `mcp__trail__<name>` is
 * the wire format the chat backends use; `<name>` is what we register
 * here. The `mcp__trail__` prefix is a CLI/MCP-protocol convention —
 * stripped on dispatch.
 */
const TOOLS: ReadonlyArray<ToolDefinition> = [
  guideTool,
  searchTool,
  readTool,
  countNeuronsTool,
  countSourcesTool,
  queueSummaryTool,
  recentActivityTool,
  trailStatsTool,
];

const TOOL_BY_NAME = new Map<string, ToolDefinition>(TOOLS.map((t) => [t.name, t]));

/**
 * Convert MCP-prefixed tool name (`mcp__trail__count_neurons`) to bare
 * (`count_neurons`). Tolerates both forms — the chat backends use the
 * prefixed form because that's what `--allowedTools` expects.
 */
function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__trail__/, '');
}

/**
 * Dispatch a tool call from a chat backend. `toolName` may be either
 * `count_neurons` or `mcp__trail__count_neurons`; both resolve.
 *
 * Args from the LLM are validated against the tool's Zod schema; a
 * parse error returns a tool-result with a friendly text message
 * (instead of throwing) so the LLM can self-correct on the next turn.
 */
export async function invokeTrailMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const def = TOOL_BY_NAME.get(stripMcpPrefix(toolName));
  if (!def) {
    return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }] };
  }
  const parsed = def.inputSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { content: [{ type: 'text', text: `Invalid tool args for ${def.name}: ${issues}` }] };
  }
  return def.handler(ctx, parsed.data as Record<string, unknown>);
}

/**
 * Convert the 8 tool definitions to OpenAI-compatible `tools[]` array
 * shape that OpenRouter / Claude-API function-calling expects. Names
 * are emitted in the prefixed `mcp__trail__<name>` form so the chat
 * route's `CHAT_ALLOWED_TOOL_LIST` (also prefixed) matches 1:1.
 */
export function mcpToolsToFunctionSpecs(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: `mcp__trail__${t.name}`,
      description: t.description,
      parameters: zodToJsonSchema(t.inputSchema),
    },
  }));
}

/**
 * Tiny zod-to-OpenAI-JSON-Schema converter. We only use a subset of
 * Zod (string, number, enum, optional, default, describe) so a full
 * `zod-to-json-schema` dependency would be overkill.
 *
 * Output shape matches OpenAI's function-calling parameters:
 *   { type: 'object', properties: {...}, required: [...] }
 */
function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, zodField] of Object.entries(shape)) {
    const def = zodFieldToProperty(zodField as z.ZodTypeAny);
    properties[key] = def.property;
    if (def.required) required.push(key);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function zodFieldToProperty(field: z.ZodTypeAny): {
  property: Record<string, unknown>;
  required: boolean;
} {
  // Unwrap optional / default / describe layers.
  let inner = field;
  let optional = false;
  let description: string | undefined;
  let defaultValue: unknown;

  // Pull the description off whatever layer carries it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const desc = (field as any)._def?.description;
  if (typeof desc === 'string') description = desc;

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = (inner as any)._def;
    if (def?.typeName === 'ZodOptional') {
      optional = true;
      inner = def.innerType;
      continue;
    }
    if (def?.typeName === 'ZodDefault') {
      optional = true;
      defaultValue = def.defaultValue();
      inner = def.innerType;
      continue;
    }
    break;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const innerDef = (inner as any)._def;
  const typeName: string = innerDef?.typeName ?? 'ZodAny';

  let property: Record<string, unknown>;
  if (typeName === 'ZodString') {
    property = { type: 'string' };
  } else if (typeName === 'ZodNumber') {
    property = { type: 'number' };
  } else if (typeName === 'ZodBoolean') {
    property = { type: 'boolean' };
  } else if (typeName === 'ZodEnum') {
    property = { type: 'string', enum: innerDef.values as string[] };
  } else {
    property = { type: 'string' }; // fallback
  }

  if (description) property.description = description;
  if (defaultValue !== undefined) property.default = defaultValue;

  return { property, required: !optional };
}

/** Exported for tests. */
export const _internal = { TOOLS, stripMcpPrefix };
