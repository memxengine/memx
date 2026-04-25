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
      // F159 Phase 2b — direct Anthropic API for low-latency premium chats.
      // Code-complete and typecheck-verified; end-to-end probe deferred
      // until ANTHROPIC_API_KEY is available in .env.
      const { ClaudeAPIBackend } = await import('./claude-api-backend.js');
      return new ClaudeAPIBackend();
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
 * Resolve the chat chain, run each step until one succeeds.
 *
 * Phase 4 (this code) advances to the next step on `isFallbackEligible`
 * errors — rate-limits, 5xx, network/connection errors, missing
 * `claude` binary. Hard errors (4xx user-error, content-policy
 * refusal, validation) bubble up immediately; they wouldn't succeed
 * on the next backend either, and silent fall-through would mask
 * real bugs.
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
      const isLast = i === chain.length - 1;
      if (isLast || !isFallbackEligible(err)) throw err;
      console.warn(
        `[runChat] step ${i + 1}/${chain.length} (${step.backend}:${step.model}) failed, advancing: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  throw new Error(
    `runChat: chain exhausted (${chain.length} steps) — last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Decide whether a backend failure should advance to the next chain
 * step or bubble up as a hard error. Mirror of F149's same-name
 * predicate in services/ingest/runner.ts.
 *
 *   ELIGIBLE (advance):
 *     - "Executable not found" (no claude binary in prod)
 *     - "ENOTFOUND" / "ECONNREFUSED" / "ETIMEDOUT" (network)
 *     - HTTP 429 (rate-limit), HTTP 5xx (provider error)
 *     - "exceeded maxTurns" (this backend ran out of headroom — try
 *       another model with different reasoning shape)
 *
 *   NOT ELIGIBLE (throw immediately):
 *     - HTTP 4xx (auth, validation, malformed body)
 *     - Anthropic-style content-policy refusal
 *     - Generic Error without a recognisable signal — assume
 *       user-error, don't waste budget on the next backend
 */
export function isFallbackEligible(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // CLI binary not on PATH — F159's headline reason for fallback.
  if (lower.includes('executable not found') || lower.includes('enoent')) return true;
  // Network failures.
  if (lower.includes('enotfound') || lower.includes('econnrefused') || lower.includes('etimedout')) return true;
  if (lower.includes('aborterror') || lower.includes('aborted')) return true;
  // Provider 429 / 5xx.
  if (/\b(429|5\d\d)\b/.test(msg)) return true;
  // maxTurns exhaustion — this backend gave up; try another shape.
  if (lower.includes('exceeded maxturns')) return true;
  return false;
}
