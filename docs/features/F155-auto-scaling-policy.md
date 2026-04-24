# F155 — Auto-scaling Policy

> Rule-drevet automatisk spawn, resize og tenant-rebalance af Trail-fleet. Bygger oven på F154 Control Plane's Fly-API og fleet-data. Tier: Phase 2 · Effort: Medium · Status: Planned.

## Problem

F154 Control Plane giver Christian en UI til at spawn/resize Machines manuelt. Men ved Stadig 3 (200-500 tenants, 45-50 Machines) er manuelt ikke realistisk:

- Pro-pool-1 rammer 13/15 tenant-kapacitet kl. 23:00 en søndag. Christian sover.
- En Business-tenant starter et 500-PDF batch-ingest og CPU på deres dedicated Machine raser fra 40% til 95%. Christian er på ferie.
- En Starter-tenant ligger på 8% CPU i 3 uger efter signup — deres Machine er overdimensioneret, men ingen har nogensinde nedskaleret.

Uden policy-automation sker tre ting:

1. **Kapacitet svigter** — nye Pro-signups fejler fordi pool-app er fuld, og supportbilletter kommer om morgenen.
2. **Cost eksploderer** — Machines der er 3× for store drænver margin på hver betalende kunde.
3. **Burned ops-time** — hver beslutning er en terminal-session eller en Control Plane-klik, selvom beslutningen er **mekanisk**: "pool > 80% fuld → spawn ny".

F154 viser signalerne; F155 **handler** på dem indenfor en klart defineret policy-boks.

## Secondary Pain Points

- **Ingen cost-aware scheduling.** Ved signup placeres tenant på "første ledige pool" uden hensyn til region-cost, tenant-profil (heavy-ingest vs. læse-tung) eller sikringsfarm-distribution. F155 kan pick'e smart.
- **Ingen graceful shrink.** Når en Pro-tenant downgrader til Starter, flyttes de ikke tilbage til starter-pool. Dedicated Machine kører tom. F155 rebalancer.
- **Ingen noisy-neighbor-respons.** Én tenant på shared pool kan dræne CPU for 14 andre. F155 detekterer + flytter dem til enten dedicated (hvis betalt) eller suspenderer (hvis Hobby-misbrug).

## Solution

En policy-engine i F154 Control Plane der:

1. **Observerer** fleet-metrics (via F44 Usage Metering + Fly GraphQL + per-tenant DB-stats) hver 60 sek.
2. **Evaluerer** en ordered regelsæt (yaml-fil i repo, hot-reloadable).
3. **Foreslår handling** til en action-kø med pre-konfigureret auto-approve eller require-confirm flag.
4. **Udfører** godkendte handlinger via F154's Fly-client + audit-log.
5. **Rapporterer** resultatet tilbage til alert-inboxen med "what changed".

Christian sætter én gang op: "pool-scaleup under 80% auto-approve, Pro→Business upgrade require-confirm, shrink kun require-confirm". Efter det kører 90% af operationerne uden ham.

## Non-Goals

- **Ikke machine-learning-drevet.** Policy er eksplicitte regler — ikke "predict next load". Det er simpelt, auditerbart og umuligt at misforstå. Hvis vi senere finder ML-baseret autoscaling værdifuldt er det F17X, ikke nu.
- **Ikke cross-region automation.** At flytte en tenant fra arn → fra er en manuel, kundestøttet operation. F155 vælger kun region ved initial placering.
- **Ikke auto-downgrade af plan.** Policy kan flytte tenant mellem *infrastructure-tiers* (dedicated → shared pool), men aldrig mellem *pricing-tiers* (Business → Pro). Pricing er Stripe's område (F43).
- **Ikke tenant-tilpasset per-minute scaling.** Ingen scale-down-til-nul, ingen cold-start-optimering. Fly Machines er for tunge til det mønster.
- **Ikke kubernetes-ækvivalent HPA.** Vi bruger Fly-primitives, ikke pod-autoscaler.
- **Ikke database-skalering.** libSQL er single-file embedded; F155 rører aldrig DB-filer. Machine-level kun.
- **Ikke automatisk spawn i nye regioner.** Når regions-udvidelse sker, er det en manuel ops-beslutning (tilgængelig i F154 wizard).

