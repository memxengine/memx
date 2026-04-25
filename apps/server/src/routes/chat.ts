import { Hono } from 'hono';
import { documents, knowledgeBases, chatSessions, chatTurns, type TrailDatabase } from '@trail/db';
import { and, asc, eq, like } from 'drizzle-orm';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import { ChatRequestSchema } from '@trail/shared';
import { resolveKbId } from '@trail/core';
import {
  HEURISTIC_PATH,
  computeConfidence,
  isFaded,
  isPinned,
  rewriteWikiLinks,
} from '@trail/shared';
import { recordAccess } from '../services/access-tracker.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChat, buildSystemPrompt, type PriorTurn } from '../services/chat/index.js';

// F159 Phase 1 bumped default from 5 to 8. Chat with tool use needs
// headroom: a typical compound query (search → read → search → read →
// answer) is already 4 turns; one extra for self-correction is 5;
// no headroom for the model to refine. 8 gives space while 60s
// timeout still bounds wall-clock.
//
// CHAT_MODEL + ANTHROPIC_API_KEY now live inside the chat backends —
// see services/chat/{chain,claude-cli-backend}.ts.
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS ?? 60_000);
const CHAT_MAX_TURNS = Number(process.env.CHAT_MAX_TURNS ?? 8);
// How many historical turn-pairs to replay into each new turn. 10 turns
// = 5 exchanges, which is ~2500 tokens at typical verbosity — trivial
// against Haiku's 200k context but plenty for "what did you just offer
// me?" follow-ups. Individual turn content is truncated to 2000 chars
// to bound the worst-case (a curator pasting a wall of text).
const CHAT_HISTORY_TURNS = Number(process.env.CHAT_HISTORY_TURNS ?? 10);
const CHAT_HISTORY_MAX_CHARS_PER_TURN = 2000;

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
// going through the Queue. The CLI backend joins this on `,` for the
// `--allowedTools` flag; OpenRouter / Claude-API backends iterate it
// to build their `tools: [...]` array — so we keep the list shape and
// let backends format as needed.
const CHAT_ALLOWED_TOOL_LIST: ReadonlyArray<string> = [
  'mcp__trail__guide',
  'mcp__trail__search',
  'mcp__trail__read',
  'mcp__trail__count_neurons',
  'mcp__trail__count_sources',
  'mcp__trail__queue_summary',
  'mcp__trail__recent_activity',
  'mcp__trail__trail_stats',
];

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

  // F144 follow-up: multi-turn memory. If the client pinned a sessionId,
  // replay the last N turn-pairs so the LLM sees its own prior offer and
  // the user's short follow-up ("Ja det vil jeg gerne") as one coherent
  // conversation. Without this, every turn looks like a cold-start and
  // short confirmations fail to resolve.
  const priorTurns = body.sessionId
    ? await loadPriorTurns(trail, body.sessionId, tenant.id, CHAT_HISTORY_TURNS)
    : [];

  // Name the Trail the user is currently in so Claude doesn't pass a
  // guessed slug to tools. All structural tools accept an optional
  // knowledge_base arg, but when omitted they default to the Trail scoped
  // via env (TRAIL_KNOWLEDGE_BASE_ID) — which is always the *current* KB.
  const currentTrailName = kbs.length === 1 ? kbs[0]!.name : null;
  const systemPrompt = buildSystemPrompt({ currentTrailName, context });

  // F30 — server-side render of [[wiki-links]] into `[display](href)`
  // markdown. Consumers (widget, API clients, non-admin integrators)
  // receive `renderedAnswer` ready to pass to their own markdown→HTML
  // renderer without writing their own wiki-link parser. Admin already
  // runs `rewriteWikiLinks` client-side so the second pass is a no-op
  // (all `[[...]]` are gone). Cross-KB resolution uses the tenant's
  // full KB list so `[[kb:other-trail/Page]]` resolves to the sister
  // KB when it exists.
  const primaryKbId = resolvedKbId ?? kbs[0]!.id;
  const tenantKbSlugMap = await buildKbSlugMap(trail, tenant.id);
  const renderAnswer = (raw: string): string =>
    rewriteWikiLinks(raw, {
      currentKbId: primaryKbId,
      resolveKbSlug: (slug) => tenantKbSlugMap.get(slug) ?? null,
    });

  // F159 Phase 1: route the run through the new ChatBackend interface.
  // Phase 1 always resolves to a single-step Claude-CLI chain — same
  // bytes out as the pre-F159 hand-rolled spawnClaude call. Phase 2
  // adds OpenRouter + Claude-API backends + chain fallback; Phase 3
  // adds cost stamping into chat_turns.
  try {
    const result = await runChat({
      trail,
      systemPrompt,
      userMessage: body.message,
      history: priorTurns,
      maxTurns: CHAT_MAX_TURNS,
      timeoutMs: CHAT_TIMEOUT_MS,
      tenantId: tenant.id,
      knowledgeBaseId: primaryKbId,
      userId: user.id,
      mcpServerPath: MCP_SERVER_PATH,
      toolNames: CHAT_ALLOWED_TOOL_LIST,
    });
    const { answer } = result;
    const sessionId = await persistTurnPair(
      trail,
      tenant.id,
      user.id,
      primaryKbId,
      body.sessionId ?? null,
      body.message,
      answer,
      citations,
      result.elapsedMs,
    );
    return c.json({
      answer,
      renderedAnswer: renderAnswer(answer),
      citations,
      sessionId,
      // F159 — surface backend + model on every reply so the admin UI
      // can render a small chip ("answered by gemini-2.5-flash") when
      // we want to show the user which model they got.
      backend: result.backendUsed,
      model: result.modelUsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[chat] Error:', msg);
    return c.json({ error: msg }, 500);
  }
});

