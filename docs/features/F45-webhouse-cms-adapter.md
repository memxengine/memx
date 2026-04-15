# F45 — `@webhouse/cms` Adapter

> Strategic Phase 2 integration. Every @webhouse/cms site becomes a Trail consumer — zero per-site glue. CMS admin embeds a Trail panel; Trail reads and writes through the CMS content layer.

## Problem

Phase 2 needs a flagship adapter to prove the adapter SDK (F55) pattern and to unlock per-site AI knowledge for WebHouse customers. Today each site that wants LLM-backed knowledge has to integrate a separate RAG tool. @webhouse/cms has 135+ features and a mature editor surface — it's the right place to embed Trail.

## Solution

One `@webhouse/cms-trail` package that:

1. Reads CMS content (posts, pages, snippets, collections) and streams it into a Trail tenant as sources.
2. Embeds a Trail admin panel inside CMS admin — queue, wiki tree, chat — so editors curate their site's AI knowledge without leaving CMS.
3. Exposes a `{{trail-chat}}` shortcode (matching F45's shortcode family) that the static-site build expands to the `<trail-chat>` widget (F29) pointed at that site's Trail tenant.

Tenant provisioning is automatic: when a site enables the Trail plugin, the CMS admin calls `POST /api/v1/tenants` with the site's slug + owner, gets back a tenant id + API key, stores those in the site's `_secrets.json`.

## Technical Design

### Package layout

```
packages/trail-adapter/
├── src/
│   ├── sync.ts          # CMS content → Trail sources (ingest on save, bulk on first enable)
│   ├── admin.tsx        # Preact panel for CMS admin
│   ├── shortcode.ts     # {{trail-chat}} expander for build-time consumers
│   └── api-client.ts    # Typed client for Trail's /api/v1/*
└── package.json
```

Published as `@webhouse/cms-trail` from the `webhousecode/cms` repo.

### Data flow

```
CMS editor saves a post
      │
      ▼
post-save hook in cms-admin
      │
      ▼
@webhouse/cms-trail sync.ts
      │  POST /api/v1/knowledge-bases/{kb}/documents/upload
      │  body = { kind: "source", content: markdown, source_type: "cms-post", source_id: post.id }
      ▼
Trail engine → candidate → curator queue
      │
      ▼
Editor reviews in CMS admin's Trail panel
      │
      ▼
Approved wiki pages accessible via:
   - {{trail-chat}} shortcode on the live site (reader-facing)
   - /admin/trail/wiki in CMS admin (editor-facing)
```

### CMS admin panel (embedded)

New CMS admin route `/admin/trail` — renders an iframe or mounts the Preact admin (F18) using the site's tenant credentials. Single sign-on via the site owner's CMS session — no separate OAuth.

### Content change detection

- **On save:** `post`, `page`, `snippet`, or any collection with `trail.ingest: true` in `cms.config.ts` fires an async POST to `/api/v1/knowledge-bases/{kb}/documents/upload` with the rendered markdown.
- **On delete:** `source_retraction` candidate (F17 already supports this kind).
- **On first enable:** bulk ingest of the current corpus in backpressured chunks (F21).

### Shortcode

```typescript
// Extends packages/cms/src/build/shortcodes.ts (see intercom #26)
{{trail-chat}}                     // default tenant + default KB for this site
{{trail-chat|kb:research}}         // specific KB
{{trail-chat|kb:research|height:700}}
```

Expanded to the `<trail-chat>` widget (F29) with the site's tenant baked in. Survives CMS's tiptap-markdown roundtrip by the same mechanism as `{{svg:slug}}`.

## Impact Analysis

### Files affected (in `webhousecode/cms`)

- **Create:** `packages/trail-adapter/src/*`
- **Modify:** `packages/cms/src/hooks/post-save.ts` (add trail sync hook dispatch)
- **Modify:** `packages/cms-admin/src/app/admin/trail/**` (new admin route)
- **Modify:** `packages/cms/src/build/shortcodes.ts` (add `{{trail-chat}}`)
- **Add to config schema:** `trail: { enabled, tenantId, apiKey, defaultKb, ingest: { collections: [...] } }` in `cms.config.ts`

### Files affected (in `broberg-ai/trail`)

- **Modify:** `apps/server/src/routes/tenants.ts` — ensure `POST /api/v1/tenants` supports programmatic creation with a WebHouse-issued service token
- **Add:** service-token auth middleware for CMS-to-Trail calls (scoped to specific tenants)

### Downstream dependents

- Every `@webhouse/cms` site that opts in. `trail.enabled` defaults false — no implicit migration.
- Three CMS features are adjacent: F04 (dual MCP), F08 (RAG — supersedes), F09 (chat plugin — supersedes). F08 and F09 might be fully replaced by this adapter rather than coexisting.

### Blast radius

High but controllable. Opt-in via `trail.enabled`. Trail sync failures must not break CMS saves — they queue and retry. Missing tenant (wrong api-key) surfaces in the admin panel with a clear error, no effect on save path.

### Breaking changes

None to CMS core. `@webhouse/cms-trail` is a new peer dep. Shortcode `{{trail-chat}}` is a new token.

### Test plan

- [ ] Enable Trail on a test CMS site → admin provisions tenant, stores credentials
- [ ] Save a post → candidate appears in Trail queue within 10s
- [ ] Approve candidate in CMS admin's Trail panel → wiki page created
- [ ] `{{trail-chat}}` shortcode in a live page → widget renders, answers citing approved wiki content
- [ ] Delete source post in CMS → `source_retraction` candidate created
- [ ] Regression: CMS post save latency unchanged (trail sync fires async)
- [ ] Regression: Trail engine handles service-token auth without breaking user-session auth

## Implementation Steps

1. Trail side: add service-token auth scheme (scoped tokens, rate-limited) — small extension of existing session auth.
2. Trail side: expose tenant-create endpoint with service-token scope.
3. CMS side: scaffold `@webhouse/cms-trail` package.
4. CMS side: wire post-save hook to the sync function.
5. CMS side: add admin route mounting Trail's admin panel (either iframe `apps/admin` or package the Preact app as an embeddable module).
6. CMS side: extend shortcodes to handle `{{trail-chat}}`.
7. Pilot: enable Trail on a test WebHouse site, iterate on the UX.
8. FysioDK (F52) is the first production customer of this adapter.

## Dependencies

- F17 Curation Queue API (candidates)
- F18 Curator UI (embedded admin)
- F29 `<trail-chat>` widget (shortcode target)
- F40 Multi-tenancy (real tenant isolation)
- F55 Adapter SDK (this adapter is the reference implementation)

Unlocks: F52 FysioDK onboarding, F53 custom subdomains (CMS sites get their own `<site>.trail.broberg.ai` routing), F54 curator analytics.

## Effort Estimate

**Large** — 15-20 days across both repos. Parallelisable by splitting the CMS-side admin UI and the Trail-side service-token auth.
