# F164 — Background jobs framework + bulk Vision-rerun

> Generisk background-job infrastruktur i Trail-engine'n med crash-recovery, abort-support, real-time progress via SSE, og visuel verifikation. Første consumer er bulk Vision-rerun ("Vælg alle kilder + kør Vision på NULL-described billeder") — men frameworket er designet til at huse alt fremtidigt long-running arbejde (ingest, contradiction-scan, embed-recompute, batch-tagging, slet-og-genoptag). Inkluderer Anthropic-direct fallback når OpenRouter fejler, progress-modal med "Kør i baggrunden"-toggle, header-badge for aktive jobs, completion-toast med visuel sample af resultater. Tier: alle tenants. Effort: Large — ~3 dage opdelt i 5 faser. Status: Planned.

## Problem

Trail har p.t. tre patterns for long-running operations, ingen af dem er gode:

1. **Inline async (fire-and-forget)** — F143 ingest queue: skriver `ingest_jobs`-row, separat runner picker dem op. Crash-recovery via `ingest_jobs.status='processing' AND last_heartbeat > 60s ago` (zombie-detektor). Frontend poller `/queue/jobs?status=processing` for status. **Mangler**: real-time progress (kun final state), per-image granularitet, abort, "kør i baggrunden"-handoff fra modal til badge.

2. **Synkron blokering** — F161 follow-up rerun-vision endpoint: `for (image of 224 images) await visionAPI(image)`. Blokerer én HTTP-request i 15-19 minutter. Browser timeout'er, await aldrig completer, frontend-toast aldrig fyrer, engine fortsætter ufortrødent server-side. **Det her er den umiddelbare smerte** — bekræftet af Christian's "knappen forsvandt og jeg fik ingen toast" (request 11:50, last image 11:55:50, engine processede stadig kl. 12:05+ uden klient).

3. **Boot-time scripts** — F162 backfill, F161 backfill, F148 normalize-trail-case: kører ved engine-start, ingen UI, ingen progress-feedback. Acceptabelt for one-shot lifecycle-events; uacceptabelt for user-triggered ops.

Konkret trigger: Christian klikkede "Run Vision" på Zoneterapibogen_2026 (224 billeder), modal'en lukkede sig selv (browser-timeout), 94 ud af 224 blev described før han spurgte "har den kørt?". Ingen feedback. Det værste er ikke at det er langsomt — det er at brugeren ikke kan **stole på** at klikket gjorde noget.

Bredere: Sanne (eller fremtidens kunder) vil have multi-GB KB'er med 10.000+ billeder, 100.000+ Neuroner. Hver long-running operation skal være observerbar, abortable, crash-survivable, og billig at gentage uden side-effekter.

## Secondary Pain Points

- **Ingen "Vælg alle + kør Vision"** i admin. Curator må klikke individuelt på hver kilde. Med Sanne's 30+ kilde-mapper er det 30+ knap-tryk og 30+ baggrundsjobs at holde styr på.
- **Ingen abort-mekanisme** når en bulk-operation kører løbsk eller bruger pengene anderledes end forventet (fx en model bumps til dyrere variant uden viden).
- **Ingen pre-flight cost-estimat**. Bruger trykker "Run Vision på 1247 billeder" uden at vide om det koster $0.12 eller $12. Burde være forudsigeligt.
- **Ingen visuel verifikation** af at det rent faktisk virkede. Vi lader brugeren stole på en counter ("94 described") uden at vise eksempler. F128/F148-fejl-mønstre (den slags hvor "den kørte" var sandt men output var dårligt) er kun fangeligt med visuel review.
- **OpenRouter-base64-fejl på 5-15% af billeder** — sandsynligvis pga. image-size limits (PNG'er over Anthropic's 5MB-base64 cap blokeres af OpenRouter). Skal håndteres med: a) auto-resize ved upload, b) Anthropic-direct fallback, c) graceful "kunne ikke beskrives" markering.
- **Ingen audit-trail** for jobs. "Hvem trykkede Run Vision på X igår?" er ubesvarbart i dag.

## Non-goals (v1)

