/**
 * F159 Phase 1 — prompt construction helpers.
 * F160 Phase 2 — audience-aware persona templates with per-KB overrides.
 *
 * `buildSystemPrompt` is the system-role text the chat-LLM sees first.
 * Three audiences (curator / tool / public) map to three persona-template
 * markdown files in `apps/server/src/data/personas/`. Each template
 * contains a `{{TRAIL_CONTEXT}}` placeholder that gets replaced with
 * the per-call wiki-context block (or removed entirely when the call
 * has no retrieved context to share).
 *
 * Per-KB persona overrides (knowledge_bases.chat_persona_tool /
 * chat_persona_public) are appended to the resolved template under a
 * `## KB-specific persona` header so curators can sharpen tone without
 * rewriting the whole template. `curator` audience has no per-KB
 * override — admin tone is shared across all KBs the curator owns.
 *
 * Template files are read fresh on every call. They are tiny (~2KB),
 * filesystem reads are sub-millisecond, and not caching keeps the
 * dev-edit loop instant. If this ever shows up in profiling we can
 * add an in-process cache with mtime invalidation; until then,
 * simplicity wins.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Audience } from '../audience.js';

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
  /**
   * F160 — which persona-template to load. Defaults to `curator` for
   * back-compat with pre-F160 callers (admin chat). External Bearer
   * routes pass `tool` or `public` explicitly.
   */
  audience?: Audience;
  /**
   * F160 — per-KB persona override appended under "## KB-specific
   * persona". Pass null/undefined when KB has no override (default).
   * Ignored entirely for `curator` audience — see module header.
   */
  kbPersonaOverride?: string | null;
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const PERSONA_DIR = resolve(THIS_DIR, '../../data/personas');

function loadTemplate(audience: Audience): string {
  const file = `chat-${audience}.md`;
  return readFileSync(resolve(PERSONA_DIR, file), 'utf8');
}

export function buildSystemPrompt({
  currentTrailName,
  context,
  audience = 'curator',
  kbPersonaOverride = null,
}: SystemPromptInput): string {
  const template = loadTemplate(audience);

  // Build the {{TRAIL_CONTEXT}} substitution. For audiences that don't
  // need a heavy "Current Trail" section we still want the wiki-context
  // block when present — that's where the LLM gets its facts. Curator
  // audience also gets the explicit Trail name so its MCP tool calls
  // default to the right KB; tool/public audiences typically don't have
  // tool access in the same way (they're called via /chat which lets
  // tools fire, but the trail-name is already implicit in the kbId
  // scope of the request).
  const trailLine = currentTrailName && audience === 'curator'
    ? `## Current Trail\nThe user is currently viewing the Trail called **"${currentTrailName}"**. Always call tools WITHOUT a \`knowledge_base\` argument so they default to this Trail automatically.\n\n`
    : '';
  const contextBlock = context.trim().length > 0
    ? `## Wiki Context (from content search)\n${context}`
    : '';
  const trailContext = `${trailLine}${contextBlock}`.trim();

  let prompt = template.replace('{{TRAIL_CONTEXT}}', trailContext);

  // Append per-KB persona override (tool + public only). Curator audience
  // gets the override stripped intentionally — admin tone is global.
  if (audience !== 'curator' && kbPersonaOverride && kbPersonaOverride.trim()) {
    prompt += `\n\n## KB-specific persona\n\n${kbPersonaOverride.trim()}`;
  }

  return prompt;
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
