/**
 * F159 Phase 1 — prompt construction helpers.
 *
 * Lifted verbatim from the pre-F159 chat.ts so both the CLI backend
 * (today) and the OpenRouter / Claude-API backends (Phase 2) can share
 * the same exact prompt shape. Identical bytes in === identical bytes
 * out — no behaviour drift between backends.
 *
 * `buildSystemPrompt` is the system-role text Claude sees first; for
 * the OpenRouter / Claude-API backends this becomes `system:` on the
 * messages array directly. For the CLI backend it gets concatenated
 * into the `-p` prompt by `buildCliPrompt`.
 */

export interface PriorTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface SystemPromptInput {
  /** "Development Tester" — used in the prompt so Claude doesn't pass
   *  a guessed slug to MCP tools. Null when the chat is cross-KB. */
  currentTrailName: string | null;
  /** Pre-formatted "Wiki Context (from content search)" block, or
   *  empty string when retrieveContext found nothing. */
  context: string;
}

export function buildSystemPrompt({ currentTrailName, context }: SystemPromptInput): string {
  const hasContext = context.trim().length > 0;
  return `You are a knowledgeable assistant with access to tools that query the user's Trail (knowledge base). Answer their question accurately.

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
}

/**
 * Build the single-string prompt for the `claude -p` CLI path. The CLI
 * has no multi-turn message API, so we inline the history as a
 * transcript before the new question. Claude reliably treats this as
 * conversation context when the headings + roles are explicit.
 *
 * For the OpenRouter / Claude-API backends, the same data is sent as
 * a structured `messages: [...]` array — see those backends' run()
 * methods. Same prompt text either way; the structure differs.
 */
export function buildCliPrompt(
  systemPrompt: string,
  history: ReadonlyArray<PriorTurn>,
  currentMessage: string,
): string {
  if (history.length === 0) {
    return `${systemPrompt}\n\n## User Question\n${currentMessage}`;
  }
  const transcript = history
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n\n');
  return `${systemPrompt}\n\n## Prior Conversation (oldest first — use this to resolve short follow-ups like "yes", "do it", "show me")\n${transcript}\n\n## User Question (current turn)\n${currentMessage}`;
}