## Technical Design

### 1. Policy-fil format

Én yaml-fil, `config/auto-scale-policy.yaml`, der versioneres i git:

```yaml
version: 1
evaluated_every_seconds: 60
default_dry_run: false

rules:
  - id: pro-pool-scaleup
    description: Spawn ny Pro-pool-app når gennemsnitlig CPU >80% eller tenant-count >13/15
    when:
      app_tier: pro
      app_type: pool
      cpu_avg_5min_pct: "> 80"
      OR:
        tenant_count: "> 13"
    action:
      type: spawn_pool
      tier: pro
      region: same_as_source
    approval: auto
    cooldown_seconds: 300

  - id: business-machine-vertical-scale
    description: Opskaler Business performance-8x → 16x når RAM >85% i 10min
    when:
      app_tier: business
      app_type: dedicated
      mem_avg_10min_pct: "> 85"
      current_machine_size: "performance-8x"
    action:
      type: resize_machine
      to_size: "performance-16x"
    approval: require_confirm
    cooldown_seconds: 600

  - id: starter-pool-shrink
    description: Decommission starter-pool-app når tenant-count = 0 i 24t
    when:
      app_tier: starter
      app_type: pool
      tenant_count: "== 0"
      empty_duration_hours: "> 24"
    action:
      type: decommission_pool
    approval: require_confirm
    cooldown_seconds: 3600

  - id: noisy-neighbor-isolation
    description: Flyt heavy-ingest tenant fra shared pool til dedicated temporary
    when:
      app_type: pool
      tenant_cpu_share_pct: "> 60"
      tenant_plan: pro
      duration_min: "> 30"
    action:
      type: promote_temp_dedicated
      reason: noisy-neighbor
    approval: auto
    cooldown_seconds: 1800

  - id: hobby-quota-abuse
    description: Suspend Hobby-tenant der overskrider 200% af sin Neuron-quota
    when:
      tenant_plan: hobby
      quota_usage_pct: "> 200"
    action:
      type: suspend_tenant
      grace_hours: 24
    approval: require_confirm
    cooldown_seconds: 86400

  - id: pool-selection-on-signup
    description: Ved ny tenant-provision, vælg pool med lavest tenant-count + nok headroom
    when:
      event: tenant_provision
    action:
      type: select_target_pool
      strategy: least_loaded_with_headroom
      headroom_tenants: 2
    approval: auto
    cooldown_seconds: 0
```

Hot-reload: F154's `/api/v1/policy/reload` genindlæser uden restart. Ugyldig yaml → log-fejl, fortsætter på forrige version.

### 2. Policy evaluator

```typescript
// apps/control-plane-api/src/services/policy-engine.ts

interface PolicyContext {
  now: Date;
  fleet: FlyAppSummary[];
  recentActions: Array<{ ruleId: string; at: Date }>;  // for cooldown
}

interface RuleEvaluation {
  ruleId: string;
  triggeredFor: Array<{ appName: string; tenantId?: string; reason: string }>;
  cooldownBlocks: number;
}

export async function evaluatePolicy(
  policy: Policy,
  ctx: PolicyContext,
): Promise<Array<QueuedAction>> {
  const queued: QueuedAction[] = [];

  for (const rule of policy.rules) {
    // cooldown check first
    if (isOnCooldown(rule, ctx)) continue;

    const matches = await evaluateRule(rule, ctx);
    for (const match of matches) {
      queued.push({
        ruleId: rule.id,
        action: rule.action,
        target: match,
        approval: rule.approval,
        evaluatedAt: ctx.now,
      });
    }
  }

  return queued;
}
```

### 3. Action executor

```typescript
// apps/control-plane-api/src/services/action-executor.ts

export async function executeAction(action: QueuedAction, operator: 'system' | string): Promise<ActionResult> {
  const audit = await beginAuditEntry(action, operator);

  try {
    switch (action.action.type) {
      case 'spawn_pool':
        return await spawnPool(action.action);
      case 'resize_machine':
        return await resizeMachine(action.action);
      case 'decommission_pool':
        return await decommissionPool(action.action);
      case 'promote_temp_dedicated':
        return await promoteTempDedicated(action.action);
      case 'suspend_tenant':
        return await suspendTenant(action.action);
      case 'select_target_pool':
        return await selectTargetPool(action.action);
    }
  } catch (err) {
    await finalizeAuditEntry(audit, 'failure', err);
    throw err;
  }

  await finalizeAuditEntry(audit, 'success');
}
```

