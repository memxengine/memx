import { Hono } from 'hono';
import { knowledgeBases, type TrailDatabase } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import { spawnClaude, extractAssistantText } from '../services/claude.js';
import { ChatRequestSchema } from '@trail/shared';
import { resolveKbId } from '@trail/core';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const CHAT_MODEL = process.env.CHAT_MODEL ?? 'claude-haiku-4-5-20251001';
// Chat with tool use needs headroom. A typical turn does 0-2 tool calls +
// the final composition; bump to 60s default timeout, 5 max turns.
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS ?? 60_000);
const CHAT_MAX_TURNS = Number(process.env.CHAT_MAX_TURNS ?? 5);

// Resolve the trail MCP entrypoint from this file's location, not from
// `process.cwd()`. Early version did the latter and broke when the engine
// was launched via `bun run --cwd apps/server` (scripts/trail), because
// cwd then was apps/server — which doesn't contain apps/mcp. Claude spawned
// a nonexistent MCP, silently got no tools, and answered "sorry, tools
// unavailable". Resolving from __dirname makes the path correct regardless
// of how the engine was started.
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = resolve(THIS_DIR, '../../../../apps/mcp/src/index.ts');

// Whitelist of trail MCP tools the chat LLM is allowed to call. All
// read-only — write/delete stay out so chat never mutates state without
// going through the Queue.
const CHAT_ALLOWED_TOOLS = [
  'mcp__trail__guide',
  'mcp__trail__search',
  'mcp__trail__read',
  'mcp__trail__count_neurons',
  'mcp__trail__count_sources',
  'mcp__trail__queue_summary',
  'mcp__trail__recent_activity',
  'mcp__trail__trail_stats',
].join(',');

export const chatRoutes = new Hono();

chatRoutes.use('*', requireAuth);

chatRoutes.post('/chat', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const body = ChatRequestSchema.parse(await c.req.json());

  // F135 — accept slug or UUID in body.knowledgeBaseId. Resolve to
  // canonical UUID before any FK-scoped queries run.
  const resolvedKbId = body.knowledgeBaseId
    ? await resolveKbId(trail, tenant.id, body.knowledgeBaseId)
    : null;
  if (body.knowledgeBaseId && !resolvedKbId) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }

  // Scope to either a specific KB (validating it belongs to this tenant) or all
  // the tenant's KBs. The old code fetched by id alone without a tenant check,
  // which was fine single-tenant but dangerous when F40.2 lands — fixing now.
  const kbs = resolvedKbId
    ? await trail.db
        .select({ id: knowledgeBases.id, name: knowledgeBases.name })
        .from(knowledgeBases)
        .where(
          and(
            eq(knowledgeBases.id, resolvedKbId),
            eq(knowledgeBases.tenantId, tenant.id),
          ),
        )
        .all()
    : await trail.db
        .select({ id: knowledgeBases.id, name: knowledgeBases.name })
        .from(knowledgeBases)
        .where(eq(knowledgeBases.tenantId, tenant.id))
        .all();

  if (kbs.length === 0) {
    return c.json({
      answer: 'No knowledge bases found for this tenant. Create a wiki first and add sources.',
    });
  }

  const { context, citations } = await retrieveContext(
    trail,
    body.message,
    kbs.map((kb) => kb.id),
    tenant.id,
  );

  // F89 shift: tool-equipped chat doesn't need to refuse on empty context —
  // the LLM can now call search/count/queue_summary to answer metadata
  // questions even when FTS returns nothing. Context-less runs just get a
  // smaller system prompt.
  const hasContext = context.trim().length > 0;

  // Name the Trail the user is currently in so Claude doesn't pass a
  // guessed slug to tools. All structural tools accept an optional
  // knowledge_base arg, but when omitted they default to the Trail scoped
  // via env (TRAIL_KNOWLEDGE_BASE_ID) — which is always the *current* KB.
  const currentTrailName = kbs.length === 1 ? kbs[0]!.name : null;

  const systemPrompt = `You are a knowledgeable assistant with access to tools that query the user's Trail (knowledge base). Answer their question accurately.

${currentTrailName ? `## Current Trail\nThe user is currently viewing the Trail called **"${currentTrailName}"**. Always call tools WITHOUT a \`knowledge_base\` argument so they default to this Trail automatically.\n\n` : ''}${
  hasContext
    ? `## Wiki Context (from content search)\n${context}\n\n`
    : ''
}## Tools available
- **count_neurons / count_sources** — exact counts with optional filters
- **queue_summary** — curation queue state
- **trail_stats** — one-shot overview (Neurons, Sources, pending, oldest/newest)
- **recent_activity** — last N wiki events
- **search** — browse or FTS5 search wiki + sources
- **read** — fetch a specific document's full content

