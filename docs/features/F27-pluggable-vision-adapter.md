# F27 — Pluggable Vision Adapter

> Narrow interface `VisionAdapter.describe(imageBuffer, { model, prompt }): Promise<string>` der gør det muligt at swappe Anthropic Claude → GPT-4V → Gemini → local Llava uden at ændre ingest pipelines.

## Problem

Trail's vision backend (`apps/server/src/services/vision.ts`) er hardcoded til Anthropic Claude. Det virker fint i dag, men:
- Anthropic API er ikke altid tilgængeligt (rate limits, outages)
- Nogle kunder vil bruge deres egen API key (GPT-4V, Gemini)
- Self-hosted kunder vil bruge local Llava/Ollama
- Cost-optimering: Haiku er billigst til simple beskrivelser, Sonnet til komplekse

I dag er vision-koden spredt ud over PDF-pipelinen og upload-routen. Der er ingen central adapter — hver pipeline kalder Anthropic direkte.

## Solution

En `VisionAdapter` interface med én implementering per provider. Default er Anthropic Haiku. Swap er én linje i config. Alle pipelines (PDF, image upload, web clipper) bruger den samme adapter.

## Technical Design

### 1. Vision Adapter Interface

```typescript
// packages/core/src/vision/adapter.ts

export interface VisionDescribeOptions {
  /** Model to use (provider-specific) */
  model?: string;
  /** Custom prompt for description (default: "Describe this image in detail") */
  prompt?: string;
  /** Max tokens for response (default: 500) */
  maxTokens?: number;
}

export interface VisionDescribeResult {
  /** The description text */
  description: string;
  /** Which model was used */
  model: string;
  /** Token usage (if available from provider) */
  tokens?: { input: number; output: number };
}

export interface VisionAdapter {
  /**
   * Describe an image buffer using the configured vision model.
   * @param imageBuffer — raw image bytes (PNG, JPEG, WebP supported)
   * @param options — model, prompt, maxTokens
   */
  describe(imageBuffer: Buffer, options?: VisionDescribeOptions): Promise<VisionDescribeResult>;

  /** Human-readable name for this adapter */
  readonly name: string;
}
```

### 2. Anthropic Implementation (existing, refactored)

```typescript
// packages/core/src/vision/anthropic-adapter.ts

import { VisionAdapter, type VisionDescribeOptions, type VisionDescribeResult } from './adapter.js';

export class AnthropicVisionAdapter implements VisionAdapter {
  readonly name = 'Anthropic';

  constructor(
    private apiKey: string,
    private defaultModel: string = 'claude-3-haiku-20240307',
  ) {}

  async describe(
    imageBuffer: Buffer,
    options: VisionDescribeOptions = {},
  ): Promise<VisionDescribeResult> {
    const model = options.model ?? this.defaultModel;
    const prompt = options.prompt ?? 'Describe this image in detail. Include text, objects, colors, layout, and any notable features.';
    const maxTokens = options.maxTokens ?? 500;

    const base64 = imageBuffer.toString('base64');
    const mediaType = this.detectMediaType(imageBuffer);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const description = data.content[0].text;

    return {
      description,
      model,
      tokens: {
        input: data.usage?.input_tokens ?? 0,
        output: data.usage?.output_tokens ?? 0,
      },
    };
  }

  private detectMediaType(buffer: Buffer): string {
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return 'image/png'; // default
  }
}
```

### 3. OpenAI Implementation

```typescript
// packages/core/src/vision/openai-adapter.ts

import { VisionAdapter, type VisionDescribeOptions, type VisionDescribeResult } from './adapter.js';

export class OpenAIVisionAdapter implements VisionAdapter {
  readonly name = 'OpenAI';

  constructor(
    private apiKey: string,
    private defaultModel: string = 'gpt-4o',
  ) {}

  async describe(
    imageBuffer: Buffer,
    options: VisionDescribeOptions = {},
  ): Promise<VisionDescribeResult> {
    const model = options.model ?? this.defaultModel;
    const prompt = options.prompt ?? 'Describe this image in detail.';
    const maxTokens = options.maxTokens ?? 500;

    const base64 = imageBuffer.toString('base64');
    const mediaType = this.detectMediaType(imageBuffer);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
          ],
        }],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const description = data.choices[0].message.content;

    return {
      description,
      model,
      tokens: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  private detectMediaType(buffer: Buffer): string {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
    return 'image/png';
  }
}
```

### 4. Factory + Config

