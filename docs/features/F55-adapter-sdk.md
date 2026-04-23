# F55 — Adapter SDK (`@trail/adapter-sdk`)

> Publiceret `@trail/adapter-sdk` npm package for 3rd-party CMS/DMS integrationer. Definerer expected content model, ingest hooks, og rendering hooks.

## Problem

Når 3rd-party udviklere vil integrere deres CMS med Trail, skal de forstå Trail's interne API, schema, og ingest flow. Der er ingen officiel SDK der gør det nemt at bygge en adapter. Hver adapter (WordPress, Sanity, Notion) starter from scratch med samme boilerplate.

## Solution

Et `@trail/adapter-sdk` package der eksporterer:
1. **Content model interfaces** — hvad en adapter skal levere (documents, metadata, webhooks)
2. **Ingest client** — authenticated client til Trail API med retry logic
3. **Webhook helpers** — sign/verify webhook payloads (F128)
4. **Adapter base class** — skeleton med lifecycle methods (onContentChange, onIngestComplete)

## Technical Design

### 1. Package Structure

```
packages/adapter-sdk/
├── src/
│   ├── index.ts              — public API exports
│   ├── client.ts             — Trail API client
│   ├── adapter.ts            — base adapter class
│   ├── webhook.ts            — webhook sign/verify
│   ├── types.ts              — content model interfaces
│   └── __tests__/
├── package.json              — published as @trail/adapter-sdk
└── README.md                 — usage examples
```

### 2. Content Model Interfaces

```typescript
// packages/adapter-sdk/src/types.ts

export interface AdapterDocument {
  /** Unique ID in the source CMS */
  id: string;
  /** Document title */
  title: string;
  /** Content in markdown format */
  content: string;
  /** Content type: 'article' | 'page' | 'post' | 'custom' */
  type: string;
  /** Last modified timestamp */
  updatedAt: string;
  /** Source URL */
  url?: string;
  /** Author/contributor info */
  author?: string;
  /** Tags/categories */
  tags?: string[];
  /** Custom metadata passed through to Trail */
  metadata?: Record<string, unknown>;
}

export interface AdapterConfig {
  /** Trail server URL */
  trailUrl: string;
  /** Trail API key */
  apiKey: string;
  /** Target KB ID */
  kbId: string;
  /** Polling interval in seconds (default: 300) */
  pollInterval?: number;
  /** Webhook secret for incoming webhooks */
  webhookSecret?: string;
}
```

### 3. Trail API Client

```typescript
// packages/adapter-sdk/src/client.ts

export class TrailClient {
  constructor(private config: AdapterConfig) {}

  async uploadDocument(doc: AdapterDocument): Promise<{ id: string }> {
    const formData = new FormData();
    formData.append('file', new Blob([doc.content], { type: 'text/markdown' }), `${doc.id}.md`);
    formData.append('metadata', JSON.stringify({
      connector: 'adapter',
      sourceUrl: doc.url,
      adapterType: doc.type,
      ...doc.metadata,
    }));

    const res = await fetch(`${this.config.trailUrl}/api/v1/knowledge-bases/${this.config.kbId}/documents/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: formData,
    });

    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json();
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const res = await fetch(
      `${this.config.trailUrl}/api/v1/knowledge-bases/${this.config.kbId}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${this.config.apiKey}` } },
    );
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    return res.json();
  }

  async chat(question: string, sessionId?: string): Promise<ChatResponse> {
    const res = await fetch(`${this.config.trailUrl}/api/v1/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        knowledgeBaseId: this.config.kbId,
        question,
        sessionId,
      }),
    });
    if (!res.ok) throw new Error(`Chat failed: ${res.status}`);
    return res.json();
  }
}
```

### 4. Adapter Base Class

```typescript
// packages/adapter-sdk/src/adapter.ts

export abstract class TrailAdapter {
  protected client: TrailClient;

  constructor(protected config: AdapterConfig) {
    this.client = new TrailClient(config);
  }

  /** Called when content changes in the source CMS */
  abstract onContentChange(docId: string): Promise<void>;

  /** Called when ingest completes for a document */
  abstract onIngestComplete(docId: string, neuronIds: string[]): Promise<void>;

  /** Sync all content from CMS to Trail */
  async syncAll(): Promise<void> {
    const docs = await this.fetchAllDocuments();
    for (const doc of docs) {
      await this.client.uploadDocument(doc);
    }
  }

  /** Fetch all documents from the source CMS */
  abstract fetchAllDocuments(): Promise<AdapterDocument[]>;

  /** Fetch a single document by ID */
  abstract fetchDocument(id: string): Promise<AdapterDocument>;

  /** Start polling for changes */
  startPolling(): void {
    const interval = (this.config.pollInterval ?? 300) * 1000;
    setInterval(() => this.pollForChanges(), interval);
  }

  /** Poll for changes since last sync */
  abstract pollForChanges(): Promise<void>;
}
```

### 5. Webhook Helpers

```typescript
// packages/adapter-sdk/src/webhook.ts

import { createHmac, timingSafeEqual } from 'node:crypto';

export function signWebhook(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyWebhook(payload: string, signature: string, secret: string): boolean {
  const expected = signWebhook(payload, secret);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

## Impact Analysis

### Files created (new)
- `packages/adapter-sdk/src/index.ts` — public exports
- `packages/adapter-sdk/src/client.ts` — Trail API client
- `packages/adapter-sdk/src/adapter.ts` — base adapter class
- `packages/adapter-sdk/src/webhook.ts` — webhook helpers
- `packages/adapter-sdk/src/types.ts` — content model interfaces
- `packages/adapter-sdk/package.json` — published package config
- `packages/adapter-sdk/README.md` — usage documentation

### Files modified
- `pnpm-workspace.yaml` — include adapter-sdk in workspace
- `packages/shared/src/connectors.ts` — add `adapter` connector ID

### Downstream dependents for modified files

**`pnpm-workspace.yaml`** — adding workspace package affects all packages. No breaking changes.

### Blast radius
- SDK is a new package — no impact on existing code
- `adapter` connector ID is additive to existing connectors
- Published as separate npm package — versioned independently

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: TrailClient.uploadDocument sends correct request
- [ ] Unit: TrailClient.search returns parsed results
- [ ] Unit: TrailClient.chat sends correct request
- [ ] Unit: signWebhook/verifyWebhook work correctly
- [ ] Unit: Adapter base class lifecycle methods are abstract
- [ ] Integration: Mock Trail server → adapter uploads document → appears in queue
- [ ] Integration: Webhook signature verification works end-to-end

## Implementation Steps

1. Create packages/adapter-sdk/ directory structure
2. Implement types, client, adapter base class, webhook helpers
3. Write unit tests for all modules
4. Create package.json with publish config
5. Write README with usage examples
6. Add `adapter` connector to connectors registry
7. Integration test: adapter uploads document to real Trail server
8. Publish to npm (private or public based on licensing)

## Dependencies

- F128 (Signed Webhook Payloads) — webhook sign/verify
- F95 (Connectors) — `adapter` connector ID

## Effort Estimate

**Medium** — 2-3 days

- Day 1: Types + client + adapter base class + unit tests
- Day 2: Webhook helpers + README + integration tests
- Day 3: Package config + npm publish setup + docs
