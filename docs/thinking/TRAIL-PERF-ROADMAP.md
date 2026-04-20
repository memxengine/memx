# TRAIL-PERF-ROADMAP

> Performance roadmap for the Trail knowledge engine.
> Philosophy: **measure first, optimize second, rewrite only when data demands it.**
> Last updated: 2026-04-20

---

## Guiding principles

1. **Your time is more expensive than CPU.** A solo founder should not hand-tune what a measurement has not yet flagged.
2. **Instrument before you optimize.** Every phase below assumes metrics are already in place from Phase 0.
3. **SQLite takes you further than you think.** The decision to move off SQLite is a *data-driven* event, not an architectural reflex.
4. **Rust is a scalpel, not a hammer.** Introduce it on hot paths, not as a wholesale rewrite.
5. **Each phase must show measurable improvement** on a named metric before the next phase is considered.

---

## Phase 0 — Baseline instrumentation (Week 1, pre-MVP)

**Goal:** make the system measurable from the first deploy. This is non-negotiable.

### Deliverables

- `prom-client` mounted in Hono via a middleware
- `/metrics` endpoint exposed (internal-only, behind auth)
- Fly's built-in Grafana/VictoriaMetrics wired up
- Baseline dashboard with the metrics below

### Core metrics to track

| Metric | Type | Why it matters |
|---|---|---|
| `trail_http_request_duration_seconds` | Histogram (labeled by route, method, status) | p50/p95/p99 latency per endpoint |
| `trail_http_requests_total` | Counter | Throughput + error rate |
| `trail_sqlite_query_duration_seconds` | Histogram (labeled by operation) | Catch slow queries early |
| `trail_compile_duration_seconds` | Histogram (labeled by page_type) | Page compilation is a known hot path |
| `trail_event_replay_lag_seconds` | Gauge | How far the read model is behind the event stream |
| `trail_curation_queue_depth` | Gauge | Backpressure signal |
| `trail_curation_auto_approved_ratio` | Gauge | Target: 70–80% per scaling analysis |
| `trail_embedding_duration_seconds` | Histogram | LLM-dependent, network-bound |
| `trail_llm_request_duration_seconds` | Histogram (labeled by provider, model) | External dependency tracking |
| `trail_llm_tokens_total` | Counter (labeled by direction, model) | Cost tracking — critical on Max plan |
| Default Node/Bun metrics | Various | Memory, GC, event loop lag |

### SLOs to define (aspirational, MVP)

- p95 wiki page read: < 50ms
- p95 curation scoring: < 3s (LLM-bound)
- p99 page compilation: < 500ms
- Event replay lag: < 5s steady state

### Exit criteria

- Dashboard visible, alerts configured for SLO violations
- Two weeks of production data from Sanne's usage

---

## Phase 1 — Bun/Hono MVP tuning (Weeks 2–8)

**Goal:** squeeze the default stack before touching architecture.
**Expected gain:** 2–5× on most operations, zero new dependencies.

### SQLite tuning

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;        -- 64MB cache
PRAGMA mmap_size = 268435456;      -- 256MB mmap
PRAGMA temp_store = MEMORY;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
```

### Drizzle / query-level wins

- Prepared statements for hot reads (Drizzle's `.prepare()`)
- Covering indexes on wiki_events query patterns
- `EXPLAIN QUERY PLAN` audit of every query touching > 1K rows
- Batch inserts in transactions for event replay

### HTTP layer

- ETag + `If-None-Match` on compiled wiki pages
- `Cache-Control: public, max-age=...` on stable content
- Hono's streaming responses (`c.streamText`) for long LLM responses
- Middleware order: auth → rate limit → parse → handler

### Application-level

- LRU cache (`hono/cache` or in-process) for top-N hot pages
- Lazy compilation: compile on first read, cache result
- Pre-compile popular pages in a background job

### Exit criteria

- p95 wiki read < 20ms (from 50ms target)
- SQLite never appears as top-3 bottleneck in Grafana
- Hono CPU < 30% under Sanne's steady-state load

---

## Phase 2 — Workload separation (Months 3–6)

**Goal:** stop letting compile/embedding work block HTTP serving.
**Trigger:** p95 latency spikes correlate with compilation or embedding batches.

### Architecture shift

Move heavy work off the request path:

```
┌──────────────┐      ┌────────────────┐      ┌──────────────┐
│ Hono API     │─────▶│  Job Queue     │◀─────│ Bun Worker   │
│ (HTTP only)  │      │  (SQLite-based)│      │ (compile,    │
└──────────────┘      └────────────────┘      │  embed, etc) │
                                              └──────────────┘