- **Ingen distribueret job-queue** (Redis/SQS/Beanstalk). Trail er single-engine; SQLite + in-process runner er nok. Hvis multi-engine bliver relevant (F40.2 multi-tenant cluster) opgraderer vi.
- **Ingen scheduled/cron jobs**. F164 er user-triggered + system-triggered (boot-recovery). Cron-jobs (fx daglig vision-rerun) er F164.x follow-up.
- **Ingen webhook-notifikationer**. Toast + badge i UI er nok — webhook til Slack/Discord/email er F164.x.
- **Ingen bulk-edit på Vision-beskrivelser** (modify, regenerate w/ different prompt). F163 image-gallery + senere "rewrite description"-modal håndterer det.
- **Ingen fancy retry-strategies** ud over Anthropic-direct fallback. Eksponentiel backoff, dead-letter queue er overkill for v1.

## Solution

### Schema — `jobs` table

```sql
-- Migration 0026 (efter F162-race fix der bumper migrations-counter):
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,                -- 'job_<uuid>'
  tenant_id     TEXT NOT NULL,
  knowledge_base_id TEXT,                        -- nullable: cross-KB jobs
  user_id       TEXT NOT NULL,                   -- who triggered it
  kind          TEXT NOT NULL,                   -- 'vision-rerun' | 'bulk-vision-rerun' | future
  status        TEXT NOT NULL,                   -- 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted'
  payload       TEXT NOT NULL,                   -- JSON: kind-specific input
  progress      TEXT,                            -- JSON: { current, total, eta_ms, phase, ... }
  result        TEXT,                            -- JSON: kind-specific output
  error_message TEXT,
  parent_job_id TEXT,                            -- for sub-jobs in a bulk op
  created_at    TEXT NOT NULL,                   -- ISO-8601 UTC
  started_at    TEXT,
  finished_at   TEXT,
  last_heartbeat_at TEXT,                        -- F143-style zombie-detection
  abort_requested INTEGER NOT NULL DEFAULT 0,    -- 0/1: cooperative cancel signal
  cost_cents_estimated INTEGER,                  -- pre-flight estimate
  cost_cents_actual INTEGER                      -- post-completion truth
);
CREATE INDEX idx_jobs_tenant_status ON jobs(tenant_id, status);
CREATE INDEX idx_jobs_kb_status ON jobs(knowledge_base_id, status) WHERE knowledge_base_id IS NOT NULL;
CREATE INDEX idx_jobs_parent ON jobs(parent_job_id) WHERE parent_job_id IS NOT NULL;
```

**Hvorfor en separat `jobs`-tabel ikke en udvidelse af `ingest_jobs`?** `ingest_jobs` har domain-specifikke kolonner (file_size, page_count, ingest_phase). At polymorfe den til alle job-kinds tilføjer NULL-kolonner og kobler ortogonal logik. Bedre at have to specialiserede tabeller med fælles invariants (status, heartbeat, abort_requested) — på lang sigt kan vi extracte en `jobs_base`-view hvis behovet for fælles UI-listing opstår. Den separation er baggrundsstøjen værd at undgå.

### Background runner (`apps/server/src/services/jobs/runner.ts`)

Singleton som mounter ved engine-start (efter migrations, før HTTP-server starter accepting). Pattern matcher F143's queue-runner men generaliseret.

```typescript
class JobRunner {
  private active = new Map<string, AbortController>();
  private handlers = new Map<JobKind, JobHandler>();

  register(kind: JobKind, handler: JobHandler) { ... }

  async start() {
    // F143-style zombie recovery: status='running' AND
    // last_heartbeat_at < now() - 60s → reset to 'pending'.
    // Idempotent: handler must tolerate resume-from-mid-execution.
    await this.recoverZombies();

    // Poll for pending jobs, run up to MAX_CONCURRENT_JOBS in parallel.
    setInterval(() => this.tick(), 1000);
  }

  async submit(kind: JobKind, payload: unknown, ctx: JobContext): Promise<string> {
    const id = `job_${crypto.randomUUID()}`;
    await db.insert(jobs).values({ id, kind, payload: JSON.stringify(payload), ...ctx });
    return id;
  }

  async abort(jobId: string) {
    await db.update(jobs).set({ abortRequested: 1 }).where(eq(jobs.id, jobId));
    this.active.get(jobId)?.abort();
  }

  private async runJob(job: Job) {
    const handler = this.handlers.get(job.kind);
    const abort = new AbortController();
    this.active.set(job.id, abort);

    try {
      await handler({
        payload: JSON.parse(job.payload),
        signal: abort.signal,
        report: (progress) => this.reportProgress(job.id, progress),
      });
    } catch (e) { ... } finally {
      this.active.delete(job.id);
    }
  }

  private async reportProgress(jobId: string, progress: unknown) {
    await db.update(jobs).set({
      progress: JSON.stringify(progress),
      lastHeartbeatAt: new Date().toISOString(),
    }).where(eq(jobs.id, jobId));
    sseEmit(jobId, 'progress', progress);
  }
}
```

