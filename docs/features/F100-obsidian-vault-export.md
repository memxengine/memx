# F100 — Obsidian Vault Export

> En Trail-bruger klikker "Eksporter til Obsidian" og får en ZIP-fil med hele sin KB pakket som en pre-konfigureret Obsidian-vault — `raw/`, `wiki/`, `.obsidian/` med graph-view-farver + hotkeys + sidebar-layout. Tier: Starter+. Effort: Small (2-3 hours). Status: Planned.

## Problem

Trail lagrer Neurons i SQLite. Brugere der vil se deres data som filer — for backup, offline-browsing, eller migrering til Obsidian — har i dag ingen vej ud. Det signalerer vendor-lock-in og er en direkte kritik Karpathy's setup (rene markdown-filer) kaster på hostede løsninger som vores.

## Secondary Pain Points

- No way to share a KB with collaborators who don't have Trail accounts.
- No offline access for field work (Sanne's clinic visits without WiFi).
- Backup strategy relies entirely on Trail's infrastructure — no user-controlled export.

## Solution

New endpoint `GET /api/v1/knowledge-bases/:kbId/export/obsidian` that streams a ZIP containing:

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

## Non-Goals

- Server-side PDF rendering of vault content.
- Automatic Obsidian installation or vault setup on the user's machine.
- Incremental/differential exports (always full export).
- Export of activity log, queue candidates, or other non-Neuron data.
- Support for other note-taking apps (Notion, Logseq, Bear) — Obsidian only for MVP.

## Technical Design

### Template files

Template files committed under `apps/server/src/templates/obsidian-vault/` (one-time copy from balukosuri/llm-wiki-karpathy with attribution):

```
apps/server/src/templates/obsidian-vault/
├── .obsidian/
│   ├── app.json
│   ├── appearance.json
│   ├── core-plugins.json
│   ├── graph.json
│   ├── hotkeys.json
│   └── workspace.json
├── CLAUDE.md
└── README.md
```

### Endpoint implementation

```ts
// apps/server/src/routes/export.ts
GET /api/v1/knowledge-bases/:kbId/export/obsidian

Streams ZIP via archiver (no full-buffer-in-memory):
1. Query all kind='source' documents → stream as raw/<filename>.md
2. Query all kind='wiki' documents → stream as wiki/<path>/<slug>.md
3. Generate wiki/index.md from overview.md + catalog
4. Copy wiki/log.md from existing log
5. Copy wiki/glossary.md from F102 glossary-Neuron or glossary.json seed
6. Copy .obsidian/ templates
7. Copy CLAUDE.md + README.md templates
8. Stream ZIP to response with Content-Disposition: attachment
```

### YAML frontmatter

Each exported Neuron includes `type:` field (from F101) so Obsidian's Dataview plugin works:

```yaml
---
title: Akupunktur
type: concept
tags: [tcm, needles]
sources: [Øreakupunktur_DIFZT_2025.pdf]
date: 2026-04-15
---
```

### Wiki links

Wiki-links `[[slug]]` render unchanged (Obsidian matches directly on filename).

## Interface

### Export endpoint

```
GET /api/v1/knowledge-bases/:kbId/export/obsidian
  → 200 application/zip (streaming)
  Headers: Content-Disposition: attachment; filename="<kbName>-export-<YYYY-MM-DD>.zip"
```

No request body. Auth: bearer token with KB read access.

## Rollout

**Single-phase deploy.** New endpoint, no migration needed. Template files are static. ZIP streaming handles any KB size without memory issues.

## Success Criteria

- ZIP opens directly in Obsidian as a vault — graph-view shows Neurons with colors per type.
- Hotkeys work out of the box.
- No broken wiki-links between Neurons.
- Export of 1,000 Neurons takes <10 seconds.
- ZIP file size is reasonable (<50MB for 1,000 Neurons with text content).

## Impact Analysis

### Files created (new)

- `apps/server/src/routes/export.ts`
- `apps/server/src/templates/obsidian-vault/.obsidian/app.json`
- `apps/server/src/templates/obsidian-vault/.obsidian/appearance.json`
- `apps/server/src/templates/obsidian-vault/.obsidian/core-plugins.json`
- `apps/server/src/templates/obsidian-vault/.obsidian/graph.json`
- `apps/server/src/templates/obsidian-vault/.obsidian/hotkeys.json`
- `apps/server/src/templates/obsidian-vault/.obsidian/workspace.json`
- `apps/server/src/templates/obsidian-vault/CLAUDE.md`
- `apps/server/src/templates/obsidian-vault/README.md`

### Files modified

- `apps/server/src/app.ts` (mount export route)

### Downstream dependents

`apps/server/src/app.ts` — Boot entry point that mounts all routes. Adding export route mount is additive; no downstream changes.

### Blast radius

- All changes are additive (new route, new template files).
- ZIP streaming uses `archiver` library — must verify it doesn't buffer full ZIP in memory for large KBs.
- Template files from external repo (Balu's) — must verify CC license and include attribution in README.md.
- Export endpoint is gated by auth + KB read access — no data leakage risk.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: ZIP streaming produces valid ZIP with correct file structure for a 3-Neuron test KB
- [ ] Unit: wiki/index.md generated correctly from overview.md + catalog
- [ ] Integration: export endpoint returns 200 with Content-Disposition header for a real KB
- [ ] Integration: exported ZIP opens in Obsidian without errors
- [ ] Manual: verify all wiki-links resolve in Obsidian after import
- [ ] Manual: verify graph-view shows Neurons with correct colors per type
- [ ] Regression: existing KB read endpoints unaffected by new export route
- [ ] Performance: export 1,000 Neurons in <10 seconds, memory usage <200MB

## Implementation Steps

1. Create template directory `apps/server/src/templates/obsidian-vault/` with `.obsidian/` config files, CLAUDE.md, README.md (copy from Balu's repo with CC-licens verification + attribution).
2. Implement export endpoint in `apps/server/src/routes/export.ts` using `archiver` for streaming ZIP generation.
3. Wire export route in `apps/server/src/app.ts`.
4. Add "Eksporter til Obsidian" button to admin KB settings panel.
5. Test: export a 3-Neuron test KB, open ZIP in Obsidian, verify graph-view + hotkeys + wiki-links.
6. Performance test: export 1,000 Neurons, measure time + memory.

## Dependencies

- F101 (type-frontmatter for Dataview-compat) — nice-to-have, export works without it but Dataview won't filter by type
- F102 (glossary-Neuron) — nice-to-have, otherwise seed from glossary.json

## Open Questions

1. **Template license.** Balu's repo is CC-licensed — verify exact license terms and include proper attribution in README.md.
2. **Large KB handling.** What's the practical upper limit for ZIP streaming? 10,000 Neurons? 100,000? Should we add a progress indicator for large exports?
3. **Incremental exports.** Should we support "export only changed since last export"? Probably out of scope for MVP but worth flagging.

## Related Features

- **F101** (type-frontmatter) — Dataview compatibility in exported vault
- **F102** (Auto-maintained Glossary) — glossary.md included in export
- **F107** (Marp Slide Output) — Marp files work directly in Obsidian with Marp plugin
- **F108** (Chart Generation) — charts exported as `.svg` files in `wiki/assets/`

## Effort Estimate

**Small** — 2-3 hours.

- Template files + license verification: 30 min
- Export endpoint implementation: 1 hour
- Admin UI button: 30 min
- Testing + verification: 30 min
