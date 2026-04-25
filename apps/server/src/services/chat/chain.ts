/**
 * F159 — Chat-backend chain resolution.
 *
 * Mirror of F149's apps/server/src/services/ingest/chain.ts. Returns
 * an ordered list of {backend, model} steps; `runChat()` tries each in
 * sequence on backend failure.
 *
 * Precedence (highest wins; mirrors F149):
 *   1. `knowledge_bases.chat_fallback_chain` JSON column override —
 *      curator-set chain via PATCH /chat-settings (Phase 3).
 *   2. Synthesized single-step from `knowledge_bases.chat_backend`
 *      + `chat_model` (Phase 3).
 *   3. Process env `CHAT_BACKEND` + `CHAT_MODEL`.
 *   4. Hardcoded defaults below.
 *
 * Phase 4 will flip default[0] from single-step claude-cli to a
 * multi-step chain `[claude-cli, openrouter:gemini-flash, openrouter:
 * claude-sonnet]` so prod (no claude binary) silently falls through
 * to OpenRouter.
 */

import type { ChatBackendId } from './backend.js';

export interface ChainStep {
  backend: ChatBackendId;
  model: string;
}

export interface ChainResolutionInput {
  /** Per-KB overrides loaded from knowledge_bases columns. */
  kb?: {
    chatBackend?: string | null;
    chatModel?: string | null;
    chatFallbackChain?: string | null;
  };
  env?: NodeJS.ProcessEnv;
}

/** Default chat model when the user hasn't set CHAT_MODEL. */
export const DEFAULT_CHAT_MODEL = 'claude-haiku-4-5-20251001';

const VALID_BACKENDS: ReadonlyArray<ChatBackendId> = [
  'claude-cli',
  'openrouter',
  'claude-api',
];

function isValidBackendId(s: unknown): s is ChatBackendId {
  return typeof s === 'string' && (VALID_BACKENDS as ReadonlyArray<string>).includes(s);
}

export function resolveChatChain(input: ChainResolutionInput = {}): ChainStep[] {
  const env = input.env ?? process.env;

  // Precedence 1: per-KB JSON chain override.
  if (input.kb?.chatFallbackChain) {
    try {
      const parsed = JSON.parse(input.kb.chatFallbackChain) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const valid: ChainStep[] = [];
        for (const step of parsed) {
          if (
            step && typeof step === 'object' &&
            'backend' in step && 'model' in step &&
            isValidBackendId((step as { backend: unknown }).backend) &&
            typeof (step as { model: unknown }).model === 'string'
          ) {
            valid.push({
              backend: (step as { backend: ChatBackendId }).backend,
              model: (step as { model: string }).model,
            });
          }
        }
        if (valid.length > 0) return valid;
      }
    } catch (err) {
      console.warn('[chat-chain] kb.chatFallbackChain JSON parse failed; falling through:', err);
    }
  }

  // Precedence 2: per-KB single-step.
  if (input.kb?.chatBackend && isValidBackendId(input.kb.chatBackend)) {
    return [{
      backend: input.kb.chatBackend,
      model: input.kb.chatModel || DEFAULT_CHAT_MODEL,
    }];
  }

  // Precedence 3: env-driven single step.
  const envBackend = env.CHAT_BACKEND;
  if (envBackend && isValidBackendId(envBackend)) {
    return [{ backend: envBackend, model: env.CHAT_MODEL || DEFAULT_CHAT_MODEL }];
  }

  // Precedence 4: hardcoded default. Phase 4 flips this to multi-step.
  return [{ backend: 'claude-cli', model: env.CHAT_MODEL || DEFAULT_CHAT_MODEL }];
}