**Concurrency invariants:**
- `MAX_CONCURRENT_JOBS = 4` (env-overridable). Sized for Fly.io's smallest deploy-tier (shared-cpu-1x, 256MB-1GB) so en curator's "Vælg alle 30 sources" ikke saturerer engine'n + freezer UI'et. Bumpes hvis vi opgraderer til større Fly-tier.
- Per-job concurrency for sub-tasks (Vision API calls within one job) er konfigureret af handler — Vision-rerun kører N=4 parallel API-calls så 224 billeder = ~56s i stedet for ~750s.
- Heartbeat every 5s during sub-task processing. Zombie-cutoff at 60s.

**Abort semantics (cooperative cancel):**
1. User clicks "Annullér" in modal → `POST /jobs/:id/abort` sets `abort_requested=1` AND signals AbortController.
2. Handler checks `signal.aborted` between sub-tasks (between Vision API calls). On `true`: persist current progress, set `status='aborted'`, return.
3. Already-described images stay described. Idempotent — restart picks up where it left off (NULL-only filter ensures no double-work).

### SSE progress channel (`apps/server/src/routes/jobs-stream.ts`)

```
GET /api/v1/jobs/:jobId/stream
→ event: progress
   data: { current: 94, total: 224, etaMs: 130000, phase: 'describing', failed: 12, retryQueue: 2 }
→ event: completed
   data: { described: 218, decorative: 4, failed: 2, costCentsActual: 12, sampleImages: [...] }
→ event: error
   data: { message: '...' }
```

EventSource on frontend, polling-fallback if EventSource unavailable (sjældent — but Trail har allerede SSE-pattern fra F90 thinking-events). Auth: same session-cookie eller Bearer.

### `vision-rerun` handler

Generaliseret fra dagens `documents.ts`-implementation:

```typescript
type VisionRerunPayload = {
  documentIds: string[];           // 1+ docs to scan (bulk = many)
  filter: 'null-only' | 'all';     // null-only = only re-vision NULL rows
  maxRetries: number;              // per-image retry budget
};

async function visionRerunHandler({ payload, signal, report }) {
  const allImages = await db.select(...).where(
    and(
      inArray(documentImages.documentId, payload.documentIds),
      payload.filter === 'null-only' ? isNull(documentImages.visionDescription) : sql`1=1`,
    ),
  );

  const total = allImages.length;
  let described = 0, decorative = 0, failed = 0;
  const failedIds: string[] = [];

  // Per-image concurrency = 3. p-limit gives bounded parallelism.
  const limit = pLimit(3);
  const start = Date.now();

  await Promise.all(allImages.map(img => limit(async () => {
    if (signal.aborted) return;
    const result = await describeWithFallback(img);
    if (result === 'described') described++;
    else if (result === 'decorative') decorative++;
    else { failed++; failedIds.push(img.id); }

    const elapsed = Date.now() - start;
    const rate = (described + decorative + failed) / elapsed;
    const remaining = total - (described + decorative + failed);
    const etaMs = remaining / rate;

    report({ current: described + decorative + failed, total, etaMs, described, decorative, failed, failedIds: failedIds.slice(0, 10) });
  })));

  // Build visual sample for completion modal: pick 6 random described images.
  const samples = await db.select(...).where(...).orderBy(sql`RANDOM()`).limit(6);
  return { described, decorative, failed, total, sampleImages: samples };
}
```

