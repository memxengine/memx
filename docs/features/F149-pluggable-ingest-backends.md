# F149 — Pluggable Ingest Backends

> Abstrahér `apps/server/src/services/ingest.ts` bag et `IngestBackend`-interface med to live implementeringer — `ClaudeCLIBackend` (nuværende claude-CLI-subprocess, default) og `OpenRouterBackend` (cloud-models: Gemini 2.5 Flash, GLM 4.6, Qwen 3.6 Plus + Claude Sonnet via API). Live runtime fallback-chain med per-turn model-switch når en backend fejler; per-tenant billing keys; per-KB default model-valg; runtime-switchable (UI-follow-up) så en curator kan flippe model mid-session uden redeploy. Tier: alle tenants. Effort: Large — 5-7 dage. Status: Planned.

## Problem

Trail's ingest-pipeline er hard-wired til `claude -p`-CLI-subprocessen. Model-lab-eksperimentet (rapport i `apps/model-lab/data/REPORT.md`, 2026-04-24) viste at cloud-open-source-modeller (Gemini 2.5 Flash, GLM 4.6, Qwen 3.6) leverer sammenlignelig eller bedre ingest-kvalitet til ~1/10 af Claude Sonnet's pris per bog — uden at ændre output-formatet nævneværdigt.

| Model | Pris/bog (NADA-proof) | Status |
|---|---|---|
| Gemini 2.5 Flash | ~$0.66 | Produktionsfavorit |
| GLM + Flash 2-pass | ~$1.39 | Højeste kvalitet (typed edges) |
| Qwen 3.6 Plus | ~$0.40 | Budget-variant |
| Claude Sonnet 4.6 | ~$6–8 | 10× dyrere, Christians Max Plan dækker i dev |

