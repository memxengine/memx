/**
 * F149 — Pluggable Ingest Backend interface.
 *
 * The ingest pipeline is factored behind this single interface so
 * multiple LLM backends can drive Trail's compile-at-ingest workflow
 * without the runner knowing which one ran. Today's implementations:
 *
 *   - ClaudeCLIBackend   — spawns `claude -p` as a subprocess. MCP
 *                          stdio-bridge carries tool calls. Cost is
 *                          always 0 on Max Plan.
 *
 *   - OpenRouterBackend  — (F149 Phase 2) in-process HTTPS calls to
 *                          openrouter.ai. Tool-calls dispatched to a
 *                          local CandidateQueueAPI — no MCP, no
 *                          subprocess. Cost reported by provider.
 *
 * Future backends (AnthropicBackend for direct API, VertexBackend,
 * BedrockBackend, OllamaBackend) implement the same interface. No
 * MCP rewiring needed because they all share the same in-process
 * CandidateQueueAPI pattern.
 *
 * The runner (runner.ts) owns chain-resolution and fallback; backends
 * just fulfil a single run.
 */

export type IngestBackendId = 'claude-cli' | 'openrouter';

export interface IngestBackendInput {
  /**
   * The fully-rendered compile prompt. The runner builds this from
   * ingest.ts's prompt template; backends don't touch the content.
   */
  prompt: string;

  /**
   * Allowed MCP tool names for this run. Concrete values today:
   * `['mcp__trail__guide', 'mcp__trail__search', 'mcp__trail__read',
   * 'mcp__trail__write']`. ClaudeCLIBackend passes them to claude CLI
   * via --allowedTools; OpenRouterBackend maps them to its in-process
   * CandidateQueueAPI.
   */
  tools: string[];

  /**
   * Absolute path to the per-job MCP config file written by
   * writeIngestMcpConfig(). ClaudeCLIBackend points claude at this
   * via --mcp-config; OpenRouterBackend uses the `env` block inside
   * to carry TRAIL_TENANT_ID etc for any in-process fan-out.
   */
  mcpConfigPath: string;

  /**
   * Provider-specific model id. For claude-cli: `claude-sonnet-4-6`.
   * For openrouter: `google/gemini-2.5-flash`, `z-ai/glm-4.6`,
   * `qwen/qwen-plus`, `anthropic/claude-sonnet-4.6`.
   */
  model: string;

  /**
   * Upper bound on turns. ClaudeCLIBackend passes --max-turns;
   * OpenRouterBackend checks client-side before each tool-dispatch.
   */
  maxTurns: number;

  /**
   * Upper bound on wall-clock for the whole run. Backends should
   * respect this as a hard kill-switch, not a soft budget.
   */
  timeoutMs: number;

  /**
   * Env vars for the subprocess (claude-cli) or the in-process
   * CandidateQueueAPI context (openrouter). Must include:
   *   TRAIL_TENANT_ID, TRAIL_USER_ID, TRAIL_KNOWLEDGE_BASE_ID,
   *   TRAIL_DATA_DIR, TRAIL_CONNECTOR, TRAIL_INGEST_JOB_ID
   */
  env: Record<string, string>;

  /**
   * Optional two-pass translator model. If set, the backend runs the
   * translator first (typically a draft-quality cheap model) and feeds
   * its output to the main `model`. Paradigmatic combo: GLM 4.6 draft
   * → Gemini Flash expand. Leave undefined for single-pass.
   */
  translationModel?: string;

  /**
   * F149 Phase 2 — in-process CandidateQueueAPI. Populated by the
   * runner from the ingest-job's context. In-process backends
   * (OpenRouterBackend, AnthropicBackend, …) dispatch tool calls
   * directly to this API. ClaudeCLIBackend IGNORES it — the CLI
   * subprocess reaches the queue through MCP stdio instead.
   */
  candidateApi?: import('@trail/core').CandidateQueueAPI;
}

export interface IngestBackendResult {
  /**
   * Actual turns used. <= input.maxTurns. May be less when the model
   * signals `stop_reason=end_turn` early.
   */
  turns: number;

  /**
   * Wall-clock duration from backend.run() start to return. Used for
   * F151 cost-quality dashboard.
   */
  durationMs: number;

  /**
   * Rounded cost in US cents. 0 means "unknown" or "free" — the
   * dashboard renders based on backend + value (claude-cli + 0 →
   * "gratis (Max)"; openrouter + 0 → "—").
   */
  costCents: number;

  /**
   * Per-turn model record. For single-backend single-model runs this
   * is typically `[{turn: 1, model: input.model}]` unless the backend
   * reports per-turn detail. When fallback-chain activates mid-job,
   * the runner concatenates trails across chain-steps so a retry that
   * lands on GLM after Flash fails shows both.
   */
  modelTrail: Array<{ turn: number; model: string }>;
}

export interface IngestBackend {
  readonly id: IngestBackendId;
  /**
   * Execute one ingest run. Throws on failure — the runner's fallback
   * loop catches and advances the chain.
   */
  run(input: IngestBackendInput): Promise<IngestBackendResult>;
}