### Vision provider chain — Anthropic-direct primær, OpenRouter fallback

**Beslutning (omvendt fra tidligere udkast)**: direkte Anthropic-API er målt ~4x hurtigere end samme model via OpenRouter (ingen middleware-roundtrip, ingen `usage:include`-cost-overhead, færre 400-fejl på base64-edge-cases). Med 1000+ billeder per bulk-job betyder 4x speedup ~3 min vs ~12 min. Derfor:

```
Anthropic direct (primær) → fail → OpenRouter (fallback)
```

```typescript
async function describeWithFallback(img: DocumentImage): Promise<'described'|'decorative'|'failed'> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await callAnthropicDirect(img);
    } catch (e) {
      // Fall through to OpenRouter
    }
  }
  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await callOpenRouter(img);
    } catch (e) {
      return 'failed';
    }
  }
  return 'failed';
}
```

**Env-variabler:**
- `ANTHROPIC_API_KEY` (primær) — direkte Anthropic-API. 4x hurtigere, lavere fail-rate.
- `OPENROUTER_API_KEY` (fallback) — bruges KUN hvis Anthropic-call fejler. Rate-limit, network-blip, invalid-base64 edge cases. Ingen ekstra cost vs at OpenRouter også havde været primær (samme model).

Christian's Anthropic-nøgle lægges i `.env` (gitignored) med kommentar "primær Vision-provider, 4x hurtigere end OpenRouter-passet". Ingen logging af nøglen, ingen echo til klient. Eksisterende OpenRouter-key forbliver i `.env` som fallback.

**Cost-tracking forbliver konsistent**: Anthropic-direct returnerer ikke `usage.cost` som OpenRouter, men `usage.input_tokens` + `usage.output_tokens`. Vi udregner cents lokalt via tariffen (Haiku: $1/MTok input, $5/MTok output). Funktion `anthropicCostCents()` allerede skitseret i nuværende `vision.ts`.

### Frontend — progress modal + header badge

#### Header badge (`apps/admin/src/components/jobs-badge.tsx`)
- Vises altid når der er ≥1 active job (status `pending`/`running`)
- Klik → åbner `JobsPanel` (samme modal som direct-trigger viser, bare med "Active jobs" liste øverst)
- Hover-tooltip: "2 background jobs running"

#### Progress modal (`apps/admin/src/components/job-progress-modal.tsx`)
```
┌──────────────────────────────────────────────────┐
│ Run Vision — Zoneterapibogen_2026.pdf            │
│                                                   │
│  [████████████░░░░░░] 94 / 224 (42%)             │
│  ETA: 2 min 14 sek                                │
│                                                   │
│  ✓ 88 described                                   │
│  ⚪ 4 decorative                                   │
│  ⚠ 12 failed (2 retried via Anthropic-direct)    │
│                                                   │
│  Estimated cost: $0.012                           │
│  Actual so far: $0.0048                           │
│                                                   │
│  [Kør i baggrunden]  [Annullér job]              │
└──────────────────────────────────────────────────┘
```

EventSource subscription via `useJobProgress(jobId)` hook. Live update without polling jitter. "Kør i baggrunden" lukker modal'en, badge'en bliver i header. "Annullér job" → POST `/jobs/:id/abort`, modal stays open showing "Aborting..." until handler hits abort-checkpoint.

#### Completion modal (auto-shown when status flips to `completed`)
```
┌──────────────────────────────────────────────────┐
│ ✓ Run Vision completed                            │
│   Zoneterapibogen_2026.pdf                        │
│                                                   │
│  218 described, 4 decorative, 2 failed (out of    │
│  224 total) in 4 min 23 sek. Cost: $0.012.        │
│                                                   │
│  Sample of described images:                      │
│  [img] [img] [img] [img] [img] [img]              │
│  hover for description                            │
│                                                   │
│  [Open image gallery]  [Close]                    │
└──────────────────────────────────────────────────┘
```

The sample is the visual verification: 6 random described-images with their generated description as hover-caption. Operator can spot-check quality without leaving the modal.

If user closed the modal early (clicked "Kør i baggrunden"), completion fires a toast instead with link to "View results" → reopens completion modal.