I dag kan vi ikke:
- Skifte model mellem jobs uden at redeploye serveren med ændret `INGEST_MODEL`.
- Sætte forskellige modeller pr. KB (fx Sanne's produktions-KB på Flash, intern dogfood-KB på Claude CLI for at beskytte dialogen mod quota-forbrug).
- Lade en tenant betale for deres eget forbrug — alle ingester spises i dag af Christians Max Plan (claude-cli) eller et fælles OpenRouter-API-key hvis vi fanger hjemme bygget løsning.
- Håndtere model-fejl robust: hvis Gemini Flash returnerer 429 på en stor kilde, fejler hele ingest-jobbet selvom GLM eller Qwen kunne have fuldført det sidste trin.

Christian's dekret (2026-04-24): ingest skal kunne skifte model **live mid-job** når en model fejler, **pr. KB** som default, **pr. tenant** for billing, og senere (UI-followup) **runtime** uden env/redeploy.

## Secondary Pain Points

- **Debug/observability i dag**: ingest-fejl gives ned som en ugennemsigtig CLI-stacktrace. Med OpenRouter's structured error-response (subtype: context-limit, rate-limit, refusal) kan vi i stedet give curator en handlingsrettet sætning.
- **Cost transparency**: der findes ingen per-job eller per-KB omkostnings-opgørelse i admin i dag. Vi ved ikke hvad Sanne's brain koster at holde opdateret — relevant når vi pricing-modellerer F43 Stripe-billing.
- **Quality comparison over tid**: når en ny model lander (Claude Haiku 4.5, Gemini 3 osv.), vil vi side-by-side-sammenligne ingests af den samme kilde — i dag kræver det at genlave model-lab-eksperimentet fra bunden.
- **Claude Max-afhængighed**: hele Christians dev-flow er i dag betinget af Max-abonnementet. Cloud-backend er forsikring mod en afbrydelse (plan-ændring, kontofejl, CLI-nedbrud).

## Solution

Factor `runJob` i `ingest.ts` bag et smalt `IngestBackend`-interface. Flyt den eksisterende `spawnClaude`-kode ind i `ClaudeCLIBackend` uændret. Tilføj `OpenRouterBackend` ved at løfte model-lab's OpenRouter-plumbing (`openrouter.ts`, `runner.ts`, `two-pass.ts`, `tools.ts`) ind i server-lag — men tilslut dem til Trail's eksisterende MCP-write-værktøj så alle nedstrømsfeatures (F111.2 stamping, F137 edge-types, F140 schemas, F148 link-checker) bliver ved at virke identisk uanset backend.

Backend-valg + fallback-chain løses som en ren funktion `resolveIngestChain(kb, env)` der returnerer en ordnet liste af `{backend, model}`-par. Runner prøver paret i rækkefølge; på model-fejl skifter den til næste par mid-job mens den bevarer indtil-nu-skrevne Neuroner. Chain stoppes når jobbet lykkes eller listen tømmes.

## Non-Goals

- **Runtime UI-switch** → **promoted to F152** (Runtime Model Switcher UI). F149 leverer pure-function chain-resolution + PATCH-routes; F152 ship'er dropdown'en.
- **Cost & Quality dashboards** → **promoted to F151** (Cost & Quality Dashboard). F149 persisterer `cost_cents` + `model_trail`; F151 render'er dem.
- **Streaming tokens til admin UI under ingest.** Begge backends returnerer et final-result; progress rapporteres via de eksisterende `ingest_started`/`ingest_completed`-events.
- **Per-tenant billing aggregation + fakturaer** → **covered by F43 (Stripe Billing) + F44 (Usage Metering)**. `cost_cents`-kolonnen er data-kilden; fakturerings-logik lever dér.
- **To-backend voting / konsensus-ingest.** Spændende men out of scope — vi vælger én backend per turn.
- **Auto-retraining af billingsmodellen baseret på historiske cost_cents.** Declined — pricing-tier sættes manuelt via F43; ingen business-case for auto-retrain. Noteret i `docs/NON-GOALS.md`.

**Arkitektur-åbnet** (ikke-shipped i v1 men interface klar):
- **Direkte Anthropic API, Vertex AI, Bedrock, andre cloud-providers.** Fordi OpenRouterBackend bruger in-process `CandidateQueueAPI` (ikke MCP-subprocess), er det trivielt at tilføje `AnthropicBackend` eller `VertexBackend` senere uden arkitektur-ændring. F149 v1 shipper Claude CLI (via MCP) + OpenRouter (in-process); andre kommer efterhånden.

## Technical Design

### Interface

Ny fil `apps/server/src/services/ingest/backend.ts`:

```typescript
export interface IngestBackendInput {
  prompt: string;
  tools: string[];              // mcp__trail__{guide,search,read,write}
  mcpConfigPath: string;        // per-job config written by writeIngestMcpConfig
  model: string;                // "claude-sonnet-4-6" | "google/gemini-2.5-flash" | ...
  maxTurns: number;
  timeoutMs: number;
  env: Record<string, string>;  // TRAIL_TENANT_ID etc
  // Optional two-pass: a lighter translator/drafter that hands its
  // output to the main model. GLM → Flash is the paradigmatic combo.
  translationModel?: string;
}

export interface IngestBackendResult {
  turns: number;
  durationMs: number;
  costCents: number;            // rounded; 0 if the backend can't surface it
  modelTrail: Array<{ turn: number; model: string }>;
}

export interface IngestBackend {
  readonly id: 'claude-cli' | 'openrouter';
  run(input: IngestBackendInput): Promise<IngestBackendResult>;
}
```

### ClaudeCLIBackend

Ny fil `apps/server/src/services/ingest/claude-cli-backend.ts`. Flyt den eksisterende `spawnClaude(args, ...)`-invocation i `runJob` ind her uændret. Parse CLI's `--output-format json` svar for `num_turns` + evt. cost (CLI returnerer cost-info i final-message when using the Anthropic API path; Max Plan returnerer 0). Default-model: `claude-sonnet-4-6`.

### OpenRouterBackend (in-process — ikke via MCP)

Ny fil `apps/server/src/services/ingest/openrouter-backend.ts`. Løft fra `apps/model-lab/src/server/openrouter.ts` + `runner.ts` + `tools.ts` + `two-pass.ts`.

**Arkitektur-beslutning (Christian 2026-04-24):** OpenRouterBackend kører in-process i `apps/server`. Det behøver IKKE gå igennem MCP — MCP var kun nødvendig for `claude-cli` fordi subprocessen kunne ikke kalde DB direkte. In-process backend kan kalde Trail's core-funktioner direkte uden subprocess-roundtrip.

Ny intern API: `packages/core/src/ingest/candidate-api.ts` eksporterer:

```typescript
export interface CandidateQueueAPI {
  search(query: { mode: 'list' | 'search'; kind?: string; q?: string }): Promise<SearchResult>;
  read(path: string): Promise<ReadResult>;
  write(args: WriteArgs): Promise<WriteResult>;
}

export function createCandidateQueueAPI(
  trail: TrailDatabase,
  ctx: { tenantId: string; userId: string; kbId: string; ingestJobId: string; connector: string },
): CandidateQueueAPI;
```

Funktionaliteten er identisk med hvad `mcp__trail__{search,read,write}` tilbyder — faktisk eksporterer vi `apps/mcp/src/index.ts`'s handlers i en faktoreret form som **begge** MCP-serveren OG OpenRouterBackend importerer. Sandheden lever ét sted.

OpenRouterBackend's tool-loop (porteret fra model-lab's `runner.ts`) oversætter model's tool-calls til direkte `CandidateQueueAPI`-kald:

```typescript
for (const toolCall of modelResponse.tool_calls) {
  const result = await candidateApi[toolCall.name](toolCall.arguments);
  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
}
```

Downstream-features kører uændret fordi `createCandidate()` (som `CandidateQueueAPI.write` kalder) fyrer `candidate_approved`-events → F111.2 stamping, F137 edges, F140 schemas, F148 link-checker lytter på dem som altid.

**Fordele ved in-process i stedet for MCP:**
- Færre lag = færre fejl-punkter (ingen stdio-parsing, ingen subprocess-crash-håndtering)
- Hurtigere (ingen subprocess-roundtrip per tool-call; ~5-20ms sparet pr. call × ~30 calls/ingest = ~500ms per ingest)
- Nemmere debugging (in-process stack-traces)
- **Åbner automatisk for Anthropic API / Vertex / Bedrock**: alle in-process, alle via samme `CandidateQueueAPI` → ingen ny MCP-wiring per backend

**ClaudeCLIBackend beholder MCP-pathet** fordi den kører som subprocess og IKKE kan kalde in-process funktioner. MCP er stdio-broen for netop den use-case.

Cost-beregning: OpenRouter returnerer `{usage: {total_cost}}` i response — konverter til cents og rapportér.

### Fallback chain — live runtime switch

```typescript
// apps/server/src/services/ingest/chain.ts
export interface ChainStep {
  backend: 'claude-cli' | 'openrouter';
  model: string;
  translationModel?: string;
}

const DEFAULT_CHAIN_CLAUDE_CLI: ChainStep[] = [
  { backend: 'claude-cli', model: 'claude-sonnet-4-6' },
  { backend: 'openrouter', model: 'google/gemini-2.5-flash' },
  { backend: 'openrouter', model: 'z-ai/glm-4.6' },
  { backend: 'openrouter', model: 'qwen/qwen-plus' },
];
const DEFAULT_CHAIN_OPENROUTER: ChainStep[] = [
  { backend: 'openrouter', model: 'google/gemini-2.5-flash' },
  { backend: 'openrouter', model: 'z-ai/glm-4.6' },
  { backend: 'openrouter', model: 'qwen/qwen-plus' },
  { backend: 'openrouter', model: 'anthropic/claude-sonnet-4.6' }, // via API, not Max Plan
];

export function resolveIngestChain(kb: KnowledgeBase, env: NodeEnv): ChainStep[] {
  // Precedence: KB column > env > hardcoded default
  if (kb.ingestFallbackChain) return JSON.parse(kb.ingestFallbackChain);
  const primary = kb.ingestBackend ?? env.INGEST_BACKEND ?? 'claude-cli';
  return primary === 'openrouter' ? DEFAULT_CHAIN_OPENROUTER : DEFAULT_CHAIN_CLAUDE_CLI;
}
```

Runner wrapper i `ingest.ts`:

```typescript
async function runWithFallback(input, chain, jobId): Promise<IngestBackendResult> {
  const modelTrail = [];
  let lastError: Error | null = null;
  for (const step of chain) {
    const backend = getBackend(step.backend);
    try {
      // Give each step ONE transient retry (network/rate-limit blips)
      // before moving on. Budget per step = overall timeout / chainLength.
      const result = await backend.run({
        ...input,
        model: step.model,
        translationModel: step.translationModel,
      });
      modelTrail.push(...result.modelTrail);
      // Persist the trail so the curator can audit what actually ran
      await trail.db.update(ingestJobs)
        .set({ modelTrail: JSON.stringify(modelTrail) })
        .where(eq(ingestJobs.id, jobId));
      return { ...result, modelTrail };
    } catch (err) {
      lastError = err as Error;
      modelTrail.push({ turn: -1, model: step.model, failed: String(err) });
      console.warn(`[ingest] step ${step.backend}/${step.model} failed — advancing chain`, err);
    }
  }
  throw new Error(`ingest chain exhausted; last error: ${lastError?.message}`);
}
```

