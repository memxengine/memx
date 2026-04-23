# F127 — @trail/cms-connector-sdk NPM Package

> Tier: infrastruktur. Effort: 2-3 days. Planned.

## Problem

CMS-kunder der integrerer med Trail skal i dag:
- Læse OpenAPI-spec
- Bygge egen HTTP-client
- Håndtere retry, bearer-auth-rotation, webhook-signatur
- Type-definere request/response shapes

Det er ~3-5 dages integrations-arbejde. Med en SDK reduceres det til få linjer.

## Secondary Pain Points

- No TypeScript types for Trail CMS API consumers
- Each CMS integration rebuilds the same HTTP client logic
- Webhook signature verification is error-prone when implemented from scratch
- Token rotation requires manual client re-initialization

## Solution

`@trail/cms-connector-sdk` eksponerer type-safe TypeScript/JavaScript-API der wrapper F124+F125+F126-endpoints:

```ts
import { TrailCmsConnector } from '@trail/cms-connector-sdk';

const trail = new TrailCmsConnector({
  baseUrl: process.env.TRAIL_BASE_URL!,
  token: process.env.TRAIL_CONNECTOR_TOKEN!,
  kbId: process.env.TRAIL_KB_ID!,
});

// Push artikel
await trail.upsertArticle({ id, slug, title, path, locale, markdown, metadata });

// Delete
await trail.deleteArticle(id);

// Bulk sync med prune
await trail.bulkSync({ articles, prune: true });

// Chat-proxy
const response = await trail.chat({ message: "...", locale: "en" });

// Webhook handler
const handler = trail.webhookHandler({
  onContradictionDetected: async (event) => { /* show in CMS admin */ },
});
app.post('/trail-webhook', handler);
```

SDK håndterer:
- HMAC-signatur verifikation (F128)
- Automatic retry på 5xx + network errors
- TypeScript-typings for alle request/response shapes
- Token-rotation advisory (logger warning ved 401 så kunden ved token er udløbet)

## Non-Goals

- SDK for non-CMS Trail APIs (chat-only, queue-only, etc.)
- Browser SDK (Node.js/server-side only)
- Framework-specific integrations (Express, Fastify, etc. — generic handler only)
- Automatic CMS admin UI (SDK provides types + handlers, CMS builds UI)

## Technical Design

### Package Structure

```
packages/cms-connector-sdk/
├── src/
│   ├── index.ts          # exports
│   ├── client.ts         # TrailCmsConnector class
│   ├── types.ts          # TypeScript interfaces
│   ├── retry.ts          # Retry logic
│   ├── webhook.ts        # Webhook handler + HMAC verification
│   └── errors.ts         # Custom error classes
├── package.json
├── tsconfig.json
└── README.md
```

### Main Class

```typescript
// packages/cms-connector-sdk/src/client.ts
interface TrailCmsConnectorConfig {
  baseUrl: string;
  token: string;
  kbId: string;
  retryOptions?: {
    maxRetries?: number;    // default 3
    retryDelayMs?: number;  // default 1000
  };
}

export class TrailCmsConnector {
  private baseUrl: string;
  private token: string;
  private kbId: string;
  private retryOptions: Required<NonNullable<TrailCmsConnectorConfig['retryOptions']>>;

  constructor(config: TrailCmsConnectorConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.kbId = config.kbId;
    this.retryOptions = {
      maxRetries: config.retryOptions?.maxRetries ?? 3,
      retryDelayMs: config.retryOptions?.retryDelayMs ?? 1000,
    };
  }

  async upsertArticle(article: CmsArticleRequest): Promise<CmsArticleResponse> {
    return this.request<CmsArticleResponse>(
      `POST /api/v1/cms-connector/${this.kbId}/articles`,
      article
    );
  }

  async deleteArticle(cmsId: string): Promise<void> {
    await this.request<void>(
      `DELETE /api/v1/cms-connector/${this.kbId}/articles/${cmsId}`
    );
  }

  async bulkSync(request: BulkSyncRequest): Promise<BulkSyncResponse> {
    return this.request<BulkSyncResponse>(
      `POST /api/v1/cms-connector/${this.kbId}/bulk-sync`,
      request
    );
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.request<ChatResponse>(
      `POST /api/v1/chat`,
      { ...request, kbId: this.kbId }
    );
  }

  webhookHandler(config: WebhookHandlerConfig): RequestHandler {
    return createWebhookHandler(this.token, config);
  }

  private async request<T>(route: string, body?: unknown): Promise<T> {
    // HTTP call with retry, auth header, error handling
  }
}
```

### Retry Logic

```typescript
// packages/cms-connector-sdk/src/retry.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries: number; retryDelayMs: number }
): Promise<T> {
  for (let i = 0; i < options.maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === options.maxRetries - 1) throw err;
      if (isRetryableError(err)) {
        await sleep(options.retryDelayMs * Math.pow(2, i));
      } else {
        throw err;
      }
    }
  }
  throw new Error('unreachable');
}
```

### Webhook Handler

