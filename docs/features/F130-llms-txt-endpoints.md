# F130 — llms.txt + llms-full.txt Authenticated Endpoints

*Planned. Tier: alle (authenticated). Effort: 1 day.*

> Trail eksponerer `GET /api/v1/knowledge-bases/:kbId/llms.txt` + `.../llms-full.txt` (bearer-auth) som markdown-formaterede aggregates af hele KB'en — index + fuld-korpus. Brugbar for cc/Cursor/Windsurf-agenter der skal pipe en Trail-KB ind i LLM-context uden at loope individuelle API-kald.

## Problem

Når en cc-session i et eksternt repo skal konsultere en Trail-KB, skal den i dag lave N individuelle `read`-kald via MCP-protokollen. For en 300-Neuron KB er det slow + tokens-spild. llms.txt-spec'en (llmstxt.org, 2024/2025) er blevet de facto standard for at servere LLM-venlig dokumentation i én fetch.

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

## How

- Ny route-fil `apps/server/src/routes/llms-txt.ts`
- Genereres on-demand (kan ikke cache globalt fordi tenant-scoped)
- Sortering: type-grupper (concepts, entities, sources, synthesis, comparisons, analyses, glossary)
- Indhold udelukker Neurons med F131 `public_visibility = 'hidden'`
- Trail's egne docs (under `docs/`) eksponeres via en separat Trail-KB "trail-development" → eget llms.txt-endpoint som cc-sessioner kan curle

## Dependencies

- F101 (type-frontmatter — grupperingen er type-baseret)
- F131 (public_visibility column — hidden-Neurons ekskluderes)

## Success criteria

- `curl -H "Authorization: ..." trail.broberg.dk/api/v1/.../llms.txt` returnerer valid markdown
- Indholdet respekterer visibility-flags
- 300-Neuron KB genererer llms-full.txt på ~100ms (indexed lookup, ingen LLM-kald)
- Trail-development-KB's egen llms.txt er tilgængelig for cc-sessioner via .mcp.json-konfigureret token