### Per-tenant API keys

Ny tabel `tenant_secrets`:

```sql
CREATE TABLE tenant_secrets (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  claude_api_key_encrypted TEXT,
  openrouter_api_key_encrypted TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Kryptering: genbrug evt. eksisterende crypto-lag; ellers tilføj libsodium `crypto_secretbox` med en server-side master-key fra `TRAIL_SECRETS_MASTER_KEY`-env-var. **Aldrig plaintext på disk.** Master-key roteres via deploy-time env-skift.

Precedence ved ingest-job resolve:
1. `tenant_secrets.<provider>_api_key` (hvis sat og kan dekrypteres)
2. Proces-env (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`)
3. For `claude-cli`: fall-through til brugerens logged-in `claude`-session (Max Plan)

Admin UI tilføjer "Billing Keys"-tab pr. tenant (stubbed i F149; fuld UI i separat F-feature). v1 bruger env-vars hvis DB-kolonner er tomme — samme fallback som i dag.

### Per-KB model-valg

Tilføj til `knowledge_bases`:
- `ingest_backend TEXT` — `'claude-cli' | 'openrouter' | NULL` (null = follow env default)
- `ingest_model TEXT` — specifik model i den valgte backend
- `ingest_fallback_chain TEXT` — optional JSON override af chain

Admin kb-settings får model-dropdown fra `packages/shared/src/ingest-models.ts` (ny fil, curated whitelist). Operator der vil have en brand-ny model flipper én boolean i registry'et.

### ingest_jobs udvidelse

Ny migration `0014_ingest_cost_and_backend.sql`:

```sql
ALTER TABLE ingest_jobs ADD COLUMN cost_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN backend TEXT;
ALTER TABLE ingest_jobs ADD COLUMN model_trail TEXT;

ALTER TABLE knowledge_bases ADD COLUMN ingest_backend TEXT;
ALTER TABLE knowledge_bases ADD COLUMN ingest_model TEXT;
ALTER TABLE knowledge_bases ADD COLUMN ingest_fallback_chain TEXT;
```

## Interface

**HTTP (nye):**
- `GET /api/v1/knowledge-bases/:kbId/ingest-settings` → `{backend, model, fallbackChain}`
- `PATCH /api/v1/knowledge-bases/:kbId/ingest-settings` — curator-scoped, opdaterer KB-kolonner
- `GET /api/v1/ingest-models` → `[{backend, model, description, costPer1kTokens}]` fra `ingest-models.ts`

**Env (nye):**
- `INGEST_BACKEND=claude-cli|openrouter` (default claude-cli)
- `INGEST_MODEL=<model-id>` (default pr. backend)
- `INGEST_FALLBACK_CHAIN=<json>` (override default chain, rare)
- `OPENROUTER_API_KEY`
- `ANTHROPIC_API_KEY` (når chain inkluderer `anthropic/*`-step via API, ikke CLI)
- `TRAIL_SECRETS_MASTER_KEY` (sealing key for tenant_secrets)

**Shared types (nye):**
- `@trail/shared` eksporterer `IngestModelId`, `IngestBackendId`, `ChainStep`

## Rollout

**To-fase deploy.**

**Fase 1 — safe ground** (1–2 dage):
- Interface + `ClaudeCLIBackend` extraction. Ingen ny adfærd — bare refactor. `resolveIngestChain` returnerer altid den gamle single-step `[{claude-cli, claude-sonnet-4-6}]`.
- Migration 0014 lander kolonner (nullable). `cost_cents=0` for alle eksisterende rækker.
- Verifikation: `apps/server/scripts/verify-backend-claude.ts` bekræfter én-turn CLI-call roundtrip via new path.

**Fase 2 — OpenRouter + chain** (2–3 dage):
- `OpenRouterBackend` implementeret + wired.
- Default-chains aktiveres.
- Mock-fail-trial-runs via `apps/server/scripts/trial-fallback-*.ts` mod `http://127.0.0.1:58031/kb/development-tester/neurons`.
- Per-tenant `tenant_secrets`-tabel lander med env-fallback (så eksisterende deploys ikke kræver migration af hemmeligheder).
- Christian kører fortsat claude-cli (Max Plan) som default — F149 aktiverer *capability*, ikke *default behavior*. Flipper individuelt hvis/når Christian siger til.

