# F141 — Neuron Access Telemetry + Usage Weighting

*Planned. Tier: alle (opt-in per KB). Effort: 1.5-2 days.*

> Tracking af hvilke Neuroner der bliver læst mest — via chat, API, MCP-read, admin-view — og brug af det signal til at vægte graph-noder, rangere search-resultater og synliggøre "hot topics" i en KB. Hjernen bruger nogle centre mere end andre; Neuroner er ikke anderledes. Usage-weighting afslører strukturen af tænkning i en KB på en måde compile-struktur alene ikke kan.

## Problem

En KB med 300 Neuroner ser i admin UI ud som én stor flad liste — alle lige vægtede. Men i praksis bliver 20 af dem læst 80% af tiden. Trail har ingen måde at vide hvilke 20.

Konsekvenser:
- **F99 graph** render alle noder lige store → brugeren mister visuel signal om hvor hjertet af KB'en ligger
- **Search-rangering** sorterer efter nyeste eller BM25-score, ikke faktisk brugs-signal
- **Chat-kontekst-udvælgelse** (F89) vælger relevant-Neurons via FTS5 similarity — men en sjældent læst Neuron der lige matcher keywords scorer lige så højt som den der faktisk ER KB'ens referencepunkt
- **F139 heuristic-decay** bruger `last_touched` (redigering); men "bruges sjældent" er ikke det samme som "redigeres sjældent" — en core-heuristic kan være uforandret i 2 år mens den læses dagligt
- **Business/research-indsigt** — Christians spørgsmål: "hvad skyldes det at vi bruger nogle centre mere?". En researcher kan opdage hul i sit eget tankemønster ved at se hvilke Neuroner der ALDRIG bliver tilgået på trods af at være oprettet

Usage-signal er ortogonalt til alle eksisterende vægtnings-akser (recency, tags, connector, confidence) og komplementerer dem.

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
- Admin "Insights"-panel (ny, under /kb/:kbId/insights): topp-20 mest læste Neuroner, bottom-20 aldrig-læste, reads-over-time graph (research-værdien Christian peger på)
- F139 heuristic-decay udvidet: `last_touched = max(last_edited, last_read)` — en heuristic der læses dagligt dør ikke fordi den ikke redigeres

## How

- `packages/db/src/schema.ts` — `documentAccess` + `documentAccessRollup` tabeller
- `apps/server/src/services/access-tracker.ts` (ny) — `recordAccess(trail, { documentId, source, actor })`-helper der inserts uden at blokere request
- Call sites:
  - `routes/documents.ts` GET /documents/:id/content — source='api' eller 'admin-reader' afhængig af Accept-header
  - `routes/chat.ts` — per Neuron chat brugte til kontekst, source='chat'
  - `apps/mcp/src/index.ts` — MCP read-tool → source='mcp'
  - F99 graph-click (admin) → source='graph-click'
- `apps/server/src/services/access-rollup.ts` (ny) — nightly aggregator, kører i F32 lint-scheduler's orphans+stale-pass (billigt SQL, ingen LLM)
- `apps/server/src/routes/insights.ts` (ny) — admin-endpoint til stats (topp-20 læste, reads-over-time)
- `apps/admin/src/panels/insights.tsx` (ny) — visualiserer rollup: bar-chart over topp-20 Neuroner + heatmap over reads/uge + liste af "cold" Neuroner (0 reads/90d)

**Privacy / opt-out:**
- Per-KB toggle `settings.trail.trackAccess` (default ON for owner-only KBs, OFF for multi-tenant). Ved OFF ingen indsatser i `document_access`
- Actor-kind `llm` (kompiler-reads) tælles IKKE som usage (ville skævvride aggregatet — compiler rører alle Neuroner under ingest)
- Rollup er aggregat-only — individuelle read-rækker ældre end 180 dage kan auto-purges for at holde tabellen på rimelig størrelse

## Dependencies

- F89 (chat-endpoint — primær source for LLM-vægtet read-tracking)
- F99 (graph — node-størrelses-vægtning)
- F32 (lint-scheduler — rollup piggybacker på nightly pass)

## Success criteria

- Sannes KB har topp-10-leaderboard efter 7 dages brug: "mest læste Neuroner denne uge"
- F99 graph viser signifikant størrelse-forskel mellem hotteste og koldeste nodes
- Search rangerer hotte Neuroner højere når BM25-scoren er tæt på identisk
- Chat vælger hot Neuroner fremfor cold når begge matcher et keyword lige godt (testbart via A/B på samme query)
- Insights-panel viser reads-over-time graf: research-indsigten Christian beder om — "hvilke centre bruges mere, og hvad skyldes det?"
- Access-rækker øger DB-størrelse med <5% over 1 år på en moderat-aktiv KB
