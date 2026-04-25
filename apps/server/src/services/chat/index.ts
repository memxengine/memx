/**
 * F159 — Chat backend factory + runChat() orchestrator.
 *
 * Phase 1 ships only the Claude CLI backend; Phase 2 adds OpenRouter
 * + Claude-API. The factory is dynamic-import-based so the AWS-style
 * SDK lift for OpenRouter doesn't enter the cold-boot path until a
 * tenant actually requests that backend.
 *
 * `runChat()` is the route's single entry point. Phase 1: single-step
 * chain, no fallback (matches pre-F159 behaviour exactly). Phase 2
 * adds the chain-fallback loop on `isFallbackEligible` errors.
 */

import { ClaudeCLIChatBackend } from './claude-cli-backend.js';
import { resolveChatChain, type ChainResolutionInput } from './chain.js';
import type {
  ChatBackend,
  ChatBackendId,
  ChatBackendInput,
  ChatBackendResult,
} from './backend.js';

export type { ChatBackend, ChatBackendId, ChatBackendInput, ChatBackendResult } from './backend.js';
export type { ChainStep, ChainResolutionInput } from './chain.js';
export { resolveChatChain, DEFAULT_CHAT_MODEL } from './chain.js';
export { buildSystemPrompt, buildCliPrompt, type PriorTurn } from './build-prompt.js';

export async function createChatBackend(id: ChatBackendId): Promise<ChatBackend> {
  switch (id) {
    case 'claude-cli':
      return new ClaudeCLIChatBackend();
    case 'openrouter': {
      // F159 Phase 2a — landed.
      const { OpenRouterChatBackend } = await import('./openrouter-backend.js');
      return new OpenRouterChatBackend();
    }
    case 'claude-api': {
      // Phase 2b — direct Anthropic API for low-latency premium chats.
      throw new Error(`ClaudeAPIBackend not yet implemented (F159 Phase 2b)`);
    }
  }
}

export interface RunChatInput
  extends Omit<ChatBackendInput, 'model'>,
    Pick<ChainResolutionInput, 'kb'> {
  /** Optional explicit model — overrides chain resolution. */
  modelOverride?: string;
}

/**
 * Resolve the chat chain, run each step until one succeeds. Phase 1:
 * the chain is always single-step, so the loop exits after one
 * iteration. Phase 2 adds isFallbackEligible-gated step advance.
 */
export async function runChat(input: RunChatInput): Promise<ChatBackendResult> {
  const chain = resolveChatChain({ kb: input.kb });
  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i]!;
    try {
      const backend = await createChatBackend(step.backend);
      const result = await backend.run({
        ...input,
        model: input.modelOverride ?? step.model,
      });
      return { ...result, stepsAttempted: i + 1 };
    } catch (err) {
      lastError = err;
      // Phase 1: no fallback gate — re-throw immediately. Phase 2
      // wraps this in isFallbackEligible(err) so 429 / 5xx / network
      // errors advance to the next step instead of bubbling up.
      throw err;
    }
  }
  throw new Error(
    `runChat: chain exhausted (${chain.length} steps) — last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