**Fase 3 — UI** (separat F-feature, ikke v1):
- Model-dropdown pr. KB. Runtime-edit + live-preview.

## Success Criteria

**Test-kilde**: `docs/features/F149-pluggable-ingest-backends.md` (dette plan-dokument selv, ~30KB markdown) uploadet til KB `development-tester` (`http://127.0.0.1:58031/kb/development-tester/neurons`). Kilden er lille nok til hurtig iteration (<60s per backend), stor nok til at trigge multi-turn-ingest og afsløre fejl i tool-call-loop. Bevidst fravalg af den fulde NADA-PDF (122 sider) — den gemmes til Sanne's KB når vi er ready til produktion.

Hvis F149-plan-doc'en viser sig for lille (fx ingen typed edges fordi tæt teknisk tekst), falder vi tilbage til en fixture-kombination `F148 + F149 + F150 plan-docs` concatenated som én kilde (~100KB) der garanterer diversitet.

1. **Samme kilde producerer samme-kvalitets-wiki uanset backend.** Målt ved: kør ingest på F149-plan-doc'en via både `claude-cli + claude-sonnet-4-6` og `openrouter + google/gemini-2.5-flash`; antal Neuroner skabt, antal wiki-links, antal entity-refs sammenlignelig inden for ±20%.
2. **Mock-fail fra første chain-step udløser korrekt fallback.** `trial-fallback-rate-limit.ts` injicerer en 429 i Gemini Flash; runner skifter til GLM, fuldfører jobbet, `ingest_jobs.model_trail` indeholder begge modeller.
3. **Cost_cents populeres korrekt.** For en test-ingest af F149-plan-doc'en: `cost_cents > 0` for OpenRouter-path (forventet 5-20 cent for denne str.); `cost_cents=0` for claude-cli-Max-path (intet billing-signal, "gratis (Max)"-badge).
4. **Per-KB override vinder over env.** Sæt `INGEST_MODEL=claude-sonnet-4-6` i env, men `knowledge_bases.ingest_model='google/gemini-2.5-flash'` på development-tester-KB. Verificér at jobbet kører på Flash.
5. **Per-tenant key fallback (via dev-tenant seed-script).** Vi har ingen UI til at oprette tenants; verificéres via `apps/server/scripts/seed-dev-tenant.ts` der SQL-inserter en skjult dev-tenant + KB + user + `tenant_secrets`-row med krypteret OpenRouter-key. Test-flow: slet proces-env `OPENROUTER_API_KEY`; kør ingest på dev-tenantens KB → succes (henter fra tenant_secrets). Kør ingest på en tredje tenant uden key → synligt fejlet job med klar fejlbesked "No OpenRouter key configured for this tenant".
6. **Backwards compat**: en pre-F149 KB uden `ingest_backend`/`ingest_model`-felter falder tilbage til `claude-cli + claude-sonnet-4-6` identisk med pre-F149-adfærd. Sanne's KB ingester fortsætter uændret efter deploy.
7. **Model-registry CI-check grøn**: `scripts/verify-ingest-models.ts` kalder OpenRouter's `/models`-endpoint og Anthropic's `/models`-endpoint og bekræfter at alle whitelist-IDs eksisterer. Kører i pre-commit hook eller CI. Fejler byggen hvis en model-ID er stale.

## Impact Analysis

### Files created (new)

- `docs/features/F149-pluggable-ingest-backends.md` — dette plan-dokument.
- `apps/server/src/services/ingest/backend.ts` — `IngestBackend`-interface.
- `apps/server/src/services/ingest/claude-cli-backend.ts` — wrapper om eksisterende `spawnClaude`.
- `apps/server/src/services/ingest/openrouter-backend.ts` — port af model-lab-OpenRouter-pipelinen.
- `apps/server/src/services/ingest/chain.ts` — `resolveIngestChain` + default chains.
- `apps/server/src/services/ingest/runner.ts` — `runWithFallback` orchestrator.
- `apps/server/src/services/tenant-secrets.ts` — read/write + encryption for API-keys.
- `apps/server/src/routes/ingest-settings.ts` — `GET`/`PATCH /knowledge-bases/:kbId/ingest-settings`.
- `apps/server/src/routes/ingest-models.ts` — `GET /ingest-models` (static whitelist).
- `apps/server/scripts/verify-backend-claude.ts` — scripted probe for Claude CLI path.
- `apps/server/scripts/verify-backend-openrouter.ts` — scripted probe for OpenRouter path.
- `apps/server/scripts/verify-backend-switch.ts` — scripted probe for per-KB override.
- `apps/server/scripts/trial-fallback-rate-limit.ts` — injected 429-fail mid-chain.
- `apps/server/scripts/trial-fallback-context-limit.ts` — injected oversized-context fail.
- `packages/db/drizzle/0014_ingest_cost_and_backend.sql` — migration.
- `packages/shared/src/ingest-models.ts` — whitelist + metadata.

