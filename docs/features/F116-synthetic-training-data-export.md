# F116 — Synthetic Training Data Export

> Tier: Business+/Enterprise. Effort: 5-7 days. Planned.

## Problem

Karpathy nævner dette som avanceret fremtid-direction: en moden wiki kan være source for syntetisk træningsdata. Trail har alle primitiver (Neurons, source-citations, chat-historik) men ingen eksport-flow der strukturerer det som JSONL til fine-tuning.

## Secondary Pain Points

- Ingen måde at monetarisere modne KBs ud over subscription
- Kunder med 500+ Neurons har ingen "exit ramp" til at bruge deres data i egne modeller
- Manglende differentiator vs. konkurrenter der tilbyder fine-tune eksport

## Solution

Ny endpoint (Business+): `POST /api/v1/knowledge-bases/:kbId/export/fine-tune`. Producerer JSONL-fil med 3 strategier kombineret:

**Strategy 1 — Q/A fra chat-historik**: enhver chat-query + high-confidence svar → `{prompt, completion}`-par (hvis user har opt'ed at inkludere chat-logs).

**Strategy 2 — Source → summary**: for hver source, `{prompt: "Summarize: {source-content-excerpt}", completion: "{source-summary-neuron-content}"}`.

**Strategy 3 — Concept Q&A synthesized**: LLM genererer 3-5 naturlige spørgsmål per concept-Neuron + svaret, givet Neuron'ens body som source-of-truth. ~$50-100 LLM-cost for 500 Neurons.

Output-format: JSONL kompatibel med OpenAI + Anthropic fine-tune-upload.

## Non-Goals

- Fine-tuning the model itself (Trail only produces the dataset)
- Real-time dataset generation (async job, not instant)
- Support for non-JSONL formats (CSV, Parquet, etc.)
- Automatic upload to OpenAI/Anthropic fine-tune APIs (user downloads and uploads manually)

## Technical Design

### Dataset Builder Service

```typescript
// apps/server/src/services/fine-tune-dataset-builder.ts
interface FineTuneStrategy {
  type: 'chat-qa' | 'source-summary' | 'concept-qa';
  enabled: boolean;
}

interface FineTuneJob {
  id: string;
  kbId: string;
  tenantId: string;
  strategies: FineTuneStrategy[];
  status: 'queued' | 'running' | 'completed' | 'failed';
  outputUrl?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export async function buildFineTuneDataset(
  db: TrailDatabase,
  kbId: string,
  strategies: FineTuneStrategy[],
  onProgress: (count: number) => void
): Promise<string> {
  // Streams JSONL to temp file, returns file path
}
```

### Endpoint

```
POST /api/v1/knowledge-bases/:kbId/export/fine-tune
Body: { strategies: ['chat-qa', 'source-summary', 'concept-qa'], includeChatLogs: boolean }
→ 202 { jobId, estimatedCompletionTime }

GET /api/v1/knowledge-bases/:kbId/export/fine-tune/:jobId
→ 200 { status, outputUrl? }
```

### Strategy 3 — Parallel Execution

Ved Strategy 3: spawn claude-subprocess per Neuron med concurrency-limit (via F119 parallelism runner).

## Interface

```typescript
// POST /api/v1/knowledge-bases/:kbId/export/fine-tune
interface FineTuneExportRequest {
  strategies: ('chat-qa' | 'source-summary' | 'concept-qa')[];
  includeChatLogs: boolean;
  maxExamplesPerNeuron?: number; // default 5
}

interface FineTuneExportResponse {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  estimatedCompletionTime?: string;
  outputUrl?: string;
}

// JSONL output format (per line):
// {"prompt": "...", "completion": "..."}
```

## Rollout

**Phased deploy:**
1. Ship Strategy 1 (chat Q/A) — simplest, no LLM cost
2. Ship Strategy 2 (source → summary) — deterministic
3. Ship Strategy 3 (concept Q/A) — requires LLM parallelism (F119)
4. Ship full endpoint with job management

## Success Criteria

- Output er valid JSONL parserbar af standard fine-tune pipelines
- Business-kunde kan eksportere, fine-tune en lille model (Haiku/Llama-variant), og querier efter den har internaliseret KB'en
- Marketing: "Train a model on your second brain"
- Pricing: engangs-kost $199-499 per eksport (dækker LLM-compute til Strategy 3 + infra)

## Impact Analysis

### Files created (new)
- `apps/server/src/services/fine-tune-dataset-builder.ts`
- `apps/server/src/routes/fine-tune-export.ts`

### Files modified
- `apps/server/src/app.ts` (mount fine-tune export route)
- `apps/server/src/services/translation.ts` (reuse locale handling for multilingual datasets)
- `packages/db/src/schema.ts` (add fine_tune_jobs table)

### Downstream dependents
`apps/server/src/app.ts` is imported by 1 file:
- `apps/server/src/index.ts` (1 ref) — creates app, unaffected

`apps/server/src/services/translation.ts` is imported by 1 file:
- `apps/server/src/routes/queue.ts` (1 ref) — uses ensureCandidateInLocale, unaffected

`packages/db/src/schema.ts` is imported by 1 file:
- `packages/core/src/kb/resolve.ts` (1 ref) — reads document schema, unaffected by additive table

### Blast radius

- New table `fine_tune_jobs` — additive, no impact on existing queries
- Strategy 3 LLM calls add to tenant budget (F121) — must check budget before starting
- Large KBs (10k+ Neurons) can produce 50k+ JSONL lines — streaming required to avoid OOM
- Chat log inclusion requires explicit opt-in (privacy/GDPR concern)

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Strategy 1: chat Q/A export produces valid JSONL with prompt/completion pairs
- [ ] Strategy 2: source → summary export produces valid JSONL
- [ ] Strategy 3: concept Q&A generates 3-5 questions per Neuron
- [ ] Output validates against OpenAI fine-tune format spec
- [ ] Output validates against Anthropic fine-tune format spec
- [ ] Job status polling returns correct state transitions
- [ ] Budget check (F121) stops export if tenant exceeds cap
- [ ] Regression: existing export (F100) unaffected
- [ ] Regression: chat history storage unaffected

## Implementation Steps

1. Add `fine_tune_jobs` table to schema with migration.
2. Create `apps/server/src/services/fine-tune-dataset-builder.ts` with Strategy 1 (chat Q/A).
3. Add Strategy 2 (source → summary) — deterministic mapping.
4. Add Strategy 3 (concept Q&A) — LLM-generated questions per Neuron, using F119 parallelism.
5. Create `apps/server/src/routes/fine-tune-export.ts` with job management endpoints.
6. Mount route in `app.ts`.
7. Add budget check integration (F121) before starting Strategy 3 jobs.
8. Build streaming JSONL output for large KBs.

## Dependencies

- F119 (parallelism runner) — Strategy 3 is parallel-friendly
- F121 (budget tracking) — stop export if tenant hits budget cap

## Open Questions

None — all decisions made.

## Related Features

- **F119** (Parallel Contradiction Runner) — reuse concurrency runner for Strategy 3
- **F121** (Per-Tenant Budget Tracking) — budget check before LLM-heavy export
- **F100** (Export) — shares export infrastructure (job management, streaming)

## Effort Estimate

**Medium** — 5-7 days.
- Day 1-2: Schema + Strategy 1 + job management
- Day 3-4: Strategy 2 + Strategy 3 with parallelism
- Day 5-6: Streaming output + budget integration
- Day 7: Testing + validation against OpenAI/Anthropic specs