#### "Vælg alle"-flow

I sources.tsx (existing checkbox-state) tilføjes ny bulk-action: **"Run Vision (N)"**. Klik:

1. Pre-flight estimate: count NULL-described images across selected docs, estimate cost.
2. Confirmation modal: "This will run Vision on 1247 images across 30 sources. Estimated cost: $0.12. Estimated time: 7 min." [Cancel] [Start]
3. On start: POST `/jobs` with `kind='bulk-vision-rerun'`, `payload.documentIds=[...]`. Returns jobId. Modal flips to progress-mode.
4. Bulk-job spawner sub-jobs per doc OR processes flat (decision: flat, since per-doc concurrency adds complexity for negligible UX win — bulk progress shows aggregate, not per-doc breakdown). Per-doc breakdown er nice-to-have for v2.

### Cost transparency

`cost_cents_estimated` udregnes pre-flight: `images.length × $0.0001 × 100` for haiku. Konservativ — gemini's cheaper models could halve it. Vises som "Estimated $X" i confirmation modal.

`cost_cents_actual` opdateres efter hver Vision-call (`usage.cost` from OpenRouter response, or computed from token-counts for Anthropic-direct). Vises live i progress modal som "Actual so far: $Y".

Hvis `actual >= estimated × 1.5` mid-job, fyrer en advarsel i progress-modal: "Cost overrun: actual is $X, estimate was $Y. Continue or abort?". Operator-kontrol uden at panic-aborte.

### Visual verification — "did it actually work?"

Four layers:

1. **Sample-grid i completion modal**: 6 random described-images shown with their description as hover-caption. Hvis modellen havde et collapse (alle beskrivelser er "ja det er et billede" eller noget tomt), ses det her øjeblikkeligt.
2. **Failed-list link**: "12 failed" linker til en filtered view af `document_images` hvor `vision_at IS NOT NULL AND vision_description IS NULL` (= scanned-but-failed). Operator kan re-køre kun de failed.
3. **Diff-mode**: completion modal har en "Show before/after" toggle der viser images count over time: "224 NULL → 6 NULL after this run". Bekræfter at jobbet flyttede tallet i den rigtige retning.
4. **Vision quality QA — thumbs up/down per sample-image**. Hver image i sample-grid'et har 👍 / 👎 knapper. Klik registrerer en `vision_quality_ratings`-row (image_id, user_id, rating, created_at, model). Aggregat-stats vises som "Sample quality: 4 good, 1 bad, 1 unrated". Data fodrer fremtidens prompt-tuning, model-comparison og confidence-badges. Out of scope at ACTE på ratingen i v1 — bare collect data. Migration `0028_vision_quality_ratings.sql` lander samtidig med Phase 5.

Denne 4-lags verifikation er pointen i Christians "MAX visual verification". Det er ikke kun progress-bar; det er proof-of-work + structured feedback til quality-loop.

### Long-running stability

| Risiko | Mitigation |
|---|---|
| Engine crashes mid-job | Heartbeat-baseret zombie-detect + auto-resume. F143 pattern. |
| Vision API rate-limit | Per-job concurrency-cap (default 3). Rate-limit detection → exponential backoff per failed call. |
| Vision API timeout (network blip) | Per-call 30s timeout (existing). Counts as failed; retry via Anthropic-direct fallback. |
| Disk full mid-run (storage of vision_description text) | Highly unlikely — descriptions are <1KB. SQLite handles gracefully. |
| User aborts mid-run, engine crashes before commit | abort_requested flag persists; resume-handler honors it on restart and transitions to 'aborted'. |
| Multi-tenant cross-talk | jobs.tenant_id required. Runner only picks up jobs matching engine's tenant scope. |
| Job stuck on a single bad image (infinite loop) | Per-call timeout + finite retry budget. After max-retries on a specific image, mark it scanned with vision_description=NULL and a vision_error_message column (new in 0027 migration). |
| User closes browser mid-run | Job continues server-side. Reload reattaches via SSE on jobId stored in localStorage. |
| Cost overrun via auto-mode | actual vs estimated check + UI warning. Hard cap via env (`TRAIL_BULK_VISION_HARD_COST_CAP_USD`). |

