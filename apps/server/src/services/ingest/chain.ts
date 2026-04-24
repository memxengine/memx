/**
 * F149 — Fallback chain resolution.
 *
 * Every ingest run gets an ordered chain of {backend, model} steps.
 * The runner tries each step in sequence; on failure (rate-limit,
 * context-limit, refusal, network) it advances to the next step mid-
 * job, preserving any neurons already written via Candidate Queue.
 *
 * Chain precedence (highest wins):
 *   1. `knowledge_bases.ingest_fallback_chain` — JSON array override
 *      set by curator via F149 PATCH /ingest-settings (or F152 UI).
 *   2. Synthesized from `knowledge_bases.ingest_backend` +
 *      `ingest_model` — single-step override with no fallback.
 *   3. Process env `INGEST_BACKEND` + `INGEST_MODEL`.
 *   4. Hardcoded defaults below.
 *
 * Phase 1 (this code): resolveIngestChain returns a single-step chain
 * that matches current behaviour. Phase 2 flips the default to multi-
 * step fallback when OpenRouterBackend lands.
 */

import type { IngestBackendId } from './backend.js';

export interface ChainStep {
  backend: IngestBackendId;
  model: string;
  /** Optional two-pass translator for this step. */
  translationModel?: string;
}

/**
 * Hard-coded default chains — per Christian's spec (F149 review,
 * 2026-04-24): every ingest run has fallback, regardless of the
 * primary backend chosen.
 *
 *   claude-cli primary → Flash → GLM → Qwen
 *                        (stays free on Max Plan when it works;
 *                         drops to paid cloud on Max-Plan failure)
 *
 *   openrouter primary → Flash → GLM → Qwen → Sonnet (via API)
 *                        (cheap-first strategy; Sonnet API is the
 *                         high-quality last-resort — expensive but
 *                         most reliable)
 *
 * Model IDs matched to model-lab's PRICING table which was verified
 * against live OpenRouter inventory during the 2026-04-24 experiment.
 * The F149 plan's verify-ingest-models.ts CI hook is what keeps these
 * stable across provider-id renames.
 */
export const DEFAULT_CHAIN_CLAUDE_CLI: ChainStep[] = [
  { backend: 'claude-cli', model: 'claude-sonnet-4-6' },
  { backend: 'openrouter', model: 'google/gemini-2.5-flash' },
  { backend: 'openrouter', model: 'z-ai/glm-5.1' },
  { backend: 'openrouter', model: 'qwen/qwen3.6-plus' },
];

export const DEFAULT_CHAIN_OPENROUTER: ChainStep[] = [
  { backend: 'openrouter', model: 'google/gemini-2.5-flash' },
  { backend: 'openrouter', model: 'z-ai/glm-5.1' },
  { backend: 'openrouter', model: 'qwen/qwen3.6-plus' },
  // Note: dot-separated on OpenRouter; verify-ingest-models.ts
  // catches drift if renamed.
  { backend: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
];

export interface KbForChainResolution {
  ingestBackend: string | null;
  ingestModel: string | null;
  ingestFallbackChain: string | null;
}

export interface EnvForChainResolution {
  INGEST_BACKEND?: string;
  INGEST_MODEL?: string;
  INGEST_FALLBACK_CHAIN?: string;
}

/**
 * Pure function — no I/O, no side effects. Safe to call from admin UI
 * via a port (F152's chain-preview feature) without a backend roundtrip.
 *
 * Returns at least one ChainStep. If all overrides are invalid, falls
 * through to the claude-cli default so ingest never runs "no backend".
 */
export function resolveIngestChain(
  kb: KbForChainResolution,
  env: EnvForChainResolution,
): ChainStep[] {
  // 1. KB-level full-chain override. Takes priority over everything
  // because a curator explicitly set it via UI.
  if (kb.ingestFallbackChain) {
    const parsed = parseChainJson(kb.ingestFallbackChain);
    if (parsed && parsed.length > 0) return parsed;
    // Malformed JSON → log + fall through. Don't crash the ingest on
    // a bad settings entry; a downstream run failure surfaces cleanly.
    console.warn('[ingest-chain] malformed ingestFallbackChain on KB; falling through');
  }

  // 2. KB-level single-step. Curator chose a specific backend+model
  // for this Trail but didn't customise the fallback chain.
  if (kb.ingestBackend && kb.ingestModel) {
    const id = kb.ingestBackend as IngestBackendId;
    if (isKnownBackend(id)) {
      return [{ backend: id, model: kb.ingestModel }];
    }
  }

  // 3. Env-level override. Same shape as KB-level — single-step.
  const envChain = parseChainJson(env.INGEST_FALLBACK_CHAIN);
  if (envChain && envChain.length > 0) return envChain;
  if (env.INGEST_BACKEND && env.INGEST_MODEL) {
    const id = env.INGEST_BACKEND as IngestBackendId;
    if (isKnownBackend(id)) {
      return [{ backend: id, model: env.INGEST_MODEL }];
    }
  }

  // 4. Hard-coded default. Chain depends on which backend is "primary"
  // today — claude-cli for Max Plan users (Christian's default),
  // openrouter for tenants who've configured cloud-first.
  const primary = (env.INGEST_BACKEND ?? 'claude-cli') as IngestBackendId;
  return primary === 'openrouter' ? DEFAULT_CHAIN_OPENROUTER : DEFAULT_CHAIN_CLAUDE_CLI;
}

function isKnownBackend(id: string): id is IngestBackendId {
  return id === 'claude-cli' || id === 'openrouter';
}

function parseChainJson(raw: string | null | undefined): ChainStep[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const chain: ChainStep[] = [];
    for (const step of parsed) {
      if (
        typeof step === 'object' &&
        step !== null &&
        typeof (step as ChainStep).backend === 'string' &&
        typeof (step as ChainStep).model === 'string' &&
        isKnownBackend((step as ChainStep).backend)
      ) {
        chain.push({
          backend: (step as ChainStep).backend,
          model: (step as ChainStep).model,
          translationModel:
            typeof (step as ChainStep).translationModel === 'string'
              ? (step as ChainStep).translationModel
              : undefined,
        });
      }
    }
    return chain;
  } catch {
    return null;
  }
}