## Instructions
- Answer in the same language as the question
- For *structural* questions (counts, lists, queue state) call a tool — don't guess from context
- For *content* questions prefer the wiki context above; only call tools if the context doesn't cover it
- Be concise (max 300 words)
- Use **bold** for key terms
- Reference wiki pages with [[page-name]] links where relevant
- If tools and context both come up empty, say so honestly`;

  // Dev default: claude -p subprocess. Prod will flip to direct API once stable.
  if (ANTHROPIC_API_KEY && process.env.TRAIL_CHAT_BACKEND === 'api') {
    try {
      const answer = await callAnthropicAPI(systemPrompt, body.message);
      return c.json({ answer, citations });
    } catch (err) {
      console.error('[chat] API error, falling back to CLI:', (err as Error).message);
    }
  }

  // The MCP config passed via --mcp-config bootstraps a `trail` MCP server
  // the CLI can use inside this turn. Spawning it cold adds ~500ms — worth it
  // for tool-equipped answers that previously fell back to "I don't know".
  const mcpConfig = {
    mcpServers: {
      trail: {
        command: 'bun',
        args: ['run', MCP_SERVER_PATH],
      },
    },
  };

  const args = [
    '-p',
    `${systemPrompt}\n\n## User Question\n${body.message}`,
    '--dangerously-skip-permissions',
    '--max-turns',
    String(CHAT_MAX_TURNS),
    '--output-format',
    'json',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--allowedTools',
    CHAT_ALLOWED_TOOLS,
    ...(CHAT_MODEL ? ['--model', CHAT_MODEL] : []),
  ];

  // The MCP subprocess reads tenant/KB/user from env to scope every query to
  // the right rows. Without these it refuses to run (see requireContext in
  // apps/mcp).
  const spawnEnv = {
    TRAIL_TENANT_ID: tenant.id,
    TRAIL_KNOWLEDGE_BASE_ID: resolvedKbId ?? kbs[0]!.id,
    TRAIL_USER_ID: user.id,
  };

  try {
    const raw = await spawnClaude(args, { timeoutMs: CHAT_TIMEOUT_MS, env: spawnEnv });
    const answer = extractAssistantText(raw);
    return c.json({ answer, citations });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[chat] Error:', msg);
    return c.json({ error: msg }, 500);
  }
});

async function callAnthropicAPI(system: string, userMessage: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CHAT_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
  return data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

interface Citation {
  documentId: string;
  path: string;
  filename: string;
}

async function retrieveContext(
  trail: TrailDatabase,
  query: string,
  kbIds: string[],
  tenantId: string,
): Promise<{ context: string; citations: Citation[] }> {
  const chunks: string[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  const MAX_CHARS = 30_000;
  const PER_KB_CHUNKS = 8;
  const PER_KB_DOCS = 4;

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return { context: '', citations: [] };

  for (const kbId of kbIds) {
    if (totalChars >= MAX_CHARS) break;

    const chunkHits = await trail.searchChunks(ftsQuery, kbId, tenantId, PER_KB_CHUNKS);
    for (const hit of chunkHits) {
      if (totalChars >= MAX_CHARS) break;
      const header = hit.headerBreadcrumb ? `[${hit.headerBreadcrumb}] ` : '';
      const text = `### chunk ${header}\n${hit.content.slice(0, 2500)}`;
      chunks.push(text);
      totalChars += text.length;
      if (!seen.has(hit.documentId)) {
        seen.add(hit.documentId);
      }
    }

    const docHits = await trail.searchDocuments(ftsQuery, kbId, tenantId, PER_KB_DOCS);
    for (const hit of docHits) {
      if (hit.kind !== 'wiki') continue;
      if (totalChars >= MAX_CHARS) break;
      if (!seen.has(hit.id)) {
        seen.add(hit.id);
        citations.push({ documentId: hit.id, path: hit.path, filename: hit.filename });
      }
    }
  }

  return { context: chunks.join('\n\n---\n\n'), citations };
}

function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return terms.join(' OR ');
}