### Idempotency

All Vision-rerun handlers MUST be idempotent:
- Filter on `vision_description IS NULL` ensures already-described images are skipped.
- Abort + restart picks up where it left off.
- Two concurrent jobs on overlapping image-sets: last-write wins on description text. Acceptable — the duplicate Vision call wastes <$0.0001 but produces no corrupt state.

## Architecture sketch

```
Browser
   │ click "Run Vision (Vælg alle)"
   ▼
SourcesPanel — pre-flight estimate
   │ POST /api/v1/jobs { kind:'bulk-vision-rerun', payload:{ documentIds:[...] } }
   ▼
JobRunner.submit() → INSERT jobs row, returns jobId
   │
   ▼
JobProgressModal — open EventSource(/api/v1/jobs/:id/stream)
   │
   ▼
Background tick (every 1s)
   │ pick pending job, dispatch to handler
   ▼
visionRerunHandler — pLimit(3) over images
   │ describeWithFallback(img)
   │   ├ openrouter → ok
   │   └ openrouter fail → anthropic-direct (if key) → ok / fail
   │ UPDATE document_images SET vision_description=...
   │ report({ current, total, eta, ... })
   ▼
SSE emit → modal updates progress bar live
   │
   ▼
On complete → result row + sample images → completion modal / toast
```

## Phases & verify scripts

### Phase 1 — jobs-table + runner (1 day)
- Migration `0027_jobs_table.sql` (sequenced after F162-race-fix migration).
- `jobs/runner.ts` med stub-handler `noop` der bare reporter `{ tick: 1 }` hvert 200ms i 3s.
- HTTP-routes: `POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/stream`, `POST /jobs/:id/abort`.
- Verify: `apps/server/scripts/verify-f164-jobs-runner.ts` der submitter et noop-job, subscribter SSE, asserter at progress events lander, abort'er, asserter status='aborted', restart'er engine, asserter zombie-recovery.

### Phase 2 — vision-rerun handler (½ day)
- Wire eksisterende rerun-vision logic ind i handler. Behold gammel endpoint som thin wrapper der spawner job + waiter på completion (backwards-compat for nuværende admin-button).
- Verify: `verify-f164-vision-rerun.ts` der opretter test-doc med 5 NULL-images, submitter job, asserter at 5 described på completion.

### Phase 3 — Anthropic-direct fallback (½ day)
- Ny env `ANTHROPIC_API_KEY_FALLBACK`.
- `describeWithFallback` wrapper.
- Verify: `verify-f164-fallback.ts` med mocked OpenRouter-fail → asserter Anthropic-direct fires + succeeds.

### Phase 4 — Frontend modal + badge + bulk (1 day)
- Components: `JobProgressModal`, `JobsBadge`, `useJobProgress` hook.
- Sources panel: bulk-action "Run Vision (N)" + confirmation + progress-handoff.
- "Kør i baggrunden" toggle. Toast on completion.
- i18n keys (da/en).
- Visual: tested via dev browser w/ real Sanne KB. Spot-check 6-image sample-grid quality.

### Phase 5 — Polish + visual verification (½ day)
- Completion modal sample-grid med hover-captions.
- Failed-list link til filtered image-view.
- Cost overrun warning.
- ProcessingIndicator.tsx pattern (existing) extends til job-progress.
- **Vision quality QA**: migration `0028_vision_quality_ratings.sql` (image_id, user_id, rating, model, created_at). Thumbs-up/down på sample-grid items. POST `/images/:id/rating` endpoint. Aggregat-counter i completion modal.

### Phase 6 — Job-history UI (½ day)
- Nyt admin-side `/admin/jobs` (top-level, ikke per-KB) — list af alle jobs på tværs af KB'er for nuværende tenant.
- Kolonner: kind, status, created_at, finished_at, duration, cost_actual, user_id (hvem trykkede), result-summary.
- Filter: by-status (active/completed/failed/aborted), by-kind, by-kb. Date-range picker.
- Klik på row → genåbner completion-modal (eller progress-modal hvis stadig running).
- Søgbar via FTS på `result.error_message` eller `payload.documentIds`-match.
- Aggregat-statistik øverst: "234 jobs i alt — 220 completed, 8 failed, 6 aborted. Total cost: $4.23 over 30 dage."
- Header-link "Jobs ({active})" mellem "Settings" og "Glossary" så curator kan tilgå historikken når aktive-badge ikke er synligt.

