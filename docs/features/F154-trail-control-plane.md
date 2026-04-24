# F154 — Trail Control Plane

> Remote management & deployment center for hele Trail-produktionen. Fleet-dashboard, tenant-provisioning, Pro→Business cutover, cost-overblik, alerting. Tier: Phase 2 · Effort: Large · Status: Planned.

## Problem

`SAAS-SCALING-PLAN.md` beskriver en fleet på op til 45-50 Fly Machines ved Stadig 3 (200-500 tenants). Den fleet kan **ikke** drives fra terminalen. Christian skal:

- Se hvilke Machines der kører, i hvilke regions, med hvilke tenants
- Spawne ny tenant uden at skrive `fly machines run` manuelt
- Trigger Pro→Business upgrade (spawn dedicated Machine, DB-snapshot, DNS cutover) uden 20-minutters ad-hoc runbook
- Se daglig Fly-spend pr. app, sammenlignet med MRR
- Modtage alerts når pools rammer kapacitetsgrænser
- Restart/deploy/rollback pr. app uden at huske Fly CLI-kommandoer

I dag findes intet af dette. Pt. har Trail kun én Fly-app (ikke deployet endnu — F33 er Planned). Hver operation kommer til at være en terminalsession hos Christian. Det skalerer til 10 tenants, ikke til 500.

**Custom-behov ud over Fly Dashboard:**
- Fly Dashboard viser Machines, ikke tenants. Vi har én Machine med 15 tenants, og Fly ved det ikke.
- Fly Dashboard viser ikke MRR, cost-per-tenant, ingest-queue-depth — vi har den data i libSQL.
- Fly Dashboard har ingen "upgrade Pro→Business"-knap. Det er en multi-step operation: DB-snapshot + DNS + notify-kunde.
- Fly Dashboard har ingen GDPR-export eller impersonate-read-only.

## Secondary Pain Points

- **Ingen audit-log over fleet-handlinger.** Hvis en tenant får rullet sit DB tilbage 48 timer, hvilken commit fra Christian gjorde det? Svar i dag: ingen.
- **Ingen runbook-automation.** "Sådan flytter vi en tenant mellem regioner" er en tekst-fil, ikke en knap.
- **Ingen on-call overdragelse.** Hvis vi hyrer ops-person, skal de lære Fly CLI + alle libSQL-migrations-kommandoer. Med Control Plane: de klikker i en UI.
- **Remote-access til tenant-data for support kræver SSH ind på Machine + libSQL CLI.** Skalerer ikke, og logger ingenting.

## Solution

Én ny admin-app (`trail-control-plane`) der er *ikke* er tenant-facing. Den lever på et separat subdomain — fx `ops.trailmem.com` — bag Christian's egen SSO-login (initialt: `u-christian` hardcoded). Den læser fra:

1. **Fly Machines API** (`machines.fly.io`) — fleet-status, spawn/resize/decommission.
2. **Fly GraphQL API** — daglig spend pr. app, bandwidth, volume-størrelser.
3. **Per-tenant libSQL** — indirekte via cross-DB query (control plane åbner read-only connection til hver tenant-DB for statistik).
4. **Trail engine's interne endpoints** — `/api/v1/internal/fleet-status` som control plane kalder for aggregeret queue-depth, LLM-cost, aktive curatorer.

Og skriver til:

