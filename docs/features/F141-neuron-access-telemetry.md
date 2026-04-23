# F141 — Neuron Access Telemetry + Usage Weighting

> Tracking af hvilke Neuroner der bliver læst mest — via chat, API, MCP-read, admin-view — og brug af det signal til at vægte graph-noder, rangere search-resultater og synliggøre "hot topics" i en KB. Hjernen bruger nogle centre mere end andre; Neuroner er ikke anderledes. Usage-weighting afslører strukturen af tænkning i en KB på en måde compile-struktur alene ikke kan. Tier: alle (opt-in per KB). Effort: 1.5-2 days. Status: Planned.

## Problem

En KB med 300 Neuroner ser i admin UI ud som én stor flad liste — alle lige vægtede. Men i praksis bliver 20 af dem læst 80% af tiden. Trail har ingen måde at vide hvilke 20.

Konsekvenser:
- **F99 graph** render alle noder lige store → brugeren mister visuel signal om hvor hjertet af KB'en ligger
- **Search-rangering** sorterer efter nyeste eller BM25-score, ikke faktisk brugs-signal
- **Chat-kontekst-udvælgelse** (F89) vælger relevant-Neurons via FTS5 similarity — men en sjældent læst Neuron der lige matcher keywords scorer lige så højt som den der faktisk ER KB'ens referencepunkt
- **F139 heuristic-decay** bruger `last_touched` (redigering); men "bruges sjældent" er ikke det samme som "redigeres sjældent" — en core-heuristic kan være uforandret i 2 år mens den læses dagligt
- **Business/research-indsigt** — Christians spørgsmål: "hvad skyldes det at vi bruger nogle centre mere?". En researcher kan opdage hul i sit eget tankemønster ved at se hvilke Neuroner der ALDRIG bliver tilgået på trods af at være oprettet

Usage-signal er ortogonalt til alle eksisterende vægtnings-akser (recency, tags, connector, confidence) og komplementerer dem.

## Secondary Pain Points

- Ingen måde at identificere "cold" Neuroner (0 reads/90d) der måske skal arkiveres
- Ingen kvantificering af KB'ens "aktivitet" over tid
- Token/cost visibility per-Neuron mangler

## Solution

Tilføj letvægts-read-tracking på hver Neuron-adgang:

```sql
CREATE TABLE document_access (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  knowledge_base_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'chat' | 'api' | 'mcp' | 'admin-reader' | 'graph-click'
  actor_kind TEXT NOT NULL,       -- 'user' | 'llm' | 'system'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_access_doc ON document_access(document_id, created_at);
CREATE INDEX idx_access_kb_recent ON document_access(knowledge_base_id, created_at);
```

Én række per read — write-heavy men append-only, ingen indexes på frem for de to nødvendige. For en 300-Neuron KB med 500 reads/dag er det 180k rækker/år — trivielt for SQLite.