Total: ~4 dage. Kan landes i 6 separate commits så hver fase er reviewable + revertible.

## Dependencies

- **F143 (zombie-recovery for ingest)** — pattern reuse, ikke hard dep.
- **F156 (credits)** — Vision-cost stamping bruger samme `usage.cost` field. Cost ledger integration: hvert Vision-call `consumeCredits(tenantId, costCents)` så bulk-jobs også registrerer credit-forbrug.
- **F161 (document_images)** — hard dep, det vi rerun'er.
- **F162-race-fix (kommende)** — F162's UNIQUE constraint på content_hash skal lande først så migrations-counter er konsistent (0026 = F162-race, 0027 = F164 jobs-table).

## Rollout

Conservative deploy:
1. Phase 1+2 lander, gammel endpoint stadig wraps + venter (backwards-compat). Test af jobs-framework uden at skifte UX.
2. Phase 3 lander. ANTHROPIC_API_KEY_FALLBACK set. Failed-rate måles på Sanne's KB efter rerun. Beslutning: fortsæt eller pause baseret på fallback-success-rate.
3. Phase 4+5 lander. Frontend skifter fra wait-on-endpoint til submit-job + modal. Gammel endpoint deprecated men ikke removed (fjernes når vi har 1 uges drift uden issues).

Feature-flag: `TRAIL_BACKGROUND_JOBS=1` (default off i v1, on når Phase 4 er stabil). Når on, frontend bruger nye flow; når off, gammel wait-on-endpoint flow. Lader os toggle uden re-deploy hvis noget er galt.

## Resolved decisions (fra plan-review 2026-04-27)

- **Job-history UI**: ✅ INKLUDERET i v1 (Phase 6). Top-level admin-side `/admin/jobs` med filter, search, klik-til-detail. Aggregat-stats øverst.
- **Resumability granularity**: ✅ ACCEPTABLE — i-flight image ved crash spildes ($0.0001). Idempotency-filter sikrer at allerede-processerede beholdes.
- **Notification preference**: ❌ NEJ til email i v1. Toast + badge er nok. `notify_on_completion`-kolonne ikke tilføjet pre-emptively; kan ALTER TABLE senere når email/Slack/Discord-kanal aktiveres.
- **Concurrency cap pr. tenant vs globalt**: globalt `MAX_CONCURRENT_JOBS=4` (bumpet fra 3, sized for Fly.io shared-cpu-1x). Bumpes når Fly-tier opgraderes. Multi-tenant overvejelser revisits når F40.2 lander.
- **Vision quality QA**: ✅ INKLUDERET i v1 (Phase 5). Thumbs-up/down per sample-image, gemmes i `vision_quality_ratings`-tabel. v1 collecter data, v2 ACTE på det (prompt-tuning, model-comparison, confidence-badges).
- **Vision provider chain**: ✅ Anthropic-direct primær (4x hurtigere), OpenRouter fallback. Anthropic-key flytter fra "fallback only" til "primary".

## Remaining open questions

- **Per-doc breakdown i bulk-mode**: viser progress-modal nu kun aggregate (94 / 1247). Per-doc dropdown ("source A: 12/40, source B: 80/210") kan tilføjes i v2 hvis curator-feedback efterspørger det. Default: aggregate.
- **Vision quality rating semantik**: hvad gør 👎 helt konkret? Forslag for v1: registrer rating, ingen action. v1.5: skift model på næste rerun for billeder med rating='down'. v2: prompt-tune-loop hvor down-ratede images sendes til en "improve description"-meta-prompt. Beslutning udskudt til v1 har data at se på.
- **Job-history retention**: holder vi alle jobs forever? Disk-cost er minimal (~1KB per job-row), men efter 1000+ jobs bliver `/admin/jobs` listen tung. Forslag: behold alle, paginate aggressively, F164.x adder sweep-job der archiver completed jobs ældre end 90 dage til en separate `jobs_archive`-tabel.