### 4. UI integration i F154

En ny "Auto-scale"-tab i F154 UI der viser:

- **Active rules** — hver regel som kort med "enabled/disabled" toggle + sidste evaluering + sidste handling
- **Pending actions** — kø af handlinger der venter på approval (inkl. `auto`-dem der er blevet konverteret til `require_confirm` pga. abnormitet)
- **History** — sidste 100 handlinger med resultat
- **Dry-run panel** — operatør kan kopiere en rule og trykke "evaluate now", se hvilke apps der ville trigger uden at handle

### 5. Safety rails

Selv auto-approved handlinger gaters af:

- **Rate-limit:** max 3 handlinger pr. 5 minutter globalt
- **Cost cap:** auto-approve kan ikke tilføje >€500/mo i Fly-cost i en enkelt beslutning
- **Panic button:** én knap i F154 stopper alle auto-approve-regler øjeblikkeligt (skal re-enables manuelt)
- **Slack/email digest:** hver handling genererer notifikation, så Christian er i loop uden at klikke-approve

### 6. Circular-action-detektion

Hvis rule A spawner pool, og rule B kort efter decommissioner samme pool, detekteres det som "policy-oscillation" og automatisk pausing af begge regler i 1 time + alert.

```typescript
function detectOscillation(history: AuditRow[]): string[] {
  // Look for same target getting contradictory actions within 15min window
  // Return array of ruleIds to pause
}
```

### 7. Observability

Control Plane's egen metric-output:

- `auto_scale_rules_triggered_total{rule_id}` — counter
- `auto_scale_actions_executed_total{action_type, result}` — counter
- `auto_scale_evaluation_duration_seconds` — histogram
- `auto_scale_rules_on_cooldown{rule_id}` — gauge

Eksporteret som Prometheus-format via `/metrics` endpoint (auth-gated).

## Interface

### Policy-fil
- Path: `config/auto-scale-policy.yaml` (committed i git)
- Schema: JSON schema i `packages/shared/src/auto-scale-schema.ts`

### Endpoints (tilføjes til F154's control-plane-api):

```
GET   /policy                        → current policy + last-evaluated timestamp
GET   /policy/evaluations            → seneste evalueringsresultater (paginated)
POST  /policy/reload                 → reload fra git (for CI/CD)
POST  /policy/evaluate-now           → force evaluation, useful for debug
GET   /policy/pending-actions        → queue af approval-afventende handlinger
POST  /policy/pending-actions/:id/approve
POST  /policy/pending-actions/:id/reject
POST  /policy/panic-stop             → disable alle auto-approve
POST  /policy/panic-resume           → re-enable

GET   /policy/history                → audit-samlet, filter by rule_id/tenant/app
```

## Rollout

**Phase 1 — dry-run only (M6-M7):** Policy-fil + evaluator landed, ALL handlinger er dry-run regardless af `approval: auto`. Kører i produktion, logger hvad den VILLE have gjort. Giver Christian 2-4 ugers validering af at reglerne ikke er sindssyge.

**Phase 2 — conservative auto-approve (M7-M9):** `pool-selection-on-signup` aktiveres (lavrisiko, bedre placement). `pro-pool-scaleup` aktiveres med cooldown 10min (ikke 5). Alle andre forbliver dry-run.

**Phase 3 — full auto-approve (M9-M12):** Alle regler er "rigtige" per policy-fil. Panic-button testet. Slack/email-digest live.

**Phase 4 — tilpasning:** Regelsæt udvides baseret på observerede mønstre. Custom regler pr. tenant (Enterprise-opt-in).

## Success Criteria

1. **Pro-pool-scaleup trigger <30s efter CPU >80% i 5min.** Målt på 20+ eksempler fra live-metrics.
2. **Nul policy-oscillation i Phase 3.** Verificeret via 30 dages audit-log, 0 oscillationer fanget.
3. **90% af signup-flows rammer optimal pool first try.** "Optimal" = ingen handmatch-korrektion krævet indenfor 48t. Målt hen over 100 signups.
4. **Auto-approve-beslutninger er rollback-bare indenfor 10min via F154 UI.** Hver auto-handling har en korrespondent manual-reverse-operation klar.
5. **Cost-cap håndhæves.** Test: force-trigger 10 regler på én gang, verificer at kun 3 kører (rate-limit) og ingen overskrider €500/mo cost-cap.

