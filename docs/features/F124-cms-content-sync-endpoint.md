# F124 — CMS Content-Sync Endpoint

> Dedikerede endpoints `/api/v1/cms-connector/:kbId/articles` og `/bulk-sync` der lader eksterne CMS'er pushe artikler ind som Trail-sources. @webhouse/cms er pilot; pattern er reusable for Storyblok, Sanity, custom CMS'er. Se CMS-CONNECTOR.md for fuld spec. Tier: Business default, Pro som add-on ($30/mdr). Effort: 2 days. Status: Planned.

## Problem

I dag skal CMS-integrationer bruge Trail's generiske `/documents/upload` (multipart/form-data, fil-baseret) som er awkward til strukturerede artikler med metadata. Vi har ingen dedikeret kontrakt for CMS-kunder der vil sende artikel-opdateringer med stable IDs, idempotent upsert, og structured metadata.

## Secondary Pain Points

- No way to track which source came from which CMS
- No idempotent upsert — duplicate articles created on re-sync
- No structured metadata (version, locale, tags) passed through upload pipeline
- No bulk sync with prune (delete articles no longer in CMS)

## Solution

Dedikerede endpoints:

```
POST /api/v1/cms-connector/{kbId}/articles
Authorization: Bearer <connector-token>
Content-Type: application/json

{
  "id": "art_xyz",              // CMS's stable article ID
  "slug": "field-types",
  "title": "Field Types Reference",
  "path": "/docs/reference",
  "locale": "en",
  "markdown": "...",
  "metadata": {
    "version": "0.2.13",
    "updatedAt": "...",
    "tags": ["reference"],
    "author": "Christian"
  }
}

→ 201 Created | 200 OK (upsert by (kbId, cms-id))
```

Plus:

```
DELETE /api/v1/cms-connector/{kbId}/articles/{cmsId}
POST /api/v1/cms-connector/{kbId}/bulk-sync
  Body: { articles: [...], prune: boolean }
```

## Non-Goals