/**
 * F144 — write the user+assistant turn pair to chat_turns. Session is
 * created on first turn if no sessionId passed; title is derived from
 * the user question (truncated to 60 chars). All DB work here is best-
 * effort: if persistence fails we still return the answer, just without
 * a durable record. Returns the session id for the client to pin to.
 */
async function persistTurnPair(
  trail: TrailDatabase,
  tenantId: string,
  userId: string,
  kbId: string,
  incomingSessionId: string | null,
  userMessage: string,
  assistantAnswer: string,
  citations: Citation[],
  latencyMs: number,
): Promise<string | null> {
  try {
    let sessionId = incomingSessionId;
    const now = new Date().toISOString();
    if (!sessionId) {
      sessionId = `chs_${crypto.randomUUID().slice(0, 12)}`;
      await trail.db
        .insert(chatSessions)
        .values({
          id: sessionId,
          tenantId,
          knowledgeBaseId: kbId,
          userId,
          title: deriveSessionTitle(userMessage),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } else {
      await trail.db
        .update(chatSessions)
        .set({ updatedAt: now })
        .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.tenantId, tenantId)))
        .run();
    }
    const citationsJson = citations.length
      ? JSON.stringify(
          citations.map((c) => ({
            neuronId: c.documentId,
            path: c.path,
            filename: c.filename,
          })),
        )
      : null;
    await trail.db
      .insert(chatTurns)
      .values({
        id: `ctn_${crypto.randomUUID().slice(0, 12)}`,
        sessionId,
        role: 'user',
        content: userMessage,
        createdAt: now,
      })
      .run();
    await trail.db
      .insert(chatTurns)
      .values({
        id: `ctn_${crypto.randomUUID().slice(0, 12)}`,
        sessionId,
        role: 'assistant',
        content: assistantAnswer,
        citations: citationsJson,
        latencyMs,
        createdAt: new Date().toISOString(),
      })
      .run();
    return sessionId;
  } catch (err) {
    console.error('[chat] persist-turn failed:', err instanceof Error ? err.message : err);
    return incomingSessionId;
  }
}

function deriveSessionTitle(message: string): string {
  const normalised = message.replace(/\s+/g, ' ').trim();
  if (normalised.length <= 60) return normalised;
  return normalised.slice(0, 57).replace(/[,.!?;:]+$/, '') + '…';
}

/**
 * F30 — lookup table for cross-KB link resolution in server-side
 * chat-answer rendering. Maps `kb-slug` to `kb-id`. Scoped to the
 * caller's tenant. Small enough to compute per-request; a future
 * optimisation would cache with SSE invalidation on KB create/update.
 */
async function buildKbSlugMap(trail: TrailDatabase, tenantId: string): Promise<Map<string, string>> {
  const rows = await trail.db
    .select({ id: knowledgeBases.id, slug: knowledgeBases.slug })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.tenantId, tenantId))
    .all();
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.slug) map.set(r.slug, r.id);
  }
  return map;
}