### Files modified

- `apps/server/src/services/ingest.ts` — tynd orchestrator der kalder `runWithFallback(input, resolveIngestChain(kb, env))`. Fjerner direkte `spawnClaude`-kald.
- `apps/server/src/services/claude.ts` — uændret funktion, flytter ingen kode; `ClaudeCLIBackend` importerer den.
- `apps/server/src/app.ts` — mount ny `ingest-settings` + `ingest-models`-routes.
- `apps/server/src/middleware/auth.ts` — tilføj tenant-secret-læsning før ingest-run (hook i eksisterende `getTenant`-ctx eller parallel helper).
- `packages/db/src/schema.ts` — kolonner på `ingest_jobs` + `knowledge_bases`, ny tabel `tenant_secrets`.
- `packages/db/drizzle/meta/_journal.json` — tilføj `0014`-entry.
- `packages/shared/src/schemas.ts` — Zod-shape for de nye KB-felter (`ingest_backend`, `ingest_model`, `ingest_fallback_chain`).

### Downstream dependents

**`apps/server/src/services/ingest.ts`** er kun selv-kaldet fra `triggerIngest` (intern til `apps/server/src/services/ingest.ts`) og `recoverIngestJobs` (kaldet fra `apps/server/src/index.ts:49`). Ingen external-importer berørte; interface-skiftet sker bag en fuldstændig intern API.

**`apps/server/src/services/claude.ts`** importeret af:
- `apps/server/src/services/ingest.ts` (1 ref) — efter F149 kun gennem `ClaudeCLIBackend`-wrapperen. Uændret i `claude.ts` selv.
- `apps/server/src/services/chat.ts` (hvis den bruger claude-CLI for non-ingest-formål) — unaffected.
Kun ingest-pathet flyttes; chat-pathet er uændret.

**`packages/db/src/schema.ts`** eksporterer til hele engine'en. Nye kolonner er nullable — ingen eksisterende kald brækker. Nye tabeller (`tenant_secrets`) påvirker kun de nye routes.

**`apps/server/src/middleware/auth.ts`** importeret af enhver route-modul (~15 filer). Hvis jeg tilføjer secret-lookup i `getTenant` flyder ekstra DB-I/O til hver request — så helst hold det i en separat helper kun kaldet i ingest-path. Grep-verified: middleware-hook kan holdes lokal.

**`packages/shared/src/schemas.ts`** eksporterer KnowledgeBaseSchema til:
- `apps/admin/src/` (~10 filer bruger `KnowledgeBase`-type) — uændret; nye felter er valgfrie.
- `apps/server/src/routes/knowledge-bases.ts` — tilføjer validering af de nye felter i PATCH.

### Blast radius

- **Eksisterende ingests skal ikke regress.** Default chain for `claude-cli` er en enkelt-step-chain til `claude-sonnet-4-6` — identisk med nuværende adfærd. Fase 1 må kunne ship'e uden Christian bemærker nogen forskel på Sanne's KB.
- **Fejl-håndtering**: `humaniseIngestError` udvides med OpenRouter-fejl-shapes. Pre-F149-fejl-strenge der matchede `claude timed out` og `error_max_turns` ændrer sig ikke.
- **MCP-subprocess env**: OpenRouter-backenden SKAL også bruge `writeIngestMcpConfig`-mønsteret så MCP-writes stadig får `TRAIL_INGEST_JOB_ID`, `TRAIL_CONNECTOR` osv. Glemmer vi dét fejler F111.2-stamping og link-checker kan ikke wire tilbage.
- **Cost tracking edge-case**: Max Plan returnerer 0 cost fra claude-CLI. `cost_cents=0` kan enten betyde "gratis Max Plan" eller "ukendt" — admin UI skal skelne (evt. via `backend='claude-cli' && cost_cents===0 → 'Max Plan'`-badge).
- **Concurrent runs samme KB**: F143-kø sørger for én-ad-gangen pr. KB. Fallback-chain kører inden for samme job-slot; ingen ny concurrency-bekymring.
- **Migration 0014 er ALTER TABLE med default**: idempotent; eksisterende rækker får `cost_cents=0`, `backend=NULL` (hvilket runner fortolker som "default").