```typescript
// packages/cms-connector-sdk/src/webhook.ts
interface WebhookHandlerConfig {
  secret: string;
  onContradictionDetected?: (event: ContradictionWebhookPayload) => Promise<void>;
}

export function createWebhookHandler(
  secret: string,
  config: WebhookHandlerConfig
): RequestHandler {
  return async (req, res) => {
    const signature = req.headers['x-trail-signature'];
    const body = req.rawBody;

    if (!verifyHmac(secret, body, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(body);
    switch (event.type) {
      case 'contradiction_detected':
        if (config.onContradictionDetected) {
          await config.onContradictionDetected(event);
        }
        break;
    }

    res.status(200).json({ received: true });
  };
}
```

### Build Configuration

Bundle: esm + cjs via `tsup`.

```typescript
// tsup.config.ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  external: ['node:http', 'node:crypto'],
});
```

## Interface

```typescript
// Exported types
export interface CmsArticleRequest { /* ... */ }
export interface CmsArticleResponse { /* ... */ }
export interface BulkSyncRequest { /* ... */ }
export interface BulkSyncResponse { /* ... */ }
export interface ChatRequest { /* ... */ }
export interface ChatResponse { /* ... */ }
export interface Citation { /* ... */ }
export interface ContradictionWebhookPayload { /* ... */ }

// Error classes
export class TrailApiError extends Error { /* ... */ }
export class TrailAuthError extends TrailApiError { /* ... */ }
export class TrailRateLimitError extends TrailApiError { /* ... */ }
```

## Rollout

**Phased deploy:**
1. Create package structure + types
2. Implement client with retry logic
3. Implement webhook handler
4. Publish to NPM
5. Update @webhouse/cms to use SDK
6. Add docs-site on trail.broberg/sdk

## Success Criteria

- NPM: `npm install @trail/cms-connector-sdk` virker
- 10-linjers quickstart i README demonstrerer fuld content-sync
- TypeScript-typings er fuldkomplette (ingen `any`)
- Mønster-test: @webhouse/cms-integration bruger SDK for alle Trail-kald

## Impact Analysis

### Files created (new)
- `packages/cms-connector-sdk/src/index.ts`
- `packages/cms-connector-sdk/src/client.ts`
- `packages/cms-connector-sdk/src/types.ts`
- `packages/cms-connector-sdk/src/retry.ts`
- `packages/cms-connector-sdk/src/webhook.ts`
- `packages/cms-connector-sdk/src/errors.ts`
- `packages/cms-connector-sdk/package.json`
- `packages/cms-connector-sdk/tsconfig.json`
- `packages/cms-connector-sdk/tsup.config.ts`
- `packages/cms-connector-sdk/README.md`

### Files modified
- `pnpm-workspace.yaml` (add cms-connector-sdk package)
- `turbo.json` (add build pipeline for new package)

### Downstream dependents
New file — no dependents yet.

### Blast radius

- New NPM package — must be published separately from Trail monorepo releases
- SDK versioning must be independent of Trail server versioning
- Breaking changes in Trail API (F124/F125/F126) require SDK version bump
- SDK is a consumer-facing package — must have thorough docs and examples
- Token rotation advisory (401 warning) must not log secrets

### Breaking changes

None — new package, no existing consumers.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck` (in cms-connector-sdk package)
- [ ] `npm pack` produces valid package with esm + cjs bundles
- [ ] `TrailCmsConnector` constructor validates required config
- [ ] `upsertArticle` sends correct POST request with auth header
- [ ] `deleteArticle` sends correct DELETE request
- [ ] `bulkSync` sends correct POST with articles array
- [ ] `chat` sends correct POST and returns typed response
- [ ] Retry logic retries on 5xx, does not retry on 4xx
- [ ] Webhook handler verifies HMAC signature
- [ ] Webhook handler rejects invalid signature with 401
- [ ] No `any` types in exported type definitions
- [ ] README quickstart code compiles without errors

## Implementation Steps

1. Create `packages/cms-connector-sdk/` directory with package.json, tsconfig.json, tsup.config.ts.
2. Add package to `pnpm-workspace.yaml` and `turbo.json`.
3. Create `src/types.ts` with all request/response interfaces.
4. Create `src/errors.ts` with custom error classes.
5. Create `src/retry.ts` with exponential backoff retry logic.
6. Create `src/client.ts` with `TrailCmsConnector` class.
7. Create `src/webhook.ts` with HMAC verification + handler factory.
8. Create `src/index.ts` with exports.
9. Write README.md with quickstart guide.
10. Build and test package locally with `npm pack`.
11. Publish to NPM.
12. Update @webhouse/cms to use SDK.

## Dependencies

- F124 (content-sync endpoint)
- F125 (chat-proxy)
- F126 (webhook — for handler-feature)
- F128 (signed payloads — SDK handles verification)

## Open Questions

None — all decisions made.

## Related Features

- **F124** (CMS Content-Sync) — SDK wraps content-sync endpoints
- **F125** (CMS Chat Proxy) — SDK wraps chat endpoint
- **F126** (Contradiction Webhook to CMS) — SDK provides webhook handler
- **F128** (Signed Payloads) — SDK handles HMAC verification

## Effort Estimate

**Medium** — 2-3 days.
- Day 1: Package structure + types + client class
- Day 2: Retry logic + webhook handler + README
- Day 3: NPM publish + @webhouse/cms integration test
