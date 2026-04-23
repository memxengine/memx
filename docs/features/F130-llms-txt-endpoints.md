# F130 — llms.txt + llms-full.txt Authenticated Endpoints

> Trail eksponerer `GET /api/v1/knowledge-bases/:kbId/llms.txt` + `.../llms-full.txt` (bearer-auth) som markdown-formaterede aggregates af hele KB'en — index + fuld-korpus. Brugbar for cc/Cursor/Windsurf-agenter der skal pipe en Trail-KB ind i LLM-context uden at loope individuelle API-kald. Tier: alle (authenticated). Effort: 1 day.

## Problem

Når en cc-session i et eksternt repo skal konsultere en Trail-KB, skal den i dag lave N individuelle `read`-kald via MCP-protokollen. For en 300-Neuron KB er det slow + tokens-spild. llms.txt-spec'en (llmstxt.org, 2024/2025) er blevet de facto standard for at servere LLM-venlig dokumentation i én fetch.

## Secondary Pain Points

- Ingen måde at eksportere en hel KB som LLM-venlig markdown
- Cursor/Cursor rules / Windsurf context files kræver manuel copy-paste
- Onboarding af nye cc-sessions til et projekt er langsom uden samlet KB-dump

## Solution

Ny endpoints:

```
GET /api/v1/knowledge-bases/:kbId/llms.txt
Authorization: Bearer <token>

# Returnerer markdown-index:
# <KB-navn>
> <kb.description>

## Concepts
- [<title>](<public-url-eller-slug>): <first paragraph>

## Entities
- ...

## Sources
- ...
```

```
GET /api/v1/knowledge-bases/:kbId/llms-full.txt
Authorization: Bearer <token>

# Returnerer hele korpussen concateneret:
## <Neuron-1 title>
_Path: /neurons/.../  Type: concept_

<body>
---
## <Neuron-2 title>
...
```

Cache-Control: `private, max-age=300` (5 min) så CDN/proxy cacher mellem requests.

## Non-Goals

- Public access — endpoints kræver bearer-auth
- Real-time streaming — genereres on-demand, ikke SSE
- Inkludere hidden Neurons (F131) — respekterer visibility-flags
- Erstatte MCP `read` tool — komplementerer det for bulk-context

## Technical Design

### Route handler

```typescript
// apps/server/src/routes/llms-txt.ts
import { Hono } from 'hono';
import { documents, knowledgeBases, type TrailDatabase } from '@trail/db';
import { eq, and } from 'drizzle-orm';

export const llmsTxtRoutes = new Hono();

llmsTxtRoutes.get('/knowledge-bases/:kbId/llms.txt', async (c) => {
  const kb = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, c.req.param('kbId'))).get();
  const neurons = await db.select()
    .from(documents)
    .where(and(
      eq(documents.knowledgeBaseId, c.req.param('kbId')),
      eq(documents.kind, 'wiki'),
      // F131: exclude hidden
    ))
    .orderBy(documents.path, documents.filename);

  const index = renderIndex(kb, neurons);
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', 'private, max-age=300');
  return c.text(index);
});

llmsTxtRoutes.get('/knowledge-bases/:kbId/llms-full.txt', async (c) => {
  // similar, but renders full body content
});
```

### Render functions

