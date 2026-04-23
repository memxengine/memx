# F119 — Parallel Contradiction-Scan Runner

> Tier: Pro+ (via parallelism-add-on), Business default P=4. Effort: 0.5-1 day. Planned.

## Problem

Contradiction-lint spawner `claude -p` seriel per Neuron. Selv med F118 sampling tager 2.000 Neurons × 10s = ~5.5 timer per pass. Parallelisering kunne skære det til timer eller minutter — men kræver disciplineret rate-limit-respekt mod enten Max-subscription eller Anthropic API.

## Secondary Pain Points

- No visibility into actual vs configured parallelism per pass
- Rate-limit errors (429) crash the entire pass instead of gracefully backing off
- Enterprise customers with custom contracts can't leverage higher parallelism

## Solution

Ny util `apps/server/src/lib/concurrency.ts` der wrapper `p-limit`:

```ts
export function makeContradictionRunner(concurrency: number) {
  const limit = pLimit(concurrency);
  return {
    run: <T>(task: () => Promise<T>) => limit(task),
  };
}
```

Scheduleren i `lint-scheduler.ts` henter concurrency fra tenant-config (F122) og kører:

```ts
const runner = makeContradictionRunner(tenant.parallelism);
await Promise.all(neuronsToScan.map(n => runner.run(() => scanDocForContradictions(trail, n.id, checker))));
```

Pr. plan:

| Tier | Parallelism |
|---|---:|
| Starter | 1 |
| Pro base | 2 |
| Pro + Parallel-boost tilkøb × 2 | 4 |
| Business | 4 |
| Enterprise | 8+ (per kontrakt) |

Rate-limit-backoff: hvis LLM-API (eller CLI subscription) returnerer 429, runner respekterer retry-after-header og serialiserer midlertidigt.

## Non-Goals

- Dynamic parallelism adjustment based on current API load
- Parallelism for non-contradiction lint types (orphans, stale)
- Cross-tenant parallelism sharing (each tenant's limit is independent)
- GPU-accelerated inference (pure API parallelism)

## Technical Design

### Concurrency Utility

```typescript
// apps/server/src/lib/concurrency.ts
import pLimit from 'p-limit';

export interface ConcurrencyRunner {
  run: <T>(task: () => Promise<T>) => Promise<T>;
  pause: (seconds: number) => Promise<void>;
  activeCount: () => number;
  pendingCount: () => number;
}

export function makeContradictionRunner(concurrency: number): ConcurrencyRunner {
  const limit = pLimit(concurrency);
  let paused = false;
  let pauseUntil = 0;

  return {
    run: async <T>(task: () => Promise<T>) => {
      while (paused && Date.now() < pauseUntil) {
        await new Promise(r => setTimeout(r, 1000));
      }
      return limit(async () => {
        try {
          return await task();
        } catch (err) {
          if (isRateLimitError(err)) {
            const retryAfter = parseRetryAfter(err);
            paused = true;
            pauseUntil = Date.now() + retryAfter * 1000;
            throw err; // re-throw for caller to handle
          }
          throw err;
        }
      });
    },
    pause: async (seconds: number) => {
      paused = true;
      pauseUntil = Date.now() + seconds * 1000;
      await new Promise(r => setTimeout(r, seconds * 1000));
      paused = false;
    },
    activeCount: () => limit.activeCount,
    pendingCount: () => limit.pendingCount,
  };
}
```

### Scheduler Integration

```typescript
// apps/server/src/services/lint-scheduler.ts
const runner = makeContradictionRunner(tenant.parallelism);
await Promise.all(neuronsToScan.map(n =>
  runner.run(() => scanDocForContradictions(trail, n.id, checker))
));
```

### Telemetry

Log actual-parallelism vs configured-limit per pass:

```typescript
interface ParallelismTelemetry {
  configured: number;
  actualAvg: number; // average concurrent tasks during pass
  peak: number;
  rateLimitHits: number;
  totalBackoffSeconds: number;
}
```

## Interface

```typescript
// Tenant parallelism config (from F122)
interface TenantParallelismConfig {
  parallelism: number;
  rateLimitBackoffMs: number; // default 60000
  maxRetries: number; // default 3
}
```

## Rollout

**Single-phase deploy.** New utility + scheduler integration. No migration needed. Deploy and verify with existing KB.

## Success Criteria

- Ved P=4 × 2.000 samples = ~23 min pass-tid (målt)
- Rate-limit-backoff udløst uden at job crasher
- Business-tier-kontrakter kan holdes inden for SLA
- Telemetry shows actual vs configured parallelism per pass

## Impact Analysis

### Files created (new)
- `apps/server/src/lib/concurrency.ts`

### Files modified
- `apps/server/src/services/lint-scheduler.ts` (use concurrency runner instead of serial loop)
- `packages/db/src/schema.ts` (ensure `parallelism` column exists — from F122)
- `package.json` (add `p-limit` dependency)

### Downstream dependents
`apps/server/src/services/lint-scheduler.ts` is imported by 4 files:
- `apps/server/src/index.ts` (1 ref) — starts lint scheduler, unaffected
- `apps/server/src/services/access-tracker.ts` (1 ref) — references lint-scheduler types, unaffected
- `apps/server/src/services/access-rollup.ts` (1 ref) — references lint-scheduler types, unaffected
- `apps/server/src/services/lint-scheduler.ts` (12 self-refs) — internal, needs update

`packages/db/src/schema.ts` is imported by 1 file:
- `packages/core/src/kb/resolve.ts` (1 ref) — reads document schema, unaffected

### Blast radius

- Higher parallelism = higher API cost per pass — must be gated by F121 budget
- Rate-limit backoff pauses ALL tasks, not just the one that hit 429 — acceptable for correctness
- p-limit is a small, battle-tested library — low risk of introducing bugs
- Memory usage increases with parallelism (more concurrent LLM responses in flight)

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Concurrency runner with P=2 runs exactly 2 tasks concurrently
- [ ] Concurrency runner with P=4 runs exactly 4 tasks concurrently
- [ ] Rate-limit error (429) triggers backoff, remaining tasks wait
- [ ] Backoff expires, tasks resume at configured parallelism
- [ ] Pass completes with all N Neurons scanned (no dropped tasks)
- [ ] Telemetry logs correct activeCount/pendingCount during pass
- [ ] Regression: serial mode (P=1) still works identically to before
- [ ] Regression: existing contradiction detection accuracy unchanged

## Implementation Steps

1. Add `p-limit` to `package.json` dependencies.
2. Create `apps/server/src/lib/concurrency.ts` with `makeContradictionRunner()`.
3. Update `lint-scheduler.ts` to use concurrency runner instead of serial `for...of` loop.
4. Add rate-limit error detection + backoff logic.
5. Add telemetry logging for parallelism metrics per pass.
6. Read `parallelism` from tenant config (F122 columns).

## Dependencies

- F118 (sampling — makes parallelism meaningful by limiting batch size)
- F120 (API-migration opens higher parallelism without CLI subprocess overhead)
- F122 (plan limits controls concurrency per tenant)

## Open Questions

None — all decisions made.

## Related Features

- **F118** (Contradiction-Scan Sampling) — sampling limits batch size, parallelism speeds it up
- **F120** (Anthropic API Migration) — API transport enables higher parallelism than CLI
- **F122** (Plan Limits on Tenants) — provides `parallelism` column
- **F123** (Pro Modular Add-ons) — Parallel boost add-on increases `parallelism`

## Effort Estimate

**Small** — 0.5-1 day.
- Half day: concurrency utility + scheduler integration
- Half day: rate-limit backoff + telemetry
