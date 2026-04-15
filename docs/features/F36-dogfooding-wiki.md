# F36 — `docs.trailmem.com` as a Trail Brain

> The documentation site for Trail is itself a Trail brain. Every commit to `broberg-ai/trail/docs/**` ingests into a dedicated tenant, compiles into a wiki, and publishes at `docs.trailmem.com`. We use our own product to document our own product.

## Problem

Docs sites built on static site generators (Docusaurus, Nextra, Mintlify) are fine but they're disconnected from the thing they document. Trail's whole pitch is that knowledge should compound; a trail-powered docs site dogfoods that claim, generates credible live content, and surfaces anything that breaks in real production traffic before customers hit it.

Also — we just made `docs.webhouse.app` the de-facto AI-discoverable docs for @webhouse/cms. Trail's docs site should land the same pattern but using Trail rather than a static generator.

## Solution

A dedicated Trail tenant (`trailwiki`) deployed alongside the SaaS multi-tenant cluster (F40). A GitHub Action in `broberg-ai/trail` watches the `docs/**` tree and re-ingests on every push. The reader-facing interface at `docs.trailmem.com` is a Trail read-only surface: wiki tree sidebar, full-text search, embedded chat.

This is not a traditional docs site — it's a live brain that happens to be seeded from our markdown docs.

## Technical Design

### Tenant layout

```
tenant: trailwiki
  knowledge_bases:
    - docs       (the trail/docs/**.md tree)
    - features   (docs/features/F*.md)
    - primer     (PRIMER.md, ROADMAP.md, SESSION-START.md)
```

Separate KBs so search on the frontpage can scope — "searching in the engine docs" vs "searching in the feature roadmap".

### Ingest pipeline

A GitHub Action runs on push to `main`:

```yaml
# broberg-ai/trail/.github/workflows/sync-docs-to-trailmem.yml
on:
  push:
    branches: [main]
    paths: ['docs/**']
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sync docs to Trail brain
        run: |
          for f in $(git diff --name-only HEAD^ HEAD -- 'docs/**.md'); do
            curl -X POST https://app.trailmem.com/api/v1/knowledge-bases/docs/documents/upload \
              -H "Authorization: Bearer ${{ secrets.TRAILMEM_TENANT_TOKEN }}" \
              -F "file=@$f" \
              -F "source_type=github" \
              -F "source_id=$f"
          done
```

Each markdown file becomes a source. Trail's existing markdown pipeline (F09) handles the compile. Candidates flow into the trailwiki tenant's queue — a maintainer approves in the CMS-adapter panel (F45) or the curator UI (F18).

### Reader-facing site

`docs.trailmem.com` is served by a thin read-only frontend sitting on top of the Trail API:

```
docs.trailmem.com/                    → wiki index (feature tags, categories)
docs.trailmem.com/wiki/:slug          → rendered wiki page with [[cross-refs]]
docs.trailmem.com/search?q=…          → FTS5 search across the trailwiki tenant's KBs
docs.trailmem.com/chat                → chat widget (F29) pointed at trailwiki
docs.trailmem.com/features/F17        → rendered feature plan
docs.trailmem.com/sources/:slug       → raw source view (for provenance)
```

Two options for how to implement the reader site:

1. **Static generator, built per push** — simpler, shares infra with F34 landing. Loses real-time compile updates; page is stale until next build.
2. **Live Trail read-surface** — connects to the Trail engine at request time, streams fresh content. More infrastructure but actually demonstrates what Trail does.

Recommend (2) — it's the dogfooding point. A minimalist Preact/Lit SSR/SSG app that reads from Trail's API.

### URLs and brand

`docs.trailmem.com` — primary docs host. Configured on Cloudflare DNS, CNAME to wherever the read-surface is deployed (Fly.io `arn`).

## Impact Analysis

### Files affected

- **Create (in `broberg-ai/trail`):** `.github/workflows/sync-docs-to-trailmem.yml`
- **Create (new repo or `apps/docs-site/`):** a small read-surface app reading the trailwiki tenant
- **Secrets:** `TRAILMEM_TENANT_TOKEN` (service token scoped to trailwiki tenant)
- **DNS:** `docs.trailmem.com` CNAME via DNS MCP

### Downstream dependents

- Links across the Trail repo currently point at `docs.webhouse.app` or `trail.broberg.ai/docs` — after launch, rewrite to `docs.trailmem.com`.
- The F34 landing site's "Documentation" nav link currently points to `#docs` (stub) — re-target to `docs.trailmem.com`.

### Blast radius

Contained. Docs site failure doesn't break the engine or customers — it just breaks the public docs. Keep a read-only GitHub mirror of the raw markdown as a fallback.

### Breaking changes

None — new surface.

### Test plan

- [ ] A push changing `docs/features/F17-*.md` triggers the workflow
- [ ] The trailwiki tenant's queue shows new candidates within 60s
- [ ] Approved candidates render at `docs.trailmem.com/features/F17`
- [ ] Search `docs.trailmem.com/search?q=queue` returns F17
- [ ] Chat at `docs.trailmem.com/chat` answers "what's the curation queue?" citing F17
- [ ] Regression: `trail.broberg.ai` landing unaffected
- [ ] Dogfood signal: if the Trail engine degrades, docs degrade — visible as a forcing function

## Implementation Steps

1. Provision `trailwiki` tenant on `app.trailmem.com` (depends on F40).
2. Seed `docs`, `features`, `primer` KBs manually via one-time bulk upload.
3. Write the sync-docs workflow.
4. Generate a service token (F45 service-token auth) scoped to trailwiki.
5. Scaffold `apps/docs-site/` (or a dedicated `broberg-ai/trail-docs` repo).
6. Implement the read-surface: wiki browser, search, chat embed, feature routes.
7. Deploy to Fly.io arn.
8. Configure `docs.trailmem.com` CNAME via DNS MCP.
9. Write a "you are reading a Trail brain" banner on every page — honest about the dogfooding.

## Dependencies

- F17 Curation Queue API (candidates flow)
- F28 Pipeline Interface (markdown pipeline already covered by F09)
- F29 `<trail-chat>` Widget (embedded chat surface)
- F33 Fly.io server deploy (read-surface hosts alongside engine)
- F40 Multi-tenancy (trailwiki is a tenant on `app.trailmem.com`)
- F45 @webhouse/cms adapter (service-token auth path)

Unlocks: credible public demo. Every F-plan doc in the repo becomes browsable + searchable at `docs.trailmem.com/features/F{nn}`.

## Effort Estimate

**Medium** — 6-8 days once F40 is in place. Without F40, fold into a single-tenant Phase 1 deploy at `docs.trail.broberg.ai` as an interim (2-3 days) and migrate to trailmem when multi-tenancy lands.