1. **Fly API** — `POST /machines` ved provisioning, `PATCH /machines/<id>` ved resize.
2. **DNS via Cloudflare API** — CNAME-updates ved Pro→Business cutover.
3. **Stripe API** — subscription-status lookup ved fleet-operations (ikke billing-mutations; det kører F43's egen surface).

## Non-Goals

- **Ikke tenant-facing.** End-users logger på `app.trailmem.com` (engine), ikke Control Plane. Helt adskilte UI-kodebaser.
- **Ikke erstatning for Fly Dashboard.** Fly's egen UI bruges stadig til root-ops (billing, org-settings, WireGuard, secrets-rotation). Control Plane er et *tenant-centered* lag ovenpå.
- **Ikke automation af pool-provisioning.** F154 viser + udløser manuelle handlinger. Auto-scaling (policy-drevet automatisk spawn) er F155's scope.
- **Ikke multi-org.** Control Plane kender kun broberg-ai Fly-org. Hvis vi får Reseller Partners der kører deres egen Fly-org, bygger vi en separat `ops-partner.trailmem.com` senere.
- **Ikke mobile-first.** Desktop-first UI. Mobile notifications håndteres via F154's alerting, ikke et mobile-UI.
- **Ikke real-time collaboration.** Én operatør ad gangen. Låsning via optimistic-writes + alerts.
- **Ikke on-prem Control Plane.** Enterprise on-prem (F72) får en separat binary. F154 er SaaS-only.

## Technical Design

### 1. Ny app — `apps/control-plane`

En separat Vite + Preact app i monorepo, kompileret til statiske assets, serveret via Fly-app `trail-control-plane` bag `ops.trailmem.com`.

```
apps/control-plane/
├── src/
│   ├── panels/
│   │   ├── fleet.tsx              # Alle Fly-apps, deres Machines, health
│   │   ├── tenant-provision.tsx   # Create new tenant form
│   │   ├── tenant-upgrade.tsx     # Pro→Business cutover wizard
│   │   ├── alerts.tsx             # Alert inbox (from F44 metering + F155)
│   │   ├── cost.tsx               # Fly-spend vs MRR per app
│   │   ├── support.tsx            # Impersonate-read-only + GDPR export
│   │   └── audit-log.tsx          # Hvem klikkede hvad hvornår
│   ├── lib/
│   │   ├── fly-api.ts             # Wraps Fly Machines + GraphQL
│   │   ├── cloudflare-api.ts      # DNS mutation
│   │   └── tenant-discovery.ts    # Cross-tenant DB queries
│   └── app.tsx
├── fly.toml
└── package.json
```

### 2. Ny app — `apps/control-plane-api` (backend)

En lille Hono-server der:
- Autentificerer operatøren via Google OAuth (samme flow som engine)
- Exposer proxying til Fly API (Fly-token lever kun server-side)
- Exposer cross-tenant DB-queries
- Skriver audit-log entries til en dedikeret `control_plane_audit` libSQL-DB

```
apps/control-plane-api/
├── src/
│   ├── routes/
│   │   ├── fleet.ts       # GET /fleet → aggregeret status
│   │   ├── tenants.ts     # POST /tenants (provision), POST /tenants/:id/upgrade, DELETE /tenants/:id
│   │   ├── alerts.ts      # GET /alerts, POST /alerts/:id/ack
│   │   └── audit.ts       # GET /audit
│   ├── services/
│   │   ├── fly-client.ts
│   │   ├── tenant-lifecycle.ts
│   │   └── alert-store.ts
│   └── index.ts
├── fly.toml
└── package.json
```

### 3. Fleet data model

```typescript
// packages/shared/src/fleet.ts
export interface FlyAppSummary {
  name: string;                        // "trail-pro-pool-1"
  tier: 'hobby' | 'starter' | 'pro' | 'business' | 'enterprise' | 'control';
  region: string;                       // "arn"
  machines: Array<{
    id: string;
    state: 'started' | 'stopped' | 'destroyed';
    cpuKind: string;                    // "shared" | "performance"
    cpus: number;
    memoryMb: number;
    createdAt: string;
  }>;
  tenants: Array<{
    id: string;
    slug: string;
    plan: 'hobby' | 'starter' | 'pro' | 'business' | 'enterprise';
    dbSizeBytes: number;
    neuronCount: number;
    lastActiveAt: string | null;
    mrrCents: number;
  }>;
  estimatedMonthlyCostCents: number;   // Fra Fly GraphQL
}

export interface AlertRow {
  id: string;
  severity: 'info' | 'warn' | 'critical';
  category: 'capacity' | 'cost' | 'health' | 'security' | 'quota';
  app?: string;
  tenantId?: string;
  subject: string;
  details: string;
  createdAt: string;
  ackBy: string | null;
  ackAt: string | null;
}
```

### 4. Tenant lifecycle operations

Tre operationer, hver deres wizard:

**Provision new tenant.**
1. Operatør udfylder form (email, ønsket plan, subdomain-slug)
2. Control Plane vælger pool-app baseret på tier + ledig kapacitet
3. Kalder `/api/v1/internal/tenants` på engine for at oprette tenant-record + tomme libSQL-filer
4. Kalder Cloudflare API for `<slug>.trailmem.com` DNS (CNAME til Fly Anycast)
5. Stripe-subscription initialiseres (for paid tiers)
6. Sender velkomst-mail via SendGrid
7. Audit-log entry

**Pro → Business upgrade.**
1. Operatør vælger Pro-tenant fra pool-liste
2. Wizard preview'er: "Flytter `sanne` fra `trail-pro-pool-1` → ny dedicated app `trail-business-sanne`. Estimeret 5 min downtime. Klik Confirm."
3. Spawn Fly-app + Machine
4. Engine kører `VACUUM INTO /tmp/snapshot.db` på source-DB
5. SCP/S3-transfer snapshot til target-volume
6. Target-engine starter, verificerer DB
7. Cloudflare DNS flip `sanne.trailmem.com` → ny Machine-IP
8. Poll health på target
9. Source engine marker tenant-DB som `migrated_out` (read-only fallback 24h)
10. Rollback-knap tilgængelig 24t, derefter slettes source-DB
11. Audit-log med før/efter-snapshot

**Decommission tenant.**
1. Operatør markerer tenant til sletning med confirmation (type slug for at bekræfte)
2. 30-dages grace period — tenant-data flyttes til `/archive/<tenantId>/` på samme volume
3. Efter 30d: volume-sweep sletter filer, storage-prefix slettes, DNS fjernes, Stripe cancel
4. Audit-log

### 5. Alert-ingestion

Engine sender alerts til Control Plane via `POST /alerts`:

```typescript
// apps/server/src/services/alert-emit.ts
export async function emitFleetAlert(alert: Omit<AlertRow, 'id' | 'createdAt' | 'ackBy' | 'ackAt'>): Promise<void> {
  if (!process.env.CONTROL_PLANE_URL) return;
  await fetch(`${process.env.CONTROL_PLANE_URL}/alerts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.CONTROL_PLANE_TOKEN}` },
    body: JSON.stringify(alert),
  });
}
```