### Breaking changes

**Ingen — alle ændringer er additive.**

- `spawnClaude` signaturen uændret; F149 flytter bare call-site.
- Nye DB-kolonner er nullable med defaults.
- Nye env-vars har fallbacks.
- HTTP API er additiv.
- Zod-schemas får kun `.optional()`-felter.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `resolveIngestChain` returnerer default claude-cli-chain når `kb.ingestBackend=null`
- [ ] Unit: `resolveIngestChain` respekterer `kb.ingestFallbackChain` JSON-override
- [ ] Unit: `resolveIngestChain` falder tilbage på env når KB-kolonner er tomme
- [ ] Unit: `ChainStep`-Zod-schema afviser ukendte backends
- [ ] Integration (Fase 1): `verify-backend-claude.ts` — one-turn CLI-call roundtrip via `ClaudeCLIBackend`, verificér MCP-config læses, cost==0, turns>=1
- [ ] Integration (Fase 2): `verify-backend-openrouter.ts` — one-turn Gemini Flash-call, verificér MCP-tool-call roundtrip lander candidate i queue, cost_cents > 0
- [ ] Integration: `verify-backend-switch.ts` — ingest samme source via begge backends, assert begge producerer valide Neurons + `ingest_jobs.backend`-kolonne korrekt
- [ ] Integration: `trial-fallback-rate-limit.ts` — inject 429 i Flash-step, assert chain fortsætter til GLM, final-status='done', modelTrail indeholder begge
- [ ] Integration: `trial-fallback-context-limit.ts` — inject "context limit exceeded" midt i et multi-turn-job, assert state bevares og næste model fortsætter
- [ ] Integration: `tenant_secrets` encryption round-trip (write → read returnerer original plaintext)
- [ ] Manual: flip Sanne's KB til Gemini Flash via admin-settings, kør ingest, verificér succes + omkostnings-badge
- [ ] Migration proof: `pragma_table_info('ingest_jobs')` indeholder `cost_cents`/`backend`/`model_trail`; `__drizzle_migrations` har 0014
- [ ] Regression: en KB uden `ingest_backend`-felt ingester identisk pre- og post-F149 (byte-for-byte wiki-output på samme input forventes; slugs kan varigere med F148-fold men ingen 404s)
- [ ] Regression: F111.2 `ingest_job_id`-stamping virker via OpenRouter-path — `documents.ingest_job_id` sat korrekt
- [ ] Regression: F148 link-checker opdager broken links uanset backend
- [ ] Regression: F140 schema-inheritance block injiceres i OpenRouter-prompten identisk med claude-cli

## Implementation Steps

1. **Fase 1a — Extract interface + ClaudeCLIBackend**: `backend.ts`, `claude-cli-backend.ts`, `runner.ts`. Flyt `spawnClaude`-logik uændret. `resolveIngestChain` returnerer single-step chain. Kør eksisterende ingests — intet ændrer sig synligt.
2. **Fase 1b — Migration 0014 + schema**: Tilføj kolonnerne. Verifikations-script kører `pragma_table_info`-probe.
3. **Fase 1c — verify-backend-claude.ts**: scripted probe. Commit fase 1 hvis grøn.
4. **Fase 2a — Faktorér `CandidateQueueAPI` ud af `apps/mcp/src/index.ts`**: flyt search/read/write-handlers til `packages/core/src/ingest/candidate-api.ts`. Både MCP-server OG OpenRouterBackend importerer herfra. Sandhed ét sted.
5. **Fase 2b — OpenRouterBackend (in-process)**: port model-lab's `openrouter.ts` + `runner.ts` + `two-pass.ts` + `tools.ts`. Tool-call-loop kalder `CandidateQueueAPI` direkte (ikke MCP). Kør ingest af F149-plan-doc'en mod development-tester-KB → valide Neuroner uden manual intervention.
6. **Fase 2c — Chain + runWithFallback**: default-chains + fallback-loop. Tilføj `model_trail`-persistens på `ingest_jobs`.
7. **Fase 2d — trial-fallback scripts**: mock 429 + context-limit. Assert chain fortsætter korrekt.
8. **Fase 2e — tenant_secrets + libsodium encryption**: `crypto_secretbox` seal/unseal. Migration inkluderet. Round-trip-test.
9. **Fase 2f — seed-dev-tenant.ts**: SQL-baseret skjult dev-tenant med `tenant_secrets`-row til test af per-tenant-key-fallback.
10. **Fase 2g — verify-ingest-models.ts (CI model-registry-check)**: kalder OpenRouter's + Anthropic's `/models`-endpoints og asserterer at alle whitelist-IDs eksisterer. Kører i pre-commit hook + CI.
11. **Fase 2h — Per-KB settings routes**: `ingest-settings.ts` + `ingest-models.ts`. Runtime-dropdown-UI er F152.
12. **Fase 2i — rotate-secrets-key.ts**: bootstrap-kommando til key-rotation. Dekryptér med gammel + encryptér med ny.
13. **Rollout verification**: kør smoke-test-suite mod development-tester-KB, rapportér success-criteria-tal, commit.