```typescript
// packages/core/src/vision/factory.ts

import { VisionAdapter } from './adapter.js';
import { AnthropicVisionAdapter } from './anthropic-adapter.js';
import { OpenAIVisionAdapter } from './openai-adapter.js';

export type VisionProvider = 'anthropic' | 'openai' | 'none';

export interface VisionConfig {
  provider: VisionProvider;
  apiKey?: string;
  model?: string;
}

export function createVisionBackend(config: VisionConfig): VisionAdapter | null {
  switch (config.provider) {
    case 'anthropic':
      if (!config.apiKey) return null;
      return new AnthropicVisionAdapter(config.apiKey, config.model);
    case 'openai':
      if (!config.apiKey) return null;
      return new OpenAIVisionAdapter(config.apiKey, config.model);
    case 'none':
      return null;
    default:
      return null;
  }
}
```

### 5. Usage in Existing Pipelines

```typescript
// apps/server/src/services/vision.ts — refactor existing

import { createVisionBackend, type VisionConfig } from '@trail/core';

// Current: hardcoded Anthropic call
// New: use adapter

export function createVisionBackendFromEnv(): VisionAdapter | null {
  const config: VisionConfig = {
    provider: (process.env.TRAIL_VISION_PROVIDER as VisionConfig['provider']) ?? 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY,
    model: process.env.TRAIL_VISION_MODEL,
  };
  return createVisionBackend(config);
}
```

## Impact Analysis

### Files created (new)
- `packages/core/src/vision/adapter.ts` — interface definition
- `packages/core/src/vision/anthropic-adapter.ts` — Anthropic implementation (refactored from existing)
- `packages/core/src/vision/openai-adapter.ts` — OpenAI implementation
- `packages/core/src/vision/factory.ts` — provider factory
- `packages/core/src/vision/__tests__/anthropic-adapter.test.ts`
- `packages/core/src/vision/__tests__/factory.test.ts`

### Files modified
- `apps/server/src/services/vision.ts` — refactor to use adapter
- `packages/core/src/index.ts` — export vision module
- `apps/server/src/routes/uploads.ts` — use adapter instead of direct Anthropic call

### Downstream dependents for modified files

**`apps/server/src/services/vision.ts`** — imported by `routes/uploads.ts` and `pipelines/pdf.ts`. Refactoring to use adapter is internal — callers still call `createVisionBackend()` with same signature.

**`packages/core/src/index.ts`** — adding vision export is additive.

**`apps/server/src/routes/uploads.ts`** — no downstream dependents.

### Blast radius
- Existing vision calls continue to work — Anthropic adapter is drop-in replacement
- `ANTHROPIC_API_KEY` env var still works (factory reads it)
- New `TRAIL_VISION_PROVIDER` and `OPENAI_API_KEY` env vars are optional
- PDF pipeline and image upload both use the same adapter — consistent behavior

### Breaking changes
None. The `createVisionBackend()` function signature stays the same.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `AnthropicVisionAdapter.describe` calls correct API endpoint with base64 image
- [ ] Unit: `OpenAIVisionAdapter.describe` calls correct API endpoint
- [ ] Unit: `createVisionBackend` returns correct adapter based on config
- [ ] Unit: `createVisionBackend` returns null for unknown provider or missing API key
- [ ] Integration: PDF upload with vision → description appears in source content
- [ ] Integration: Switch to OpenAI provider → vision calls go to OpenAI API
- [ ] Regression: Existing PDF pipeline with Anthropic still works
- [ ] Regression: Image upload with vision still works

## Implementation Steps

1. Create `packages/core/src/vision/adapter.ts` interface
2. Move existing Anthropic code from `apps/server/src/services/vision.ts` to `anthropic-adapter.ts`
3. Create `openai-adapter.ts` implementation
4. Create `factory.ts` with provider selection
5. Refactor `apps/server/src/services/vision.ts` to use factory
6. Update PDF pipeline and upload route to use adapter
7. Add unit tests for each adapter
8. Add integration test: swap provider, verify vision calls go to correct API

## Dependencies

- F08 (PDF Pipeline) — uses vision for image descriptions
- F25 (Image Source Pipeline) — standalone image vision descriptions
- F14 (Multi-Provider LLM Adapter) — similar pattern, but for chat LLMs

## Effort Estimate

**Small** — 1-2 days

- Day 1: Interface + Anthropic refactor + OpenAI adapter + factory
- Day 2: Integration with existing pipelines + tests
