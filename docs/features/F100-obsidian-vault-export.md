# F100 — Obsidian Vault Export

*Planned. Tier: Starter+. Effort: 2-3 hours.*

> En Trail-bruger klikker "Eksporter til Obsidian" og får en ZIP-fil med hele sin KB pakket som en pre-konfigureret Obsidian-vault — `raw/`, `wiki/`, `.obsidian/` med graph-view-farver + hotkeys + sidebar-layout. Dobbeltklik → Obsidian åbner → alt er klar til at browse lokalt.

## Problem

Trail lagrer Neurons i SQLite. Brugere der vil se deres data som filer — for backup, offline-browsing, eller migrering til Obsidian — har i dag ingen vej ud. Det signalerer vendor-lock-in og er en direkte kritik Karpathy's setup (rene markdown-filer) kaster på hostede løsninger som vores.

## Solution

Ny endpoint `GET /api/v1/knowledge-bases/:kbId/export/obsidian` der streamer en ZIP indeholdende:

```
<kbName>-export-<YYYY-MM-DD>.zip
├── raw/<source>.md                  alle kind='source' docs
├── wiki/<path>/<slug>.md            alle kind='wiki' Neurons med [[backlinks]]
├── wiki/index.md                    fra overview.md + genereret katalog
├── wiki/log.md                      fra eksisterende log.md
├── wiki/glossary.md                 fra F102 eller glossary.json seed
├── .obsidian/                       copy fra Balu's template (CC-licens verificeret)
│   ├── app.json, appearance.json, core-plugins.json
│   ├── graph.json, hotkeys.json, workspace.json
├── CLAUDE.md                        Trail's ingest-prompt som kontekst til LLM-agent
└── README.md                        attribution + kom-i-gang-guide
```

## How

- Template-filer committes under `apps/server/src/templates/obsidian-vault/` (engangs-copy fra balukosuri/llm-wiki-karpathy med attribution)
- Endpoint bygger ZIP via streaming (ingen buffer-hele-filen-i-memory)
- YAML-frontmatter genereres med F101's `type:`-felt så Dataview-plugin virker
- Wiki-links `[[slug]]` renders uændret (Obsidian matcher direkte på filnavn)

## Dependencies

- F101 (type-frontmatter for Dataview-compat)
- F102 (glossary-Neuron) — nice-to-have, ellers seed fra glossary.json

## Success criteria

- ZIP åbner direkte i Obsidian som vault — graph-view viser Neurons med farver per type
- Hotkeys virker ud af boksen
- Ingen brudte wiki-links mellem Neurons
- Eksport af 1.000 Neurons tager <10 sekunder
