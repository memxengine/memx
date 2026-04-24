/**
 * F149 — curated whitelist of ingest-backend model IDs.
 *
 * Single source of truth for:
 *   - F149 chain.ts default-chain definitions
 *   - F152 Runtime Model Switcher UI dropdown
 *   - verify-ingest-models.ts CI check
 *
 * Adding a new model = one entry here. Removing = delete the entry
 * AND anywhere it appears in default chains. The CI check catches
 * stale IDs by cross-referencing against provider /models endpoints.
 *
 * `costPerMillion` is the headline price in USD per million tokens
 * as advertised at 2026-04-24. Drift is expected — the cost numbers
 * shipped at `ingest_jobs.cost_cents` come from the provider's
 * actual usage response, not this table. This table is only for UI
 * hints ("~3¢ per ingest based on 2026 pricing").
 */

export type IngestBackendId = 'claude-cli' | 'openrouter';

export interface IngestModel {
  /** Provider-native ID — what we pass to the API. */
  id: string;
  /** Backend that serves this model. */
  backend: IngestBackendId;
  /** Human-readable label for UI dropdowns. */
  label: string;
  /** Short description for hover tooltip. */
  description: string;
  /** Headline pricing (USD per 1M tokens). */
  costPerMillion: { input: number; output: number };
  /** Does the model support OpenAI-compatible tool calling? */
  supportsToolCalling: boolean;
  /** Rough quality tier for UI sorting ("best" → "budget"). */
  quality: 'best' | 'great' | 'good' | 'budget';
  /** True when the model is battle-tested for Trail ingest. */
  tested: boolean;
}

export const INGEST_MODELS: IngestModel[] = [
  // Claude-cli backend (not in OpenRouter registry — claude CLI
  // resolves natively against Christian's Max Plan).
  {
    id: 'claude-sonnet-4-6',
    backend: 'claude-cli',
    label: 'Claude Sonnet 4.6 (Max Plan)',
    description: 'Christian\'s Claude Max Plan subscription. No per-ingest cost when subscription is active; not in OpenRouter registry.',
    costPerMillion: { input: 0, output: 0 },
    supportsToolCalling: true,
    quality: 'best',
    tested: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    backend: 'claude-cli',
    label: 'Claude Haiku 4.5 (Max Plan)',
    description: 'Cheaper Claude variant on Max Plan. Used for lint/contradiction-detection where tier-1 quality isn\'t needed.',
    costPerMillion: { input: 0, output: 0 },
    supportsToolCalling: true,
    quality: 'good',
    tested: true,
  },

  // OpenRouter backend — battle-tested via model-lab 2026-04-24.
  {
    id: 'google/gemini-2.5-flash',
    backend: 'openrouter',
    label: 'Gemini 2.5 Flash',
    description: 'Production favourite per model-lab benchmark. 11 turns, ~3¢ on the F149 reference fixture.',
    costPerMillion: { input: 0.3, output: 2.5 },
    supportsToolCalling: true,
    quality: 'great',
    tested: true,
  },
  {
    id: 'z-ai/glm-5.1',
    backend: 'openrouter',
    label: 'GLM 5.1',
    description: 'High-quality first-pass for the 2-pass GLM→Flash combo. Better typed-edges than single-pass models.',
    costPerMillion: { input: 1.05, output: 3.5 },
    supportsToolCalling: true,
    quality: 'great',
    tested: true,
  },
  {
    id: 'qwen/qwen3.6-plus',
    backend: 'openrouter',
    label: 'Qwen 3.6 Plus',
    description: 'Budget option. Good enough for English sources; weaker on multi-lingual fidelity.',
    costPerMillion: { input: 0.325, output: 1.95 },
    supportsToolCalling: true,
    quality: 'budget',
    tested: true,
  },
  {
    // Note: dot-separated (4.6) not dash-separated (4-6) on OpenRouter.
    // Verified via verify-ingest-models.ts against live /models registry.
    id: 'anthropic/claude-sonnet-4.6',
    backend: 'openrouter',
    label: 'Claude Sonnet 4.6 (via API)',
    description: 'Anthropic API path — used as high-quality last-resort when Max Plan is exhausted and cloud fallback hits it.',
    costPerMillion: { input: 3.0, output: 15.0 },
    supportsToolCalling: true,
    quality: 'best',
    tested: true,
  },
];

/** Lookup by ID (returns undefined for unknown IDs). */
export function findIngestModel(id: string): IngestModel | undefined {
  return INGEST_MODELS.find((m) => m.id === id);
}

/** Filter to a specific backend. */
export function modelsForBackend(backend: IngestBackendId): IngestModel[] {
  return INGEST_MODELS.filter((m) => m.backend === backend);
}

/** IDs we expect to resolve against OpenRouter's public /models list. */
export function openrouterModelIds(): string[] {
  return INGEST_MODELS.filter((m) => m.backend === 'openrouter').map((m) => m.id);
}
