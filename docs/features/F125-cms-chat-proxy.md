# F125 — CMS Chat-Proxy with Citation-Enriched Response

> CMS-admin bruger kalder Trail's chat-API gennem sin egen server (bearer-auth), får svar + citations der inkluderer **både** Trail's `documentId` og den originale `cms-id`. CMS'en kan derfor linke citations direkte tilbage til sine egne docs-routes. Tier: Business default, Pro som add-on. Effort: 1 day. Status: Planned.

## Problem

F124 CMS-content-sync sender artikler ind. Chat-API returnerer citations — men citations indeholder kun Trail's `documentId`, ikke CMS'ens stable `cms-id`. CMS-sitet kan ikke nemt mappe citation → /docs-url uden at lave en ekstra lookup.

## Secondary Pain Points

- Extra round-trip from CMS to Trail to resolve documentId → cms-id
- CMS admin chat shows broken citation links (pointing to Trail URLs, not CMS docs)
- No locale information in citations for multi-lingual CMS setups

## Solution

Ingen ny endpoint — udvid eksisterende `/api/v1/chat` response:

```json
{
  "answer": "...",
  "citations": [
    {
      "documentId": "doc_abc",
      "filename": "field-types-reference.md",
      "slug": "field-types-reference",
      "cmsId": "art_xyz",         // ← NY: from documents.metadata.cmsId
      "locale": "en"              // ← NY
    }
  ]
}
```

`documents.metadata` JSON er populated af F124 med `cmsId + locale`. Chat-service's citation-serialisering udvides til at læse disse felter.

## Non-Goals

- New chat endpoint (existing /api/v1/chat is extended)
- CMS-specific chat behavior (same chat logic, enriched citations)
- Citation click tracking or analytics
- Multi-turn conversation state management (existing chat handles this)
- CMS authentication (bearer token validated, CMS handles its own auth)

## Technical Design

### Citation Serializer Extension

```typescript
// apps/server/src/services/chat.ts
interface Citation {
  documentId: string;
  filename: string;
  slug: string;
  cmsId?: string;    // NEW: optional, present only for CMS-sourced documents
  locale?: string;   // NEW: optional, present only for CMS-sourced documents
}

async function buildCitation(document: Document): Promise<Citation> {
  const citation: Citation = {
    documentId: document.id,
    filename: document.filename ?? '',
    slug: document.slug ?? '',
  };

  // Extract CMS metadata if present
  const metadata = parseMetadata(document.metadata);
  if (metadata.cmsId) {
    citation.cmsId = metadata.cmsId;
    citation.locale = metadata.locale;
  }

  return citation;
}
```

### Metadata Parsing

```typescript
function parseMetadata(raw: unknown): { cmsId?: string; locale?: string } {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  return {};
}
```

### Response Serialization

Null cmsId → udelades fra response (for ikke-CMS-sources):

```typescript
function serializeCitation(citation: Citation): Record<string, unknown> {
  const result: Record<string, unknown> = {
    documentId: citation.documentId,
    filename: citation.filename,
    slug: citation.slug,
  };
  if (citation.cmsId) result.cmsId = citation.cmsId;
  if (citation.locale) result.locale = citation.locale;
  return result;
}
```

## Interface

### Extended Chat Response

```typescript
// POST /api/v1/chat response (extended)
interface ChatResponse {
  answer: string;
  citations: {
    documentId: string;
    filename: string;
    slug: string;
    cmsId?: string;   // present only for CMS-sourced documents
    locale?: string;  // present only for CMS-sourced documents
  }[];
}
```

### OpenAPI Spec

Schema-dokumentér i OpenAPI-spec at cmsId and locale are optional fields present only when the cited document originated from a CMS sync.

## Rollout

**Single-phase deploy.** Citation extension is backward-compatible — existing consumers ignore new optional fields. No migration needed.

## Success Criteria

- @webhouse/cms admin-chat viser citations som clickable links til /docs/<slug> — verified: citation.cmsId maps to CMS route
- Non-CMS-sources i samme KB returneres uden cmsId-felt (ikke null, udeladt) — verified: citation object has no cmsId key
- OpenAPI-spec dokumenterer feltet tydeligt for SDK-consumers

## Impact Analysis

### Files created (new)

- None (extends existing chat service)

### Files modified

- `apps/server/src/services/chat.ts` (extend citation serializer to read cmsId/locale from metadata)
- `packages/shared/src/contracts.ts` (update ChatResponse Zod schema with optional cmsId/locale)

### Downstream dependents

`apps/server/src/services/chat.ts` is imported by 2 files:
- `apps/server/src/routes/chat.ts` (1 ref) — uses chat service, unaffected by citation extension
- `apps/server/src/routes/chat-sessions.ts` (1 ref) — manages sessions, unaffected
Citation extension is additive — response shape backward-compatible.

`packages/shared/src/contracts.ts` is imported by many files across the monorepo:
- `apps/server/src/routes/chat.ts` (1 ref) — validates response, needs update for new optional fields
- `apps/admin/src/components/chat-view.tsx` (1 ref) — displays chat, needs update to render cmsId links
- `packages/cms-connector-sdk/src/types.ts` (1 ref) — SDK types, needs update for new fields
Adding optional fields is backward-compatible — existing consumers ignore them.

### Blast radius

- Citation extension is additive — existing consumers that don't know about cmsId/locale will ignore them
- CMS-specific citation rendering in admin UI must handle missing cmsId gracefully
- OpenAPI spec must clearly document optional fields to avoid confusion for SDK consumers
- No database changes — metadata JSON already populated by F124

### Breaking changes

None — all changes are additive. New optional fields in existing response.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Chat response for CMS-sourced document includes cmsId and locale in citations
- [ ] Chat response for non-CMS document does NOT include cmsId or locale fields
- [ ] CMS admin chat renders citation as clickable link to /docs/<slug>
- [ ] OpenAPI spec includes cmsId and locale as optional fields
- [ ] Regression: chat API still returns correct answer + citations for non-CMS KBs
- [ ] Regression: chat session history still functions with enriched citations

## Implementation Steps

1. Update citation serializer in `chat.ts` to read `metadata.cmsId` and `metadata.locale`.
2. Update ChatResponse Zod schema in `packages/shared/src/contracts.ts` with optional fields.
3. Update citation serialization to omit null cmsId/locale (not include as null).
4. Update OpenAPI spec documentation.
5. Update admin chat-view component to render cmsId as clickable link.
6. End-to-end test: @webhouse/cms admin-chat shows citations linking to /docs/<slug>.

## Dependencies

- F124 (CMS content-sync populerer cmsId)

## Open Questions

None — all decisions made.

## Related Features

- **F124** (CMS Content-Sync) — populates cmsId in document metadata
- **F127** (CMS Connector SDK) — wraps chat-proxy with type-safe `ChatCitation<CmsContext>`
- **F126** (Contradiction Webhook to CMS) — uses cmsId for contradiction notifications

## Effort Estimate

**Small** — 1 day. Citation serializer extension + schema update + admin UI + OpenAPI spec.