Sources af alerts:
- F44 Usage Metering — "tenant X rammer 90% af Pro-Neuron-quota"
- F143 Ingest Queue — "queue depth >50, backpressure i effekt"
- F151 Cost Dashboard — "tenant X bruger €15/dag LLM, 3× sin plan-average"
- Zombie-ingest-detector (apps/server/src/bootstrap/zombie-ingest.ts)
- Link-checker (F148) — "tenant X har 200+ åbne broken_links"

### 6. Audit-log

Dedikeret libSQL-DB (`/data/control-plane/audit.db`) med events:

```sql
CREATE TABLE control_plane_audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  operator_user_id TEXT NOT NULL,
  action TEXT NOT NULL,               -- 'provision', 'upgrade', 'decommission', 'restart', 'deploy', 'impersonate', ...
  target_type TEXT NOT NULL,          -- 'app', 'tenant', 'machine'
  target_id TEXT NOT NULL,
  payload_json TEXT,                  -- fuld operations-payload
  result TEXT NOT NULL,               -- 'success', 'failure', 'rolled_back'
  error_message TEXT
);
CREATE INDEX idx_cpa_at ON control_plane_audit(at DESC);
CREATE INDEX idx_cpa_operator ON control_plane_audit(operator_user_id, at DESC);
CREATE INDEX idx_cpa_target ON control_plane_audit(target_type, target_id, at DESC);
```

Appendix-only: ingen UPDATE/DELETE nogensinde. Hver handling = én række.

### 7. Cost calculation

Daglig cron kalder Fly GraphQL `/billing` endpoint, henter per-app spend seneste 24 timer, persister i control plane's egen DB:

```sql
CREATE TABLE fleet_daily_spend (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  app_name TEXT NOT NULL,
  machine_hours_cents INTEGER NOT NULL,
  volume_hours_cents INTEGER NOT NULL,
  network_egress_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  UNIQUE(date, app_name)
);
```