## Impact Analysis

### Files created (new)

- `config/auto-scale-policy.yaml` — default policy
- `packages/shared/src/auto-scale-schema.ts` — policy JSON schema + TypeScript types
- `apps/control-plane-api/src/services/policy-engine.ts`
- `apps/control-plane-api/src/services/action-executor.ts`
- `apps/control-plane-api/src/services/oscillation-detector.ts`
- `apps/control-plane-api/src/routes/policy.ts`
- `apps/control-plane/src/panels/auto-scale.tsx`
- `apps/control-plane/src/panels/auto-scale-pending.tsx`
- `apps/control-plane/src/panels/auto-scale-history.tsx`
- `apps/control-plane-api/scripts/verify-policy-schema.ts` — CI gate
- `apps/control-plane-api/scripts/simulate-policy.ts` — replay historisk fleet-snapshot mod policy
- `docs/runbooks/auto-scale-incident.md` — what to do when policy misbehaves
- `docs/features/F155-auto-scaling-policy.md` (dette dokument)

### Files modified

- `apps/control-plane-api/src/index.ts` — start policy-engine ticker
- `apps/control-plane-api/src/routes/fleet.ts` — expose fleet metrics in policy-friendly shape
- `apps/control-plane-api/src/services/fly-client.ts` — add `resize_machine`, `decommission_app` methods
- `apps/control-plane/src/app.tsx` — register auto-scale panel routes
- `docs/FEATURES.md` — index row
- `docs/ROADMAP.md` — Phase 2 entry
- `docs/DEPLOYMENT-STAGES.md` — cross-reference F155 i Stadig 3-sektionen

### Downstream dependents

F155 ligger inde i F154's app-struktur, så ændringer i `apps/control-plane-api/src/services/fly-client.ts` berører:
- `apps/control-plane-api/src/routes/fleet.ts` (F154, 2 refs) — ingen breaking changes, tilføjelser kun
- `apps/control-plane-api/src/services/tenant-lifecycle.ts` (F154, 4 refs) — bruger allerede spawn/resize; F155 tilføjer decommission-metode

`packages/shared/src/auto-scale-schema.ts` er ny, 0 downstream dependents.

### Blast radius

- **Forkert policy-regel kan spawn mange Machines ved oscillation.** Mitigering: `detectOscillation` + cost-cap + rate-limit + panic-button.
- **Policy-evaluator fejler → fleet fryser (ingen auto-handlinger).** Mitigering: circuit-breaker på evaluator-fejl, fortsætter med sidst-known-good policy, alert til Christian.
- **Race conditions ved concurrent evaluation + manual F154 handling.** Mitigering: advisory lock på app-level (`control_plane_locks`-tabel) før hver mutation.
- **Feature-flag for auto-approve.** Hele F155 kan disable'es via `TRAIL_AUTO_SCALE_ENABLED=false` env. Dev-miljø default off.

### Breaking changes

Ingen. F155 er additivt — hvis policy-fil er tom eller `TRAIL_AUTO_SCALE_ENABLED=false`, opfører Control Plane sig som i F154-only-mode.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: Policy-schema validation rejecter malformed yaml
- [ ] Unit: Cooldown-respekt: rule X kan ikke trigger 2× indenfor cooldown
- [ ] Unit: Oscillation-detector flagger kontradiktorisk rule-par indenfor 15min
- [ ] Unit: Cost-cap afviser action der vil overskride €500/mo ekstra
- [ ] Unit: Rate-limit (3/5min) håndhæves på tværs af alle regler
- [ ] Integration: Dry-run mode logger actions uden at udføre dem
- [ ] Integration: Panic-stop disabler alle auto-approve øjeblikkeligt
- [ ] Integration: Policy-reload via /policy/reload plukker op fra git uden restart
- [ ] Manual: Force CPU >80% på test-Pro-pool, verify ny pool spawnes <60s
- [ ] Manual: Simulate Business-tenant RAM-spike, verify resize-suggestion vises i F154
- [ ] Regression: F154 manuelle operationer (provision, upgrade) påvirkes ikke af policy-evaluator
- [ ] Regression: F153 R2-backup fortsætter uforstyrret under policy-evaluering
- [ ] Regression: Engine tenant-ingest (F143 queue) påvirkes ikke af control-plane-side evalueringer

