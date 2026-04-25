/**
 * F159 Phase 1 — Chain resolution.
 *
 * Mirror of F149's apps/server/src/services/ingest/chain.ts. Returns
 * an ordered list of {backend, model} steps; `runChat()` tries each in
 * sequence on backend failure.
 *
 * Phase 1 (this code): always returns a single-step chain matching
 * pre-F159 behaviour — Claude CLI with the env-configured CHAT_MODEL.
 * No fallback. Phase 2 flips the default to multi-step when the
 * OpenRouter + Claude-API backends land.
 *
 * Precedence (highest wins; mirrors F149):
 *   1. `knowledge_bases.chat_fallback_chain` JSON column override.
 *      [Phase 3 — column doesn't exist yet.]
 *   2. Synthesized from `knowledge_bases.chat_backend` + `chat_model`.
 *      [Phase 3.]
 *   3. Process env CHAT_BACKEND + CHAT_MODEL.
 *   4. Hardcoded defaults below.
 */

import type { ChatBackendId } from './backend.js';

export interface ChainStep {
  backend: ChatBackendId;
  model: string;
}

export interface ChainResolutionInput {
  /** Phase 3 will pass the KB row here for per-KB column overrides.
   *  Phase 1 ignores it. */
  kb?: { chatBackend?: string | null; chatModel?: string | null; chatFallbackChain?: string | null };
  env?: NodeJS.ProcessEnv;
}

/** Default chat model when the user hasn't set CHAT_MODEL. */
export const DEFAULT_CHAT_MODEL = 'claude-haiku-4-5-20251001';

export function resolveChatChain(input: ChainResolutionInput = {}): ChainStep[] {
  const env = input.env ?? process.env;

  // Phase 1: env-driven single step. Phase 3 will check input.kb
  // chatFallbackChain first, then chatBackend+chatModel, then env.
  const envBackend = env.CHAT_BACKEND as ChatBackendId | undefined;
  const envModel = env.CHAT_MODEL || DEFAULT_CHAT_MODEL;

  const backend: ChatBackendId = envBackend ?? 'claude-cli';
  return [{ backend, model: envModel }];
}