## Dependencies

- **F06 Ingest Pipeline** — nuværende ingest-pipeline er det F149 refactorer.
- **F111.2 Ingest job id stamping** — F149's OpenRouter-path skal bevare MCP-env-forwarding så stamping virker.
- **F137 Typed Edges** — kompil-prompten (F148) skal være identisk på tværs af backends for at edge-types udfyldes ens.
- **F140 Hierarchical Schemas** — schema-block skal inject'es i OpenRouter-prompt identisk med claude-cli.
- **F143 Persistent Ingest Queue** — F149 arver kø-semantikken; én job ad gangen pr. KB uanset backend.
- **F148 Link Integrity** — link-checker skal virke uanset backend; test i regression.
- **Model-lab** (`apps/model-lab/src/server/`) — kildekoden vi løfter OpenRouter-pathet fra.

## Open Questions

**Afklaret af Christian 2026-04-24:**

1. ✅ **Kryptering af tenant_secrets**: libsodium `crypto_secretbox` (markedsstandard, auditeret). Master-key via env `TRAIL_SECRETS_MASTER_KEY` (32 bytes base64).
2. ✅ **Max Plan cost reporting**: `cost_cents=0 && backend='claude-cli'` rendres som "gratis (Max)"-badge. Aldrig estimér.
3. ✅ **Model-navne i whitelist**: CI-check `scripts/verify-ingest-models.ts` kalder OpenRouter + Anthropic `/models`-endpoints og bekræfter whitelist-IDs. Kører i pre-commit + CI. Fejler byggen hvis stale. Tilføjet som Implementation Step 10.
4. ✅ **Bootstrap-migration for key-rotation**: `apps/server/scripts/rotate-secrets-key.ts` dekrypterer alle `tenant_secrets`-rækker med gammel key + encrypter med ny. Kørt én-gang ved deploy efter key-rotation. Ingen runtime-rotation i v1.

Ingen åbne spørgsmål — F149 klar til implementation.

## Related Features

- **Depends on:** F06, F111.2, F137, F140, F143, F148.
- **Enables:** **F151** (Cost & Quality Dashboard — UI ovenpå `cost_cents` + `model_trail`), **F152** (Runtime Model Switcher UI — dropdown ovenpå `resolveIngestChain`).
- **Supports:** F43 (Stripe Billing) + F44 (Usage Metering) via `cost_cents`-data; F52 (FysioDK onboarding) som kan få egen Flash-default-model uden at røre Sanne's setup.
- **Spawned by:** model-lab-eksperiment rapport (`apps/model-lab/data/REPORT.md`), `~/Downloads/MODEL-LAB-NEURON-LINK-QUALITY-RAPPORT.md`, `~/Downloads/PROMPT-TO-OPUS.md`.

## Effort Estimate

**Large** — 5–7 dage.

- Fase 1 (interface + Claude CLI extraction + migration): 1–2 dage.
- Fase 2 (OpenRouter port + chain + fallback + per-tenant + per-KB): 3–4 dage.
- Verifikation + fase-commits + rollout: 1 dag.

Buffer en halv dag til tenant_secrets-krypterings-detaljer (biblioteksvalg + master-key-handling).
