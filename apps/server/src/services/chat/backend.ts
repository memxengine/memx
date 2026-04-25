/**
 * F159 Phase 1 — ChatBackend interface.
 *
 * Mirror of F149's IngestBackend interface (apps/server/src/services/
 * ingest/backend.ts). Two implementations land in this folder:
 *
 *   - ClaudeCLIChatBackend (Phase 1) — wraps the existing `claude -p`
 *     subprocess + MCP-config flow. Default for dev / Max-Plan-Mac.
 *     Zero behaviour change vs. the pre-F159 chat route.
 *   - OpenRouterChatBackend (Phase 2) — HTTPS to OpenRouter with
 *     OpenAI-compatible function calling against an in-process MCP-tool
 *     adapter. Production path; no `claude` binary needed.
 *   - ClaudeAPIBackend (Phase 2) — direct Anthropic API for the
 *     latency-critical case where we want to skip OpenRouter routing.
 *
 * Phase 1 ships only the interface + the CLI backend + a single-step
 * runner. Chain-resolution + fallback land in Phase 2 alongside the
 * extra backends. F156 chat-pricing canonical + cost stamping land in
 * Phase 3.
 */

export type ChatBackendId = 'claude-cli' | 'openrouter' | 'claude-api';

export interface ChatBackendInput {
  systemPrompt: string;
  userMessage: string;
  /** F144 — prior turn-pairs for this session (oldest first). */
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  /** Model identifier — backend-specific format. CLI: `claude-haiku-4-5-…`;
   *  OpenRouter: `google/gemini-2.5-flash`; Claude-API: `claude-sonnet-…`. */
  model: string;
  /** Per-call iteration cap for tool-use. Phase 1 default = 8 (was 5). */
  maxTurns: number;
  /** Wall-clock cap for the whole run. Phase 1 default = 60_000. */
  timeoutMs: number;
  /** Required by the trail MCP subprocess for tenant scoping. */
  tenantId: string;
  knowledgeBaseId: string;
  userId: string;
  /** Path to the trail MCP entrypoint (CLI backend) — `apps/mcp/src/
   *  index.ts`. OpenRouter backend ignores this; uses in-process
   *  invokeTrailMcpTool() instead. */
  mcpServerPath: string;
  /** Whitelist of MCP tools the chat LLM is allowed to call. */
  toolNames: ReadonlyArray<string>;
}

export interface ChatBackendResult {
  answer: string;
  /** Sub-cents tracked at OpenRouter granularity (Phase 3). NULL for
   *  Claude-CLI runs (Max-Plan flat fee — no per-call cost). */
  costCents: number | null;
  /** Which backend actually produced the answer (after any in-chain
   *  fallbacks — single-step in Phase 1, so always === requested). */
  backendUsed: ChatBackendId;
  modelUsed: string;
  /** How many backend steps were attempted before success. Phase 1
   *  always returns 1; Phase 2 chain-fallback can return 2+. */
  stepsAttempted: number;
  /** Wall-clock from backend.run() entry to answer-ready. */
  elapsedMs: number;
}

export interface ChatBackend {
  readonly id: ChatBackendId;
  run(input: ChatBackendInput): Promise<ChatBackendResult>;
}
