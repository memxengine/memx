# F129 — CMS Connector Registry Entries

> Tilføj `cms:webhouse` som **live** connector + roadmap-stubs for `cms:storyblok`, `cms:sanity`, `cms:contentful`, `cms:strapi`, `cms:custom` i `packages/shared/src/connectors.ts`. Gør F95 Queue-filter + Neuron-attribution klar til multi-CMS-landskabet. Tier: infrastruktur/marketing. Effort: 0.25 day.

## Problem

Vores connector-registry har p.t. `mcp:claude-code`, `mcp:cursor`, `buddy`, `chat`, etc. — men ingen CMS-kategori. F95 attribution viser hvordan candidates er skabt, men CMS-sourcede candidates ville i dag bare vise `api` som generisk fallback.

## Secondary Pain Points

- Admin Queue-filter kan ikke filtrere på CMS-sourcede candidates
- Neuron-attribution mangler granularitet for CMS-imports
- Marketing/roadmap-siden kan ikke vise "coming soon" CMS-integrationer

## Solution

Udvid `packages/shared/src/connectors.ts`:

```ts
// Live
{ id: 'cms:webhouse', label: { en: 'Webhouse CMS', da: 'Webhouse CMS' }, kind: 'cms', status: 'live' }

// Roadmap — synlige i admin's "coming soon" liste
{ id: 'cms:storyblok', kind: 'cms', status: 'roadmap', label: { en: 'Storyblok' } }
{ id: 'cms:sanity', kind: 'cms', status: 'roadmap', label: { en: 'Sanity' } }
{ id: 'cms:contentful', kind: 'cms', status: 'roadmap', label: { en: 'Contentful' } }
{ id: 'cms:strapi', kind: 'cms', status: 'roadmap', label: { en: 'Strapi' } }
{ id: 'cms:custom', kind: 'cms', status: 'roadmap', label: { en: 'Custom CMS (Generic)' } }
```

Tilføj også `kind: 'cms'` som ny `ConnectorKind` enum-værdi (udover nuværende `mcp | bearer | chat | lint | curator | api`).

## Non-Goals

- Implementere faktiske CMS-integrationer (Storyblok, Sanity, etc.) — kun registry entries
- Ændre på eksisterende connector-logic — kun udvidelse af data
- Tilføje CMS-specifikke felter til connector-skemaet

## Technical Design

### ConnectorKind enum

```typescript
// packages/shared/src/connectors.ts
export type ConnectorKind = 'mcp' | 'bearer' | 'chat' | 'lint' | 'curator' | 'api' | 'cms' | 'upload';
```

### Registry entry shape

```typescript
interface ConnectorEntry {
  id: string;
  label: { en: string; da?: string };
  kind: ConnectorKind;
  status: 'live' | 'roadmap';
  icon?: string; // optional, for UI rendering
}
```

### Admin Queue filter

F95's Queue-filter grupperer automatisk på `kind`, så alle `cms:*` entries vises under en "CMS" kategori-header. Roadmap-entries vises med "coming soon"-badge.

## Interface

### Internal only — no public API

Connectors er et internt registry konsumere af:
- F95 Queue UI (filter dropdown)
- Neuron attribution badge ("Created via Webhouse CMS")
- Admin connector-listing side

## Rollout

**Single-phase deploy.** Ren registry-edit — ingen migration, ingen runtime-ændringer.

## Success Criteria

- `cms:webhouse` vises som live + brugbar i Queue-filter
- Roadmap-entries vises i admin's connector-listing med "coming soon"-badge
- Nye CMS-integrationer tilføjes som én-linje-entry i registry + markup af status: roadmap → live

## Impact Analysis

### Files created (new)
None — only modifications to existing file.

### Files modified
- `packages/shared/src/connectors.ts` — add CMS connector entries + `cms` to ConnectorKind

### Downstream dependents
`packages/shared/src/connectors.ts` is imported by 3 files:
- `apps/server/src/routes/queue.ts` (1 ref) — uses CONNECTORS for filter dropdown, unaffected (additive)
- `apps/admin/src/components/connector-badge.tsx` (1 ref) — renders connector attribution, unaffected (additive)
- `packages/core/src/queue/candidates.ts` (1 ref) — stamps connector metadata, unaffected (additive)

### Blast radius

Minimal. Ren data-tilføjelse til et registry. Ingen eksisterende connector-logic ændres.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] `cms:webhouse` entry exists i CONNECTORS array med `status: 'live'`
- [ ] `cms:storyblok` entry exists med `status: 'roadmap'`
- [ ] Queue-filter dropdown viser "CMS" som kategori
- [ ] Neuron attribution viser "Created via Webhouse CMS" for cms:webhouse-sourcede candidates
- [ ] Regression: eksisterende connectors (mcp:claude-code, buddy, etc.) vises stadig korrekt

## Implementation Steps

1. Tilføj `cms` til `ConnectorKind` type i `packages/shared/src/connectors.ts`.
2. Tilføj `cms:webhouse` entry med `status: 'live'`.
3. Tilføj roadmap-stubs for `cms:storyblok`, `cms:sanity`, `cms:contentful`, `cms:strapi`, `cms:custom`.
4. Verificer at Queue-filter og attribution-badge renderer korrekt.

## Dependencies

- F95 (connectors-system — already live)
- F124 (content-sync aktivt produktliv for cms:webhouse)

## Open Questions

None — all decisions made.

## Related Features

- **F95** — Connectors (ingestion attribution) — systemet der bruger registry'et
- **F124** — CMS→Trail content-sync — primær use case for cms:webhouse
- **F127** — CMS Integration SDK — fremtidig consumer af cms:webhouse

## Effort Estimate

**Small** — 0.25 day. Ren registry-edit, ingen ny logik.
