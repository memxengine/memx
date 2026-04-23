# F82 — Custom LLM Provider Adapters (Azure / Ollama / Bedrock)

> Azure OpenAI, Ollama (local), AWS Bedrock, whatever ships next. Same LLM adapter surface as F14.

## Problem

Trail's LLM adapter (F14) understøtter i dag `claude -p` subprocess og Anthropic API. Men enterprise kunder kræver ofte:
- **Azure OpenAI** — compliance requirements, existing Azure investment
- **Ollama** — fully offline, self-hosted LLMs
- **AWS Bedrock** — enterprise AWS customers

Uden multi-provider support er Trail låst til Anthropic — en single point of failure og en barrier for enterprise adoption.

## Solution

F14's `LLMAdapter` interface udvides med implementations for Azure OpenAI, Ollama, og AWS Bedrock. Swap er én env-var ændring. Same interface, same behavior.

## Technical Design

### 1. Azure OpenAI Adapter

```typescript
// packages/llm/src/azure-adapter.ts

import { LLMAdapter, type LLMRequest, type LLMResponse } from './adapter.js';

export class AzureOpenAIAdapter implements LLMAdapter {
  readonly name = 'Azure OpenAI';

  constructor(
    private endpoint: string,
    private apiKey: string,
    private deployment: string,
    private apiVersion: string = '2024-02-01',
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const url = `${this.endpoint}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.7,
      }),
    });

    if (!res.ok) throw new Error(`Azure OpenAI error: ${res.status}`);

    const data = await res.json();
    return {
      text: data.choices[0].message.content,
      tokens: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens },
      model: this.deployment,
    };
  }
}
```

### 2. Ollama Adapter

```typescript
// packages/llm/src/ollama-adapter.ts

export class OllamaAdapter implements LLMAdapter {
  readonly name = 'Ollama';

  constructor(
    private baseUrl: string = 'http://localhost:11434',
    private model: string = 'llama3',
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: this.model,
        messages: req.messages,
        options: {
          num_predict: req.maxTokens,
          temperature: req.temperature ?? 0.7,
        },
        stream: false,
      }),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);

    const data = await res.json();
    return {
      text: data.message.content,
      tokens: { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 },
      model: this.model,
    };
  }
}
```

### 3. AWS Bedrock Adapter

```typescript
// packages/llm/src/bedrock-adapter.ts

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export class BedrockAdapter implements LLMAdapter {
  readonly name = 'AWS Bedrock';

  constructor(
    private region: string = 'eu-north-1',
    private model: string = 'anthropic.claude-3-sonnet-20240229-v1:0',
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const client = new BedrockRuntimeClient({ region: this.region });
    const command = new InvokeModelCommand({
      modelId: this.model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.7,
      }),
    });

    const response = await client.send(command);
    const body = JSON.parse(new TextDecoder().decode(response.body));

    return {
      text: body.content[0].text,
      tokens: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 },
      model: this.model,
    };
  }
}
```

### 4. Factory Update

```typescript
// packages/llm/src/factory.ts

export type LLMProvider = 'claude-cli' | 'anthropic' | 'azure' | 'ollama' | 'bedrock';

export function createLLMBackend(config: LLMConfig): LLMAdapter {
  switch (config.provider) {
    case 'azure':
      return new AzureOpenAIAdapter(config.azureEndpoint!, config.azureApiKey!, config.azureDeployment!);
    case 'ollama':
      return new OllamaAdapter(config.ollamaBaseUrl, config.ollamaModel);
    case 'bedrock':
      return new BedrockAdapter(config.bedrockRegion, config.bedrockModel);
    // ... existing providers ...
  }
}
```

## Impact Analysis

### Files created (new)
- `packages/llm/src/azure-adapter.ts`
- `packages/llm/src/ollama-adapter.ts`
- `packages/llm/src/bedrock-adapter.ts`
- `packages/llm/src/__tests__/azure-adapter.test.ts`

### Files modified
- `packages/llm/src/factory.ts` — add new providers
- `packages/llm/package.json` — add `@aws-sdk/client-bedrock-runtime`
- `apps/server/.env.example` — add new provider env vars

### Downstream dependents for modified files

**`packages/llm/src/factory.ts`** — used by `apps/server/src/services/claude.ts` and any other LLM consumer. Adding providers is additive — existing `claude-cli` and `anthropic` providers work unchanged.

### Blast radius
- New providers are opt-in via env vars — existing Anthropic/claude-cli unchanged
- Ollama requires local Ollama installation — documented in setup docs
- Bedrock requires AWS credentials — IAM role or env vars

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: Each adapter calls correct API endpoint
- [ ] Unit: Each adapter parses response correctly
- [ ] Integration: Azure adapter works with real endpoint (mock)
- [ ] Integration: Ollama adapter works with local Ollama
- [ ] Integration: Bedrock adapter works with AWS SDK (mock)
- [ ] Regression: Existing Anthropic/claude-cli providers unchanged

## Implementation Steps

1. Create Azure OpenAI adapter + unit tests
2. Create Ollama adapter + unit tests
3. Create AWS Bedrock adapter + unit tests
4. Update factory with new providers
5. Add env var examples
6. Integration test: swap provider → same behavior

## Dependencies

- F14 (Multi-Provider LLM Adapter) — base interface

## Effort Estimate

**Small** — 1-2 days

- Day 1: Azure + Ollama adapters + tests
- Day 2: Bedrock adapter + factory update + integration testing
