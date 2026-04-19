# F129 — CMS Connector Registry Entries

*Planned. Tier: infrastruktur/marketing. Effort: 0.25 day (just registry updates).*

> Tilføj `cms:webhouse` som **live** connector + roadmap-stubs for `cms:storyblok`, `cms:sanity`, `cms:contentful`, `cms:strapi`, `cms:custom` i `packages/shared/src/connectors.ts`. Gør F95 Queue-filter + Neuron-attribution klar til multi-CMS-landskabet.

## Problem

Vores connector-registry har p.t. `mcp:claude-code`, `mcp:cursor`, `buddy`, `chat`, etc. — men ingen CMS-kategori. F95 attribution viser hvordan candidates er skabt, men CMS-sourcede candidates ville i dag bare vise `api` som generisk fallback.

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

## How

- Ren registry-edit i `packages/shared/src/connectors.ts`
- Admin Queue-filter (fra F95) viser "CMS" som kategori-header der grupperer alle `cms:*`-entries
- Connector-badge UI renderer CMS-ikon for kind='cms'

## Dependencies

- F95 (connectors-system skal eksistere) ✓ allerede landet
- F124 (content-sync aktivt produktliv for cms:webhouse)

## Success criteria

- `cms:webhouse` vises som live + brugbar i Queue-filter
- Roadmap-entries vises i admin's connector-listing med "coming soon"-badge
- Nye CMS-integrationer tilføjes som én-linje-entry i registry + markup af status: roadmap → live
