# F34 — Landing Site Deploy (`trailmem.com` + `trail.broberg.ai`)

> The static landing site already builds clean from `@webhouse/cms examples/static/trail`. This feature is the deploy recipe — DNS, hosting, CI, and the wiring between three hostnames that all serve the same landing: `trailmem.com`, `www.trailmem.com`, `trail.broberg.ai`.

## Problem

Landing site content + build pipeline is mature (commits across `webhousecode/cms` in April 2026). It's served at `localhost:3026` via sirv during development but has no production host. No one can share a link yet. This also blocks F36 (docs.trailmem.com, whose scope differs but shares the static deploy pattern).

Three hostnames need to resolve to the same artifact:

- **`trailmem.com`** and **`www.trailmem.com`** — primary SaaS identity; evolves over time to include concept + tech + data + posts, and later the signup path into `app.trailmem.com` (F40).
- **`trail.broberg.ai`** — engine-facing identity; serves the landing so visitors finding Trail through the broberg-ai GitHub org land somewhere real.

## Solution

Deploy the static site once to Fly.io static (`arn`) or Cloudflare Pages. Point all three hostnames at the same target via CNAMEs on Cloudflare (both `trailmem.com` and `broberg.ai` are on Cloudflare). CI is a GitHub Action in the `webhousecode/cms` repo that rebuilds on pushes to `examples/static/trail/**` and redeploys — all three hosts pick up the new content simultaneously.

The landing content itself is one build, three hostnames. No content fork.

## Technical Design

### Hosting choice

Two candidates, recommend picking before implementation:

| | Fly.io static (`arn`) | Cloudflare Pages |
|---|---|---|
| Region | arn (policy-compliant) | Auto-distributed edge (includes arn POP) |
| Cost | Trivial (static site, tiny footprint) | Free tier ample |
| CI | Fly deploy via action | GitHub integration native |
| DNS | CNAME to `trail.fly.dev` | CNAME to `trail.pages.dev` |
| OG image | Same | Same |
| Chosen approach | Preferred — keeps infra on one vendor | Backup if Fly static ergonomics are poor |

Recommend Fly.io static for vendor consolidation with F33.

### Build artifact

The @webhouse/cms static-site generator (`examples/static/trail/build.ts`) already produces `dist/` with 14+ HTML pages, SVGs, captions, and clickable tags. The Fly app wraps `dist/` in a tiny nginx or `sirv` container and serves it.

### DNS

Both `trailmem.com` and `broberg.ai` are on Cloudflare. Configure via the internal DNS MCP (`mcp__dns-manager__dns_upsert_record`). Target is the Fly.io static app's `*.fly.dev` hostname once F33-equivalent static deploy exists.

```
# trailmem.com zone
@           CNAME   trail-landing.fly.dev.     (apex flattened by Cloudflare)
www         CNAME   trail-landing.fly.dev.

# broberg.ai zone
trail       CNAME   trail-landing.fly.dev.
```

Fly TLS:

```
fly certs create trailmem.com       -a trail-landing
fly certs create www.trailmem.com   -a trail-landing
fly certs create trail.broberg.ai   -a trail-landing
```

For the apex record (`trailmem.com`), Cloudflare CNAME flattening handles the CNAME-at-apex restriction automatically — no need to manually resolve to an A record.

### CI

GitHub Action in `webhousecode/cms`:

```yaml
# .github/workflows/deploy-trail-landing.yml
on:
  push:
    branches: [main]
    paths:
      - 'examples/static/trail/**'
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @webhouse/cms-example-trail build
      - run: flyctl deploy --config examples/static/trail/fly.toml --remote-only
        working-directory: examples/static/trail
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN_TRAIL }}
```

### Fly static container

```dockerfile
# examples/static/trail/Dockerfile
FROM nginx:alpine
COPY dist/ /usr/share/nginx/html/
RUN sed -i 's|try_files $uri $uri/ =404|try_files $uri $uri/ $uri.html =404|' /etc/nginx/conf.d/default.conf
```

### OAuth + chat widget wiring

Once F29 (widget) ships, the landing hero can optionally embed a live `<trail-chat tenant="trailwiki" kb="trail">` pointing at F36's dogfooding tenant. For launch we ship without the live widget — just the static feature copy.

## Impact Analysis

### Files affected

- **Create (in `webhousecode/cms`):** `examples/static/trail/fly.toml`, `examples/static/trail/Dockerfile`, `.github/workflows/deploy-trail-landing.yml`
- **Modify (in `broberg-ai/trail`):** `docs/` readme to point to live landing
- **DNS:** add `trail.broberg.ai` CNAME in WebHouse DNS manager

### Downstream dependents

- None in-repo. External: anywhere we've printed "trail.broberg.ai" (docs, social) — no current live references.

### Blast radius

Zero risk to the engine (F33). Static deploy failure means the landing is stale — doesn't affect customers.

### Breaking changes

None — this is a new surface.

### Test plan

- [ ] `flyctl deploy --config examples/static/trail/fly.toml` succeeds
- [ ] `https://trailmem.com/` returns 200, renders home hero
- [ ] `https://www.trailmem.com/` returns 200, identical content
- [ ] `https://trail.broberg.ai/` returns 200, identical content
- [ ] All three hostnames serve `/the-1945-concept/` with 4 SVG figures
- [ ] Tag links resolve (`/tags/memex/`, `/tags/material-elasticity/`)
- [ ] CI triggers on a push to `examples/static/trail/content/pages/home.json`
- [ ] Refresh on CI-deployed page shows the edit across all three hosts
- [ ] Regression: local dev at `localhost:3026` still works

## Implementation Steps

1. Pick host (recommend Fly.io static).
2. Write `Dockerfile` + `fly.toml` in `examples/static/trail/`.
3. `flyctl apps create trail-landing --org broberg-ai`.
4. Initial `flyctl deploy` with pre-built `dist/`.
5. Add CNAME in WebHouse DNS; `flyctl certs create trail.broberg.ai`.
6. Verify live URL.
7. Write the GitHub Action; test by pushing a trivial content change.
8. Register `FLY_API_TOKEN_TRAIL` secret on the repo.
9. Document in `examples/static/trail/README.md`.

## Dependencies

- Landing site build pipeline (`@webhouse/cms` — already shipped)
- DNS access to `broberg.ai` (WebHouse DNS manager — have it)

Unlocks: F36 (dogfooding wiki shares the pattern), F45 (@webhouse/cms adapter has a demo landing to point at).

## Effort Estimate

**Small** — 1-2 days including DNS, TLS, CI.
