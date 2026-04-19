# F116 — Synthetic Training Data Export

*Planned. Tier: Business+/Enterprise. Effort: 5-7 days.*

> Når en KB er moden (500+ Neurons, veldefineret domæne), kan ejeren eksportere den som et fine-tune-dataset — prompt/completion-par genereret fra Neurons. Matcher Karpathy's gist-forudsigelse: "use it to generate synthetic training data and fine-tune a smaller LLM so it actually 'knows' the information in its weights."

## Problem

Karpathy nævner dette som avanceret fremtid-direction: en moden wiki kan være source for syntetisk træningsdata. Trail har alle primitiver (Neurons, source-citations, chat-historik) men ingen eksport-flow der strukturerer det som JSONL til fine-tuning.

## Solution

Ny endpoint (Business+): `POST /api/v1/knowledge-bases/:kbId/export/fine-tune`

Producerer JSONL-fil med 3 strategier kombineret:

**Strategy 1 — Q/A fra chat-historik**: enhver chat-query + high-confidence svar → `{prompt, completion}`-par (hvis user har opt'ed at inkludere chat-logs).

**Strategy 2 — Source → summary**: for hver source, `{prompt: "Summarize: {source-content-excerpt}", completion: "{source-summary-neuron-content}"}`.

**Strategy 3 — Concept Q&A synthesized**: LLM genererer 3-5 naturlige spørgsmål per concept-Neuron + svaret, givet Neuron'ens body som source-of-truth. ~$50-100 LLM-cost for 500 Neurons.

Output-format: JSONL kompatibel med OpenAI + Anthropic fine-tune-upload.

## How

- Ny service `apps/server/src/services/fine-tune-dataset-builder.ts`
- Kræver eksplicit opt-in per KB (data-handling-samtykke)
- Streamer JSONL over tid (kan være mange MB for store KBs)
- Ved Strategy 3: spawn claude-subprocess per Neuron med concurrency-limit (via F119)

## Dependencies

- F119 (parallelism runner) — Strategy 3 er parallel-friendly
- F121 (budget tracking) — stop export hvis tenant rammer budget-cap

## Success criteria

- Output er valid JSONL parserbar af standard fine-tune-pipelines
- Business-kunde kan eksportere, fine-tune en lille model (Haiku/Llama-variant), og querier efter den har internaliseret KB'en
- Marketing: "Train a model on your second brain"
- Pricing: engangs-kost $199-499 per eksport (dækker LLM-compute til Strategy 3 + infra)