- CMS admin UI (CMS provides its own admin)
- Real-time sync (webhook-based, not polling)
- Bi-directional sync (CMS → Trail only, not Trail → CMS)
- Image extraction from CMS articles (that's F114 image archiving)
- Support for non-markdown content types (HTML, rich text — markdown only)

## Technical Design

### Route Handler

```typescript
// apps/server/src/routes/cms-connector.ts
app.post('/api/v1/cms-connector/:kbId/articles', async (req, res) => {
  const { kbId } = req.params;
  const { id, slug, title, path, locale, markdown, metadata } = req.body;

  // Upsert by (kbId, cms-id)
  const existing = await db.select().from(documents)
    .where(and(
      eq(documents.kbId, kbId),
      eq(sql`JSON_EXTRACT(${documents.metadata}, '$.cmsId')`, id),
    )).one();

  if (existing) {
    // Update
    await db.update(documents)
      .set({
        content: markdown,
        metadata: { ...metadata, cmsId: id, locale, path, slug },
        sourceKind: 'cms-md',
      })
      .where(eq(documents.id, existing.id));
    return res.status(200).json({ id: existing.id, action: 'updated' });
  } else {
    // Create
    const doc = await db.insert(documents).values({
      kbId,
      kind: 'source',
      content: markdown,
      metadata: { ...metadata, cmsId: id, locale, path, slug },
      sourceKind: 'cms-md',
    }).returning().one();
    return res.status(201).json({ id: doc.id, action: 'created' });
  }
});
```

### Bulk Sync

```typescript
app.post('/api/v1/cms-connector/:kbId/bulk-sync', async (req, res) => {
  const { kbId } = req.params;
  const { articles, prune } = req.body;

  const cmsIds = new Set<string>();
  for (const article of articles) {
    await upsertArticle(kbId, article);
    cmsIds.add(article.id);
  }

  if (prune) {
    // Archive sources no longer in batch
    await db.update(documents)
      .set({ archived: true })
      .where(and(
        eq(documents.kbId, kbId),
        eq(documents.kind, 'source'),
        eq(sql`JSON_EXTRACT(${documents.metadata}, '$.sourceKind')`, 'cms-md'),
        notInArray(sql`JSON_EXTRACT(${documents.metadata}, '$.cmsId')`, [...cmsIds]),
      ));
  }

  return res.json({ synced: articles.length, pruned: prune ? /* count */ 0 : undefined });
});
```

### Auth

Auth via bearer-token (tenant-scoped — connector-token registreret per tenant i Settings). Token validated against `api_keys` table with `scope: 'cms-connector'`.

### Source Kind

Kind='source' med `source-kind: 'cms-md'` (F132) aktiverer CMS-tilpasset compile-prompt.

## Interface

### Request/Response Contracts

```typescript
// POST /api/v1/cms-connector/:kbId/articles
interface UpsertArticleRequest {
  id: string;          // CMS stable article ID
  slug: string;
  title: string;
  path: string;
  locale: string;
  markdown: string;
  metadata?: Record<string, unknown>;
}

interface UpsertArticleResponse {
  id: string;
  action: 'created' | 'updated';
}

// POST /api/v1/cms-connector/:kbId/bulk-sync
interface BulkSyncRequest {
  articles: UpsertArticleRequest[];
  prune?: boolean;
}

interface BulkSyncResponse {
  synced: number;
  pruned?: number;
}

// DELETE /api/v1/cms-connector/:kbId/articles/:cmsId
interface DeleteArticleResponse {
  id: string;
  archived: true;
}
```

### Rate Limit

100 req/min per connector-token.

## Rollout

**Single-phase deploy.** New endpoints, new auth scope — no migration needed. @webhouse/cms is pilot customer.

## Success Criteria

- @webhouse/cms kan pushe artikler idempotent (samme article to gange giver ikke dublet) — verified: POST same article twice → 201 then 200, only 1 document row
- Bulk-sync + prune rydder forældede artikler — verified: bulk-sync with prune → archived count matches expected
- Latency < 500ms per single-article POST (measured)
- Rate-limit 100 req/min per connector-token — verified: 101st request returns 429

## Impact Analysis

### Files created (new)

- `apps/server/src/routes/cms-connector.ts`
- `apps/server/src/services/__tests__/cms-connector.test.ts`

### Files modified

- `apps/server/src/app.ts` (mount cms-connector routes)
- `apps/server/src/services/ingest.ts` (handle sourceKind='cms-md' for compile prompt)

### Downstream dependents

`apps/server/src/app.ts` is imported by 4 files:
- `apps/server/src/index.ts` (1 ref) — creates app, unaffected
- `apps/server/src/routes/auth.ts` (1 ref) — dev mode, unaffected
- `apps/server/src/routes/health.ts` (1 ref) — health check, unaffected
- `apps/server/src/routes/api-keys.ts` (1 ref) — API key routes, unaffected
Mounting new route is additive.

`apps/server/src/services/ingest.ts` is imported by 4 files:
- `apps/server/src/routes/uploads.ts` (1 ref) — triggers ingest, unaffected
- `apps/server/src/routes/documents.ts` (1 ref) — triggers ingest, unaffected
- `apps/server/src/routes/ingest.ts` (1 ref) — triggers ingest, unaffected
- `apps/server/src/index.ts` (1 ref) — recovers ingest jobs, unaffected
Adding cms-md source kind handling is internal — API surface unchanged.

### Blast radius

- New auth scope `cms-connector` must be validated correctly — wrong validation allows unauthorized article pushes
- Upsert logic must handle concurrent pushes to same article (race condition: two POSTs for same cmsId simultaneously)
- Bulk sync with prune must not archive non-CMS sources (filter by sourceKind='cms-md')
- Rate limit must be per-token, not global — one customer's burst should not affect others

### Breaking changes

None — all changes are additive. New endpoints, new auth scope.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] POST /cms-connector/:kbId/articles with new article → 201, document created with cmsId in metadata
- [ ] POST /cms-connector/:kbId/articles with existing cmsId → 200, document updated, no duplicate
- [ ] DELETE /cms-connector/:kbId/articles/:cmsId → document archived
- [ ] Bulk-sync with 10 articles → all 10 upserted
- [ ] Bulk-sync with prune=true → articles not in batch archived
- [ ] Rate limit: 100 requests in 1 minute succeed, 101st returns 429
- [ ] Auth: request without valid connector-token returns 401
- [ ] Regression: generic /documents/upload still works for non-CMS uploads

## Implementation Steps

1. Create `cms-connector.ts` route file with POST, DELETE, bulk-sync endpoints.
2. Implement upsert logic: match by (kbId, cmsId in metadata).
3. Implement bulk-sync with optional prune.
4. Add connector-token auth scope validation.
5. Add rate limiting (100 req/min per token).
6. Mount route in `app.ts`.
7. Update ingest service to handle sourceKind='cms-md' for compile prompt.
8. End-to-end test with @webhouse/cms pilot.

## Dependencies

- F132 (source-kind variants — CMS-md compile-prompt)
- F129 (cms:* connector registry)

## Open Questions

- Should the CMS connector support webhooks from CMS (CMS notifies Trail of changes) or only push from CMS? Webhook is more efficient but requires CMS support.
- Should bulk-sync be async job (for large article sets) or synchronous? Sync is simpler but may timeout for 1000+ articles.

## Related Features

- **F132** (Source-Kind Variants) — CMS-md compile prompt
- **F129** (CMS Connector Registry) — connector token registration
- **F125** (CMS Chat-Proxy) — uses cmsId from CMS-synced articles
- **F126** (Contradiction Webhook to CMS) — sends webhooks for CMS-sourced contradictions
- **F127** (CMS Connector SDK) — wraps these endpoints in type-safe SDK
- **F114** (Image Archiving) — images in CMS articles should be archived

## Effort Estimate

**Small** — 2 days. Routes + upsert logic + bulk-sync + auth + rate limit.