## Implementation Steps

1. **Policy schema + loader** — JSON schema for policy.yaml, parser, validator, hot-reload mechanism
2. **Fleet-metrics snapshot** — udvid F154's fleet-endpoint til at give policy-engine ready-to-consume struktur (CPU avg 5min, mem avg 10min, tenant-counts, cooldown-timestamps)
3. **Policy-evaluator** — pure function `evaluatePolicy(policy, fleetSnapshot) → QueuedAction[]`, unit-testes mod fixture-snapshots
4. **Action executor (shell)** — struct + routing, men hvert action-type stubbes til "log only"
5. **Dry-run mode end-to-end** — tick-timer i control-plane-api, evaluator kører hver 60s, resultater logges og vises i F154 UI
6. **First auto-approve rule: pool-selection-on-signup** — lavest-risiko, integration-test først
7. **Handlinger én ad gangen:** spawn_pool, resize_machine, decommission_pool, promote_temp_dedicated, suspend_tenant, select_target_pool
8. **Oscillation-detektor + cost-cap + rate-limit** — sikkerhedslag før full-auto
9. **Panic-button** — UI-knap + env-flag, tested with chaos-drill
10. **Slack/email digest** — hver handling genererer notification, inkl. sammenfatning per 24t

## Dependencies

- **F154** Trail Control Plane — F155 lever i F154's app, deler Fly-client, deler audit-log
- **F44** Usage Metering — kapacitets-signaler (tenant-count, quota-usage) kommer herfra
- **F151** Cost Dashboard — LLM-cost-signal bruges af cost-aware pool-selection
- **F43** Stripe Billing — plan-data for tenant (`plan: pro | business`) hentes herfra

## Open Questions

1. **Policy-engine cadence: 60s vs. event-drevet?** 60s er simpel, predictable, let at reason om. Event-drevet (reager på alert-emit) er hurtigere men sværere at teste og debugge. Recommend: 60s polling Phase 1-3, event-augment i Phase 4 hvis behov opstår.
2. **Yaml vs. JSON vs. TypeScript config?** Yaml er human-læsbar, git-diff-bar, ikke-dev-friendly. TypeScript config er type-sikker men skjuler hot-reload. Recommend: yaml med strict JSON schema + runtime-validation.
3. **Skal policy være per-tenant overridable?** Enterprise-tenant vil måske kræve "altid performance-16x uanset load". Recommend: nej i Phase 1-3; enterprise-overrides er F170+.
4. **Cost-cap pr. dag vs. pr. måned?** Månedlig cap giver mere headroom for burst; daglig cap fanger runaway hurtigere. Recommend: begge — daglig soft-cap €50 (alert), månedlig hard-cap €500 (block).
5. **Skal auto-approve-handlinger kunne rollbackes automatisk hvis de forværrer metrics?** "If spawn af pool ikke reducerer CPU inden 10min, rollback." Komplekst, potentiel oscillation. Recommend: nej; manuel rollback via F154 audit-log.

## Related Features

- **Depends on:** F154 (kritisk — F155 er et lag ovenpå), F44, F151, F43
- **Enables:** F77 (regional auto-placement ved multi-region rollout — Phase 3+), F86 SLA Monitoring (uptime-garantier bliver sværere uden F155)
- **Blocks none** — udelukkende automatisering, kan shippes/rullebakkes uafhængigt

## Effort Estimate

**Medium** — 5-7 dage fordelt over 4 phases.

- Phase 1 (dry-run): 2 dage
- Phase 2 (conservative auto-approve): 1-2 dage
- Phase 3 (full auto-approve + safety rails): 2-3 dage
- Phase 4 (digest + tuning): 1 dag

Kritisk afhængighed: F154 Phase 2 skal være shipped (fleet-dashboard + alert-ingestion), ellers har F155 intet at agere på.