```

### Options evaluated

- **SQLite-backed queue** (simplest) — a `jobs` table with polling. Sufficient for < 100 jobs/min.
- **Redis + BullMQ** — proven, but adds a service. Reserve for > 1K jobs/min.
- **Bun worker threads** — good for CPU-bound compile tasks on same host.

### Changes

- Extract `trail-compiler`, `trail-embedder`, `trail-curator` into worker processes
- API only reads from SQLite, never writes during HTTP
- Curation Queue becomes a true queue-consumer pattern
- Add `trail_job_duration_seconds` and `trail_job_queue_latency_seconds` metrics

### Exit criteria

- p99 HTTP latency decoupled from batch job duration
- Workers scale horizontally (multiple Fly machines)

---

## Phase 3 — Selective Rust via NAPI (Months 6–12)

**Trigger:** one or more hot paths dominate CPU in Grafana for ≥ 2 consecutive weeks, AND workload separation did not solve it.

**Goal:** replace individual functions with Rust, keeping Bun as the host.
**Expected gain:** 3–10× on the specific function replaced.

### Candidates (in priority order)

1. **Page compilation** (template render + markdown → HTML + link resolution)
   — CPU-bound, pure function, high call rate. Ideal first target.
2. **Embedding pipeline** (when using local models via `fastembed-rs`)
   — avoids Python entirely, keeps embeddings on-box.
3. **Diff computation** for event replay (if using text diffs)
4. **Three-stage hierarchical pre-filter** at compile time (per scaling analysis)

### Tooling

- [`napi-rs`](https://napi.rs) — Rust → Node/Bun native modules. Mature, Bun-compatible.
- Build as separate crate in `memxengine/trail-core`
- Publish as private scoped package: `@memxengine/trail-core-native`

### Rule of thumb

If a function is called > 1K times/min AND takes > 10ms, it's a Rust candidate.
If it's called < 100 times/min, leave it in TypeScript.

### Exit criteria

- Targeted hot path drops out of top-5 in profiler
- NAPI layer adds < 0.1ms overhead per call (measured)

---

## Phase 4 — Rust worker service (Year 2+)

**Trigger:** 10+ customers, OR a single customer with > 500K pages, OR CPU cost dominates infra bill.

**Goal:** move the engine core to a dedicated Rust service.
**Architecture:**

```
┌──────────────┐        ┌──────────────────┐
│ Bun + Hono   │───────▶│ trail-engine     │
│ (API, auth,  │  HTTP  │ (axum, rusqlite, │
│  admin UI)   │◀───────│  tantivy,        │
└──────────────┘        │  fastembed)      │
                        └──────────────────┘
```

### Stack choices (2026 state of the art)

- **axum** (Tokio team, dominant choice over actix-web by 2025)
- **rusqlite** (sync, faster than sqlx for SQLite-only workloads)
- **tokio** runtime
- **serde + serde_json** — often the real bottleneck on JSON APIs
- **tower** for middleware composition
- **utoipa** for OpenAPI generation (if Bun needs a typed client)
- **tantivy** for full-text search
- **fastembed-rs** for local embeddings
- **sqlite-vss** or **sqlite-vec** for vector search
- **tracing + tracing-opentelemetry** for observability

### What stays in Bun

- Admin UI (Preact + Vite)
- Auth / session management
- Billing / customer lifecycle
- Marketing site (Astro, separate)
- Webhook receivers

### Exit criteria

- Engine handles 10× current load on same hardware
- Cost per request drops measurably

---

## Phase 5 — Storage layer decision (Year 2+)

**Trigger:** any of the following:
- Single SQLite file > 100GB
- Write contention visible in `SQLITE_BUSY` metrics
- Need for multi-region reads
- Backup/restore time > 1 hour

**Decision tree:**

- **Stay on SQLite + Litestream** if workload is read-heavy and single-region.
- **Move to PostgreSQL + pgvector** if write contention or multi-tenant isolation becomes painful.
- **Consider Turso/LibSQL** if you want SQLite's API with replication.
- **Don't over-engineer** — per-customer SQLite files on shared volumes is a valid multi-tenant pattern up to ~50 customers.

### Migration preparation

- Keep Drizzle schemas portable (avoid SQLite-specific types where possible)
- Dual-write pattern during cutover
- Per-customer data isolation already designed in from MVP

---

## Phase 6 — Full Rust rewrite

**Do not do this** unless every phase above has been exhausted and data shows a specific, measurable benefit that hybrid architecture cannot deliver.

If it becomes necessary, the Rust stack from Phase 4 scales linearly — the question is only how much of the Bun layer to port, which is a product decision (admin UI complexity, team size) not a performance one.

---

## Anti-patterns to avoid

- ❌ **Rewriting in Rust before Phase 0 metrics exist.** You will optimize the wrong thing.
- ❌ **Adding Redis "because it's fast".** SQLite is faster for small workloads and removes a service.
- ❌ **Microservices before 10 customers.** A modular monolith is easier to operate solo.
- ❌ **Benchmarks from TechEmpower as a guide for real workloads.** Your bottleneck is LLM latency, not HTTP serving.
- ❌ **Optimizing code that runs < 100 times/day.** Readability wins there.

---

## Decision log template

Every time a phase transition is considered, record in this doc:

```
### YYYY-MM-DD — Phase N transition evaluation
- Trigger: [which metric crossed which threshold]
- Current state: [key metrics]
- Decision: [proceed / defer / alternative]
- Rationale: [2-3 sentences]
- Next review: [date or condition]
```

---

## References

- Scaling analysis: SQLite at 100K pages/node with WAL tuning (internal doc)
- Three-stage hierarchical pre-filtering at compile time (internal doc)
- [prom-client docs](https://github.com/siimon/prom-client)
- [Fly.io metrics](https://fly.io/docs/monitoring/metrics/)
- [napi-rs book](https://napi.rs/docs/introduction/getting-started)
- [axum](https://github.com/tokio-rs/axum)