UI sammenligner med aggregeret MRR fra tenants (hentet fra Stripe via F43's data).

## Interface

### Public (intern for Christian):

- `https://ops.trailmem.com/` — SPA
- `https://ops-api.trailmem.com/api/v1/` — JSON API

### Endpoints (control-plane-api):

```
GET   /fleet                          → FlyAppSummary[]
GET   /fleet/:appName                 → FlyAppSummary
POST  /fleet/:appName/restart         → 202 Accepted
POST  /fleet/:appName/deploy          → body: { gitSha }, 202 Accepted

GET   /tenants                        → TenantSummary[] across all pools
POST  /tenants                        → { email, plan, slug } → provision
POST  /tenants/:id/upgrade            → { toPlan } → Pro→Business
POST  /tenants/:id/decommission       → { confirmSlug }
POST  /tenants/:id/impersonate        → { ttlMinutes } → read-only token
GET   /tenants/:id/export             → streams GDPR zip

GET   /alerts                          → AlertRow[]
POST  /alerts/:id/ack                  → 200
POST  /alerts/:id/dismiss              → 200

GET   /cost/fleet-spend                → daily breakdown
GET   /cost/margin                     → aggregated MRR − cost

GET   /audit                           → audit-log (paginated)
GET   /audit/:id                       → single entry
```

### Secrets env:

- `FLY_API_TOKEN` — personal access token for broberg-ai org
- `CLOUDFLARE_API_TOKEN` — scoped to trailmem.com zone
- `STRIPE_API_KEY` — read-only for subscription lookup
- `ENGINE_INTERNAL_TOKEN` — for calling engine's `/api/v1/internal/*` endpoints
- `SENDGRID_API_KEY` — velkomst-mails og alerts

## Rollout

**Phase 1 (M4, under F33 Fly deploy):** Provision new tenant only. Formular → engine endpoint → Fly API. Ingen alerts, ingen cost-view, ingen upgrade. Ship med F33 som første ikke-Sanne tenant onboarding-tool.

**Phase 2 (M6-M7):** Fleet dashboard + Pro→Business upgrade. Daglig cost-sync fra Fly GraphQL. Alerts begynder at ankomme. Audit-log live.

**Phase 3 (M9-M12):** Impersonate-read-only, GDPR export, decommission-wizard. Cross-tenant statistik (neuron-count, active curator-count). Søgbar audit-log.

**Phase 4 (M15+):** On-call handoff-ready — runbook-links fra alerts, `oncall@trailmem.com` mail-route.

Migration: hver phase er en separat commit-batch og kan rollbackes uden impact på engine. Control Plane har ingen write-path til tenant-data udenfor provisioning/upgrade/decommission — så en fejl i Control Plane kan *ikke* korrumpere eksisterende tenant-DB'er.

## Success Criteria

1. **Provision new tenant end-to-end i <60s.** Operatør klikker submit, tenant får velkomst-mail, kan logge ind — målt over 10 provisioninger.
2. **Pro→Business upgrade cutover <5min og 0 data-tab.** Verificeret på test-tenant; DB-row count før/efter matcher.
3. **Fleet-status latency <2s.** GET /fleet returnerer data fra cache <2s (real-time <10s for non-cached).
4. **Alert-til-notifikation <30s.** Engine emitter → Control Plane UI / email → operatør modtager, fra emit-tidspunkt.
5. **Audit coverage 100%.** Enhver write-operation i Control Plane har tilsvarende audit-entry. Verificeret via stikprøve-match (10 operationer = 10 audit-rows).
6. **Operatør uden Fly CLI-viden kan udføre alle almindelige ops-opgaver.** Testes ved at hyre/onboarde én ekstern ops-person og lade dem provisione + upgrade uden CLI-access.

## Impact Analysis

### Files created (new)

- `apps/control-plane/` — hele Vite+Preact app (subfoldere: src/panels/, src/lib/, src/components/)
- `apps/control-plane/package.json`, `vite.config.ts`, `fly.toml`, `Dockerfile`
- `apps/control-plane-api/` — hele Hono-server
- `apps/control-plane-api/package.json`, `fly.toml`, `Dockerfile`
- `packages/shared/src/fleet.ts` — FleetAppSummary, AlertRow, TenantSummary types
- `packages/shared/src/control-plane-api.ts` — shared type contracts
- `apps/server/src/routes/internal.ts` — new internal endpoints for cross-tenant queries
- `apps/server/src/services/alert-emit.ts` — emit-side helper
- `packages/db/drizzle/control-plane/0001_init.sql` — audit-log schema
- `packages/db/drizzle/control-plane/0002_fleet_daily_spend.sql` — cost-log schema
- `docs/runbooks/provision-tenant.md`, `upgrade-pro-business.md`, `decommission.md` — hjælpe-dokumentation
- `docs/features/F154-trail-control-plane.md` (dette dokument)

### Files modified

- `apps/server/src/index.ts` — mount new `internal.ts` routes, wire `alert-emit`
- `apps/server/src/services/ingest-queue.ts` — emit alert when backpressure triggers
- `apps/server/src/services/usage-metering.ts` (F44, når landed) — emit alerts ved 80/90/100% quota
- `apps/server/src/services/cost-aggregator.ts` (F151) — emit "tenant 3× average LLM-cost"-alert
- `docs/FEATURES.md` — index-row
- `docs/ROADMAP.md` — Phase 2 + critical path update
- `pnpm-workspace.yaml` — register new apps
- `turbo.json` — build-graph for nye apps

### Downstream dependents

`apps/server/src/services/ingest-queue.ts` er importeret af:
- `apps/server/src/routes/queue.ts` (3 refs) — uaffected, bare tilføjer emit-call internt
- `apps/server/src/bootstrap/zombie-ingest.ts` (1 ref) — uaffected
- `apps/server/scripts/verify-persistent-queue.ts` (1 ref) — uaffected

`apps/server/src/services/cost-aggregator.ts` er importeret af:
- `apps/server/src/routes/cost.ts` (2 refs) — uaffected
- Ingen andre.

`apps/server/src/index.ts` påvirker hele engine-startup; alert-emit skal være no-op når `CONTROL_PLANE_URL` er unset (lokal dev).

### Blast radius

- **Engine-forstyrrelse** — engine har nu fire nye "internal" endpoints (`/api/v1/internal/*`) der kræver bearer-token. Fejl i tokenvalidering kan blokere Control Plane fra at kalde dem. Mitigering: scripted verify `apps/server/scripts/verify-internal-endpoints.ts` der runs pre-deploy.
- **Fly-ressourceforbrug** — Control Plane polling Fly GraphQL kan ramme rate-limits. Mitigering: daglig cron (ikke live), local cache 5min TTL.
- **DNS-mutations via Cloudflare API** — forkert CNAME kan tage tenant offline. Mitigering: wizard preview'er før/efter-CNAME og kræver confirm-type-slug.
- **Per-tenant DB-queries** — Control Plane åbner read-only connection til hver tenant-DB ved fleet-view. Ved 500 tenants er det 500 file-descriptors. Mitigering: pooled connection, lazy open, close efter 60s idle.
- **Audit-DB-vækst** — ved 500 tenants × 5 ops/dag = 2500 rows/dag. ~1M rows/år. Håndterbart, men planlæg rotation efter 3 år.

### Breaking changes

Ingen på tenant-facing flader. Det eneste der er additivt:
- Nye `/api/v1/internal/*` endpoints på engine (bearer-token-gated, ikke på existing-paths)
- Ny `fleet` server-udgående alert-emit (no-op lokalt uden CONTROL_PLANE_URL)

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `tenant-lifecycle.ts` provision flow mocked mod Fly + Cloudflare stubs
- [ ] Unit: Audit-log append-only invariant (no UPDATE/DELETE allowed)
- [ ] Unit: Alert-ingestion rejects requests without bearer-token
- [ ] Integration: End-to-end provision mod dev-Fly-app + ngrok DNS
- [ ] Integration: Pro→Business cutover på test-tenant, assert DB-row-count preserved
- [ ] Integration: Operatør uden Fly CLI kan provisione via UI
- [ ] Manual: Verify alert email ankommer <30s efter engine-emit
- [ ] Manual: Cost-view viser >0 spend efter 24 timer
- [ ] Regression: Engine tenant-ops (F40) stadig virker uændret
- [ ] Regression: F153 R2-backup stadig kører på alle tenant-DB'er (inkl. Control Plane audit-db)
- [ ] Regression: F143 persistent ingest queue stadig overlever engine-restart

## Implementation Steps

1. **Stub scaffold** — opret `apps/control-plane` + `apps/control-plane-api` som tomme Vite+Hono apps, tilføj til workspace, verify `pnpm typecheck` på tværs
2. **Fly-API-client** — `apps/control-plane-api/src/services/fly-client.ts` der wrapper Machines + GraphQL API med 5min cache
3. **Internal engine endpoints** — `/api/v1/internal/tenants`, `/api/v1/internal/tenants/:id/stats`, bearer-token middleware
4. **Fleet-dashboard (read-only)** — Vite app der viser alle apps + Machines + tenants. No mutations yet.
5. **Provision wizard** — første mutations-path; POST /tenants flow fra UI til Fly API + Cloudflare DNS + engine endpoint
6. **Audit-log infrastructure** — control-plane-api DB + append middleware på alle mutations
7. **Pro→Business upgrade wizard** — DB-snapshot via VACUUM INTO, SCP-transfer, DNS flip, rollback-vindue
8. **Alert-ingestion** — engine-side `alert-emit.ts` + control-plane-api `/alerts` endpoint + UI inbox
9. **Cost view** — Fly GraphQL daily sync + UI sammenligning med Stripe MRR
10. **Impersonate-read-only + GDPR export + decommission** — sidste lag af Phase 3
11. **Deployment** — Fly-apps `trail-control-plane` + `trail-control-plane-api`, auth wired til Google OAuth, DNS for `ops.trailmem.com`
12. **Runbooks** — markdown-dokumentation for hver operation, linked fra UI's help-buttons

## Dependencies

- **F33** Fly.io server deploy — Control Plane kan ikke teste mod Fly-fleet uden at have én
- **F40** Multi-tenancy — provisioning-flow forudsætter tenant-per-DB-model
- **F41** Tenant provisioning + signup flow — deler "opret tenant"-kode med Control Plane (Control Plane er admin-variant)
- **F42** Pluggable storage — tenant-migration-flow skal kunne flytte storage-prefix mellem Tigris/R2
- **F43** Stripe billing — MRR-data-kilde for cost-view
- **F44** Usage metering — kilde til kapacitets-alerts
- **F151** Cost Dashboard — kilde til LLM-cost-alerts
- **F153** Continuous R2 backup — rollback-mekanisme for fejlslagne upgrades

## Open Questions

1. **Auth til Control Plane.** Hardcoded `u-christian` i Phase 1, eller allerede Google OAuth + "operator"-rolle fra Phase 1? Recommend: hardcoded-token i Phase 1, OAuth i Phase 2.
2. **Control Plane egen DB vs. engine's.** Audit-log og fleet-spend er domæne-specifikke — skal de leve i en separat libSQL-DB eller i engine's hoved-DB? Recommend: separat, så Control Plane kan skaleres/rollbackes uafhængigt.
3. **Emergency access hvis Control Plane er nede.** Fly CLI skal forblive fallback. Procedurer dokumenteret i `docs/runbooks/emergency-fly-ops.md`.
4. **SOC 2 audit-scope.** Bliver Control Plane en del af SOC 2 Type II-scope (F73)? Sandsynligvis ja, det er den privilegerede management-plane. Vurder ved F73-planning.
5. **Skal operatør kunne redigere tenant-data direkte?** "Support-edit"-mode i impersonate — eller kun read-only? Recommend: read-only i Phase 3, skriv kun via eksisterende engine endpoints (så audit-trail er ensartet).

## Related Features

- **Depends on:** F33, F40, F41, F42, F43, F44, F151, F153
- **Enables:** F155 (Auto-scaling policy lever i Control Plane UI), F72 (On-prem deploy — on-prem-variant af Control Plane)
- **Cross-cuts:** F70 (SSO for operator-login), F71 (Audit log — Control Plane audit er reference-implementation), F81 (Per-KB encryption — Control Plane skal kunne rotere keys)

## Effort Estimate

**Large** — 10-14 dage fordelt over 4 phases.

- Phase 1 (provision only): 2-3 dage
- Phase 2 (fleet + upgrade + alerts): 4-5 dage
- Phase 3 (impersonate + export + decommission): 3-4 dage
- Phase 4 (on-call handoff + runbooks): 1-2 dage

Kritisk: Phase 1 skal lande **sammen med F33**, så første tenant-onboarding efter Sanne sker via Control Plane, ikke CLI. Phase 2-4 kan shippes iterativt over Stadig 2 → Stadig 3-overgangen.
