# F33 — Fly.io `arn` Deploy for `apps/server`

> Move the engine from "runs on Christian's Mac" to "runs on Fly.io Stockholm". Single-tenant Phase 1 deploy with volume-backed SQLite.

## Problem

Phase 1 is feature-complete locally but has no production deploy story. Sanne onboarding (F37) blocks on this. Every infrastructure decision we've deferred (secrets, volumes, domains, monitoring) needs to land at once.

## Solution

Ship `infra/fly/` with a reference `fly.toml` + secrets recipe + volume setup for Fly.io Stockholm (`arn`). Region choice is explicit per global policy — trail NEVER deploys to US or Amsterdam.

## Technical Design

### Fly app shape

```toml
# infra/fly/fly.toml
app = "trail-engine"
primary_region = "arn"

[build]
  dockerfile = "infra/fly/Dockerfile"

[env]
  PORT = "3031"
  TRAIL_DATA_DIR = "/data"
  TRAIL_DB_PATH = "/data/trail.db"
  TRAIL_UPLOADS_DIR = "/data/uploads"
  APP_URL = "https://admin.trail.broberg.ai"
  API_URL = "https://api.trail.broberg.ai"
  CHAT_MODEL = "claude-haiku-4-5-20251001"

[[mounts]]
  source = "trail_data"
  destination = "/data"

[http_service]
  internal_port = 3031
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1
```

### Dockerfile

Node 22 base (production runtime). Install deps with pnpm, copy `apps/server` + `packages/*`, build, `CMD ["node", "apps/server/dist/index.js"]`.

### Secrets

Set via `fly secrets set -a trail-engine`:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — F35
- `ANTHROPIC_API_KEY` — for vision (F08) and optional chat backend (F14)
- `SESSION_SECRET` — cookie signing, `openssl rand -hex 32`

### Volume

```
fly volumes create trail_data --region arn --size 10 -a trail-engine
```

Holds SQLite DB + uploaded source files. Backup policy: `fly volumes snapshots create`. Phase 2 (F42 R2 storage) moves uploads off the volume; DB stays.

### Domain + TLS

```
fly certs create api.trail.broberg.ai -a trail-engine
```

DNS: CNAME `api.trail.broberg.ai` → `trail-engine.fly.dev`. Covers admin via F34.

### Healthcheck

Add `GET /api/v1/health` to `apps/server` returning `{ ok: true, version, db: "ok" }`. Fly healthcheck config: `[[services.checks]] interval = "10s" grace_period = "30s" method = "get" path = "/api/v1/health"`.

## Impact Analysis

### Files affected

- **Create:** `infra/fly/{fly.toml, Dockerfile, deploy.sh, README.md}`
- **Create:** `apps/server/src/routes/health.ts`
- **Modify:** `apps/server/src/index.ts` (mount health route, listen on `PORT`)
- **Modify:** root `README.md` (deploy section)

### Downstream dependents

- None internal — infra is additive.
- External: `APP_URL` and `API_URL` env change the OAuth callback registration — coordinate with F35.

### Blast radius

Deploy can't break local dev. The main risk is volume-backed SQLite — must verify that `better-sqlite3` bindings run under the Node 22 Docker image (not an issue with Bun in dev).

### Breaking changes

None to code. Operational: MCP stdio entrypoint (`TRAIL_MCP_ENTRY`) currently resolves relative to the local monorepo layout — on Fly.io it needs to resolve to the packaged `/app/apps/mcp/dist/index.js`. Dockerfile must bake this path.

### Test plan

- [ ] `fly deploy` builds the Docker image and rolls out
- [ ] `curl https://api.trail.broberg.ai/api/v1/health` returns 200
- [ ] Volume persists SQLite across machine restarts (deploy twice, verify DB contents)
- [ ] Google OAuth login roundtrip works with production client
- [ ] Upload a markdown source via the admin → ingest completes → wiki pages appear
- [ ] Backup: snapshot the volume and restore into a scratch app, verify data integrity

## Implementation Steps

1. Write `infra/fly/Dockerfile` that builds the monorepo to a production image.
2. Write `fly.toml` with all env, mounts, healthchecks.
3. Add `/api/v1/health` endpoint.
4. Create Fly app (`fly apps create trail-engine --org broberg-ai`).
5. Create volume + attach.
6. Set secrets.
7. Deploy + smoke test.
8. Add `deploy.sh` wrapping the release + migration step (`bun run db:push` or similar).
9. Document the flow in `infra/fly/README.md`.

## Dependencies

- F35 OAuth production credentials (for post-deploy login test)

Unlocks: F34 (landing shares the same DNS zone), F36 (dogfooding needs a live endpoint), F37 (Sanne onboarding lands here).

## Effort Estimate

**Small** — 2-3 days including first deploy + smoke tests + documentation.