**Aggregat-tier:** En materialized `document_access_rollup` der opdateres nightly (del af F32 lint-scheduler's dreaming-pass):

```sql
CREATE TABLE document_access_rollup (
  document_id TEXT PRIMARY KEY,
  reads_7d INTEGER DEFAULT 0,
  reads_30d INTEGER DEFAULT 0,
  reads_90d INTEGER DEFAULT 0,
  reads_total INTEGER DEFAULT 0,
  last_read_at TEXT,
  usage_weight REAL DEFAULT 0,    -- normalised 0-1 for UI vægtning
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
```

`usage_weight` normaliseres per-KB så en 300-Neuron KB's hotteste og en 30-Neuron KB's hotteste begge giver `1.0` — sammenligning på tværs af KBs er ikke meningsfuld, kun inden for.

**Consumers af signal:**
- F99 graph-API: node-radius skaleres med `usage_weight` (min 0.5× → max 2.0×)
- Search-resultat-sort: tie-breaker mellem lige BM25-scores er `usage_weight`
- Chat-kontekst (F89): vægtning `final_score = bm25_score × (0.7 + 0.3 × usage_weight)` — ikke dominans, bare lille bias mod faktisk-brugte
- Admin "Insights"-panel (ny, under /kb/:kbId/insights): topp-20 mest læste Neuroner, bottom-20 aldrig-læste, reads-over-time graph
- F139 heuristic-decay udvidet: `last_touched = max(last_edited, last_read)` — en heuristic der læses dagligt dør ikke fordi den ikke redigeres

## Non-Goals

- Real-time analytics dashboard — nightly rollup er tilstrækkeligt
- Per-user access tracking — kun per-Neuron aggregat, ikke hvem læste hvad
- Export af access data til eksterne systemer

## Technical Design

### Access Tracker

```typescript
// apps/server/src/services/access-tracker.ts
export async function recordAccess(
  db: Database,
  opts: { documentId: string; source: string; actorKind: string },
): Promise<void> {
  // Fire-and-forget insert, no blocking
  await db.insert(documentAccess).values({
    id: generateId(),
    documentId: opts.documentId,
    source: opts.source,
    actorKind: opts.actorKind,
    createdAt: new Date().toISOString(),
  });
}
```

### Nightly Rollup

```typescript
// apps/server/src/services/access-rollup.ts
export async function runAccessRollup(db: Database): Promise<void> {
  // SQL: aggregate document_access into document_access_rollup
  // Compute usage_weight per KB (normalize 0-1)
}
```

### Call Sites

- `routes/documents.ts` GET /documents/:id/content — source='api' eller 'admin-reader'
- `routes/chat.ts` — per Neuron chat brugte til kontekst, source='chat'
- `apps/mcp/src/index.ts` — MCP read-tool → source='mcp'
- F99 graph-click (admin) → source='graph-click'

## Interface

### Insights API

```
GET /api/v1/knowledge-bases/:kbId/insights
→ {
    top20: [{ documentId, title, reads_7d, usage_weight }],
    bottom20: [{ documentId, title, reads_90d }],
    readsOverTime: [{ date, count }]
  }
```

### Privacy / Opt-Out

- Per-KB toggle `settings.trail.trackAccess` (default ON for owner-only KBs, OFF for multi-tenant)
- Actor-kind `llm` (kompiler-reads) tælles IKKE som usage
- Rollup er aggregat-only — individuelle read-rækker ældre end 180 dage kan auto-purges

## Rollout

**Phased:**
1. Migration + access-tracker + call sites
2. Nightly rollup + F99 graph weighting
3. Insights panel UI

## Success Criteria

- Sannes KB har topp-10-leaderboard efter 7 dages brug: "mest læste Neuroner denne uge"
- F99 graph viser signifikant størrelse-forskel mellem hotteste og koldeste nodes
- Search rangerer hotte Neuroner højere når BM25-scoren er tæt på identisk
- Chat vælger hot Neuroner fremfor cold når begge matcher et keyword lige godt (testbart via A/B på samme query)
- Insights-panel viser reads-over-time graf
- Access-rækker øger DB-størrelse med <5% over 1 år på en moderat-aktiv KB

## Impact Analysis

### Files created (new)
- `apps/server/src/services/access-tracker.ts`
- `apps/server/src/services/access-rollup.ts`
- `apps/server/src/routes/insights.ts`
- `apps/admin/src/panels/insights.tsx`
- Migration fil i `packages/db/drizzle/migrations/`

### Files modified
- `packages/db/src/schema.ts` (add `documentAccess` + `documentAccessRollup` tables)
- `apps/server/src/routes/documents.ts` (call recordAccess on read)
- `apps/server/src/routes/chat.ts` (call recordAccess per Neuron used in context)
- `apps/mcp/src/index.ts` (call recordAccess on MCP read)
- `apps/server/src/routes/graph.ts` (return usage_weight for nodes)
- `apps/admin/src/components/graph.tsx` (scale node radius by usage_weight)
- `apps/server/src/services/search.ts` (use usage_weight as tie-breaker)
- `apps/server/src/services/lint-scheduler.ts` (piggyback access-rollup on nightly pass)

### Downstream dependents
`apps/server/src/services/access-tracker.ts` — New file, no dependents yet.

`apps/server/src/routes/documents.ts` is imported by 3 files:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected
- `apps/server/src/routes/health.ts` (1 ref) — imports for health check, unaffected
- `apps/admin/src/api.ts` (1 ref) — calls document endpoints, unaffected

`apps/server/src/routes/chat.ts` is imported by 2 files:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected
- `apps/admin/src/api.ts` (1 ref) — calls chat endpoint, unaffected

`apps/server/src/services/search.ts` is imported by 4 files:
- `apps/server/src/routes/search.ts` (1 ref) — uses search, picks up tie-breaker automatically
- `apps/server/src/services/chat.ts` (1 ref) — builds context, picks up tie-breaker
- `apps/server/src/services/ingest.ts` (1 ref) — uses for dedup, unaffected
- `apps/admin/src/api.ts` (1 ref) — calls search, unaffected

### Blast radius
- Medium — access tracking adds write load on every read
- Append-only table kan vokse hurtigt — 180-dage purge er nødvendig
- Edge case: high-traffic KB med 5000+ reads/dag → access-tracker skal være fire-and-forget (ikke blokere)
- Privacy: multi-tenant KBs skal have tracking OFF som default

### Breaking changes
None — all changes are additive.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Migration kører og opretter document_access + document_access_rollup
- [ ] GET /documents/:id → row i document_access
- [ ] Chat request → rows i document_access for hver Neuron i context
- [ ] Nightly rollup beregner usage_weight korrekt
- [ ] F99 graph viser node-størrelse forskel baseret på usage_weight
- [ ] Search tie-breaker bruger usage_weight
- [ ] Insights panel viser top-20 / bottom-20 / reads-over-time
- [ ] Regression: read performance ikke degraderet af access tracking

## Implementation Steps
1. Migration: opret document_access + document_access_rollup tabeller
2. Implementér access-tracker service (fire-and-forget insert)
3. Tilføj call sites: documents.ts, chat.ts, MCP read, graph-click
4. Implementér nightly rollup aggregator
5. Integrér rollup i F32 lint-scheduler
6. Opdater graph API + rendering med usage_weight
7. Opdater search med usage_weight tie-breaker
8. Implementér insights API endpoint
9. Byg insights panel UI (top-20, bottom-20, reads-over-time)
10. Tilføj per-KB trackAccess toggle
11. Typecheck + test plan

## Dependencies
- F89 (chat-endpoint — primær source for LLM-vægtet read-tracking)
- F99 (graph — node-størrelses-vægtning)
- F32 (lint-scheduler — rollup piggybacker på nightly pass)

## Open Questions
None — all decisions made.

## Related Features
- **F89** (Chat tools) — chat context selection bruger usage_weight
- **F99** (Neuron graph) — node radius skaleres med usage_weight
- **F32** (Lint scheduler) — nightly rollup
- **F139** (Heuristic decay) — last_touched = max(last_edited, last_read)
- **F121** (Per-tenant LLM budget) — token cost per-Neuron

## Effort Estimate
**Medium** — 1.5-2 days
- 0.3 day: migration + access-tracker
- 0.3 day: call sites integration
- 0.3 day: nightly rollup
- 0.3 day: graph + search weighting
- 0.3 day: insights panel UI
- 0.2 day: testing