/**
 * Load up to `limit` most-recent turns for a session, returned in
 * chronological order (oldest first) so they replay as a natural
 * conversation. Scoped by sessionId + tenantId via a join so a crafted
 * sessionId from another tenant can't leak turns.
 *
 * Truncates per-turn content to CHAT_HISTORY_MAX_CHARS_PER_TURN so a
 * curator pasting a wall of text doesn't blow the prompt budget.
 */
async function loadPriorTurns(
  trail: TrailDatabase,
  sessionId: string,
  tenantId: string,
  limit: number,
): Promise<PriorTurn[]> {
  try {
    const rows = await trail.db
      .select({ role: chatTurns.role, content: chatTurns.content })
      .from(chatTurns)
      .innerJoin(chatSessions, eq(chatSessions.id, chatTurns.sessionId))
      .where(
        and(eq(chatTurns.sessionId, sessionId), eq(chatSessions.tenantId, tenantId)),
      )
      .orderBy(asc(chatTurns.createdAt))
      .limit(limit)
      .all();
    return rows.map((r) => ({
      role: r.role as 'user' | 'assistant',
      content: truncateForHistory(r.content),
    }));
  } catch (err) {
    console.error('[chat] loadPriorTurns failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function truncateForHistory(content: string): string {
  if (content.length <= CHAT_HISTORY_MAX_CHARS_PER_TURN) return content;
  return content.slice(0, CHAT_HISTORY_MAX_CHARS_PER_TURN) + '…';
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

    // F139 — faded heuristics (confidence <0.3, not pinned) are excluded
    // from chat context so stale decision-rules don't drift into new
    // answers. The filter is a Set<documentId> applied after FTS — cheap
    // upfront query, usually 0 rows on KBs that don't use heuristics yet.
    const fadedHeuristicIds = await listFadedHeuristicIds(trail, kbId, tenantId);

    const chunkHits = await trail.searchChunks(ftsQuery, kbId, tenantId, PER_KB_CHUNKS);
    for (const hit of chunkHits) {
      if (totalChars >= MAX_CHARS) break;
      if (fadedHeuristicIds.has(hit.documentId)) continue;
      const header = hit.headerBreadcrumb ? `[${hit.headerBreadcrumb}] ` : '';
      const text = `### chunk ${header}\n${hit.content.slice(0, 2500)}`;
      chunks.push(text);
      totalChars += text.length;
      if (!seen.has(hit.documentId)) {
        seen.add(hit.documentId);
        // F141 — record the chat-context hit. One row per unique Neuron
        // that contributed to a chat answer; counted as actor_kind='user'
        // because it's a user question that pulled this Neuron in. Lets
        // "most-consulted by chat" surface in the F141 insights panel.
        recordAccess(trail, {
          tenantId,
          knowledgeBaseId: kbId,
          documentId: hit.documentId,
          source: 'chat',
          actorKind: 'user',
        });
      }
    }

    const docHits = await trail.searchDocuments(ftsQuery, kbId, tenantId, PER_KB_DOCS);
    for (const hit of docHits) {
      if (hit.kind !== 'wiki') continue;
      if (fadedHeuristicIds.has(hit.id)) continue;
      if (totalChars >= MAX_CHARS) break;
      if (!seen.has(hit.id)) {
        seen.add(hit.id);
        citations.push({ documentId: hit.id, path: hit.path, filename: hit.filename });
        recordAccess(trail, {
          tenantId,
          knowledgeBaseId: kbId,
          documentId: hit.id,
          source: 'chat',
          actorKind: 'user',
        });
      }
    }
  }

  return { context: chunks.join('\n\n---\n\n'), citations };
}

/**
 * F139 — IDs of heuristic Neurons that have faded below the confidence
 * threshold and are NOT pinned. Used by retrieveContext to suppress
 * stale decision-rules from chat context. Returns an empty set when
 * the KB has no heuristic Neurons (the common case today).
 */
async function listFadedHeuristicIds(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
): Promise<Set<string>> {
  const rows = await trail.db
    .select({
      id: documents.id,
      content: documents.content,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.knowledgeBaseId, kbId),
        eq(documents.tenantId, tenantId),
        eq(documents.kind, 'wiki'),
        eq(documents.archived, false),
        like(documents.path, `${HEURISTIC_PATH}%`),
      ),
    )
    .all();

  const faded = new Set<string>();
  for (const r of rows) {
    const pinned = isPinned(r.content);
    const confidence = computeConfidence(r.updatedAt, pinned);
    if (isFaded(confidence)) faded.add(r.id);
  }
  return faded;
}

function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return terms.join(' OR ');
}