```typescript
function renderIndex(kb: KnowledgeBase, neurons: Document[]): string {
  const grouped = groupByType(neurons); // concepts, entities, sources, synthesis, etc.
  return `# ${kb.name}\n> ${kb.description}\n\n${Object.entries(grouped).map(([type, items]) =>
    `## ${capitalize(type)}\n${items.map(n => `- [${n.title}](/${n.path}/${n.filename}): ${excerpt(n.content)}`).join('\n')}`
  ).join('\n\n')}`;
}

function renderFull(neurons: Document[]): string {
  return neurons.map(n =>
    `## ${n.title}\n_Path: /${n.path}/  Type: ${n.type}_\n\n${n.content}`
  ).join('\n---\n');
}
```

### Sorting

Sortering: type-grupper (concepts, entities, sources, synthesis, comparisons, analyses, glossary) — baseret på F101 type-frontmatter.

## Interface

### GET /api/v1/knowledge-bases/:kbId/llms.txt

**Auth:** Bearer token (tenant member)
**Response:** `text/plain` — markdown index
**Headers:** `Cache-Control: private, max-age=300`

### GET /api/v1/knowledge-bases/:kbId/llms-full.txt

**Auth:** Bearer token (tenant member)
**Response:** `text/plain` — full markdown corpus
**Headers:** `Cache-Control: private, max-age=300`

### Exclusion rules

- Neurons med F131 `public_visibility = 'hidden'` ekskluderes
- Schema-filer (F140 `type: schema`) ekskluderes
- Work-items (F138 `kind: 'work'`) inkluderes i separat `## Work` sektion

## Rollout

**Single-phase deploy.** Nye endpoints — ingen migration nødvendig. Deploy og test med Trail's egen KB.

## Success Criteria

- `curl -H "Authorization: ..." trail.broberg.dk/api/v1/.../llms.txt` returnerer valid markdown
- Indholdet respekterer visibility-flags
- 300-Neuron KB genererer llms-full.txt på ~100ms (indexed lookup, ingen LLM-kald)
- Trail-development-KB's egen llms.txt er tilgængelig for cc-sessioner via .mcp.json-konfigureret token

## Impact Analysis

### Files created (new)
- `apps/server/src/routes/llms-txt.ts`

### Files modified
- `apps/server/src/app.ts` (mount llms.txt routes)
- `apps/server/src/routes/documents.ts` (visibility filter genbruges)

### Downstream dependents
`apps/server/src/app.ts` is imported by 4 files (4 refs):
- `apps/server/src/index.ts` (1 ref) — creates app, unaffected
- `apps/server/src/routes/auth.ts` (1 ref) — uses AppBindings type, unaffected
- `apps/server/src/routes/health.ts` (1 ref) — uses AppBindings type, unaffected
- `apps/server/src/routes/api-keys.ts` (1 ref) — uses AppBindings type, unaffected

`apps/server/src/routes/documents.ts` is imported by 1 file:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected

### Blast radius

Low. Nye read-only endpoints. Ingen eksisterende routes eller datastrukturer ændres.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] `GET /llms.txt` med gyldig auth → 200, valid markdown med KB navn + neuron liste
- [ ] `GET /llms-full.txt` med gyldig auth → 200, fuld korpus med frontmatter
- [ ] Hidden Neuron (F131) ekskluderes fra begge endpoints
- [ ] Uden auth → 401 Unauthorized
- [ ] Cache-Control header er `private, max-age=300`
- [ ] 300-Neuron KB: response time < 200ms
- [ ] Regression: eksisterende document-read endpoints fungerer uændret

## Implementation Steps

1. Opret `apps/server/src/routes/llms-txt.ts` med `renderIndex` + `renderFull` helpers.
2. Implementer `GET /knowledge-bases/:kbId/llms.txt` endpoint.
3. Implementer `GET /knowledge-bases/:kbId/llms-full.txt` endpoint.
4. Mount routes i `apps/server/src/app.ts`.
5. Tilføj visibility-filter (F131 `public_visibility != 'hidden'`).
6. Test med Trail's egen KB → verificer markdown output.

## Dependencies

- F101 (type-frontmatter — grupperingen er type-baseret)
- F131 (public_visibility column — hidden-Neurons ekskluderes)

## Open Questions

None — all decisions made.

## Related Features

- **F101** — Type frontmatter (type-gruppering i llms.txt)
- **F131** — Public visibility column (filtrering af hidden Neurons)
- **F138** — Work layer (Work-items inkluderes i separat sektion)
- **F140** — Hierarchical context inheritance (schema-filer ekskluderes)

## Effort Estimate

**Small** — 1 day.
- 0.5 day: route handlers + render functions
- 0.25 day: visibility filter integration
- 0.25 day: testing + Trail's egen KB verification
