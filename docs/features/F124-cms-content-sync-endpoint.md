# F124 — CMS Content-Sync Endpoint

*Planned. Tier: Business default, Pro som add-on ($30/mdr). Effort: 2 days.*

> Dedikerede endpoints `/api/v1/cms-connector/:kbId/articles` og `/bulk-sync` der lader eksterne CMS'er pushe artikler ind som Trail-sources. @webhouse/cms er pilot; pattern er reusable for Storyblok, Sanity, custom CMS'er. Se CMS-CONNECTOR.md for fuld spec.

## Problem

I dag skal CMS-integrationer bruge Trail's generiske `/documents/upload` (multipart/form-data, fil-baseret) som er awkward til strukturerede artikler med metadata. Vi har ingen dedikeret kontrakt for CMS-kunder der vil sende artikel-opdateringer med stable IDs, idempotent upsert, og structured metadata.

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

## How

- Ny route-fil `apps/server/src/routes/cms-connector.ts`
- Auth via bearer-token (tenant-scoped — connector-token registreret per tenant i Settings)
- Upsert-logik: `WHERE kbId = ? AND JSON_EXTRACT(metadata, '$.cmsId') = ?` matcher
- Kind='source' med `source-kind: 'cms-md'` (F132) aktiverer CMS-tilpasset compile-prompt
- Bulk `prune=true` archiverer ikke-længere-i-batch-sources

## Dependencies

- F132 (source-kind variants — CMS-md compile-prompt)
- F129 (cms:* connector registry)

## Success criteria

- @webhouse/cms kan pushe artikler idempotent (samme article to gange giver ikke dublet)
- Bulk-sync + prune rydder forældede artikler
- Latency < 500ms per single-article POST
- Rate-limit 100 req/min per connector-token
