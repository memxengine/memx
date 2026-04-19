# F119 — Parallel Contradiction-Scan Runner

*Planned. Tier: Pro+ (via parallelism-add-on), Business default P=4. Effort: 0.5-1 day.*

> Contradiction-scanner kører flere Neurons parallelt via `p-limit`-style concurrency runner. Ved Pro + 1 parallel boost → P=2-3. Ved Business → P=4. Ved Enterprise → P=8+. Skaleringen bestemmes af plan (F122) + LLM-transport (F120 API-migration åbner for P=8-16).

## Problem

Contradiction-lint spawner `claude -p` seriel per Neuron. Selv med F118 sampling tager 2.000 Neurons × 10s = ~5.5 timer per pass. Parallelisering kunne skære det til timer eller minutter — men kræver disciplineret rate-limit-respekt mod enten Max-subscription eller Anthropic API.

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

## How

- Ny dependency: `p-limit` (lille, battle-tested lib)
- Config-læsning fra `tenants.parallelism`-felt (via F122)
- Rate-limit-feedback: hvis 429 ramt, kald `runner.pause(seconds)` globalt til backoff-vinduet er over
- Telemetry: log actual-parallelism vs. configured-limit per pass

## Dependencies

- F118 (sampling — gør parallelisme meningsfuld)
- F120 (API-migration åbner for høj parallelisme uden CLI-process-overhead)
- F122 (plan limits styrer concurrency)

## Success criteria

- Ved P=4 × 2.000 samples = ~23 min pass-tid (målt)
- Rate-limit-backoff udløst uden at job crasher
- Business-tier-kontrakter kan holdes inden for SLA
