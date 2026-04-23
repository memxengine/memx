# F115 — Trail "Idea File" as Public Shareable Gist

> Tier: infrastruktur/marketing. Effort: 0.5 day. Planned.

## Problem

Karpathy's gist er viral fordi den er **copy-paste-able i en hvilken som helst LLM-agent**. Vi har vores CLAUDE.md checked in i repo'en men ikke som standalone public gist. Det betyder:

1. Andre udviklere kan ikke nemt "kopiere mønsteret" fra os — de skal clone hele repo'et
2. SEO-potentiale på "Karpathy-style knowledge base"-søgninger er ikke realiseret
3. Intellektuel positionering (vi er "Karpathy-pattern-implementation") er implicit, ikke eksplicit

## Secondary Pain Points

- Ingen "mini-Trail" reference for eksterne cc-sessioner at kopiere
- CLAUDE.md er repo-specifik — ikke discoverable uden at kende repo'et
- Manglende cross-reference mellem gist og trail.broberg.dk landing page

## Solution

Publicér `docs/TRAIL-SCHEMA-GIST.md` som en offentlig GitHub gist fra Christians account. Link til gist'en fra trail.broberg.dk forside ("Our architecture, in one file"). Gist'en er strukturmæssigt en udvidet version af Karpathy's med Trail's tre-lag-arkitektur (raw / wiki / schema), curation queue, contradiction-lint, connector-attribution, og multi-tenant support.

## Non-Goals

- Automated gist publishing via API (manual publication only — no token management needed)
- Interactive demo or sandbox — gist is static markdown
- Versioning the gist over time (publish once, update manually when architecture changes)
- Gist as a dependency for any Trail runtime code

## Technical Design

### Gist Content Structure

```markdown
# Trail — Karpathy-style LLM Wiki Architecture

## Three-Layer Architecture
- Raw layer: source documents (PDF, markdown, web clips)
- Wiki layer: LLM-compiled Neurons (markdown with [[wiki-links]])
- Schema layer: typed metadata (connector attribution, version, tags)

## Curation Queue
All wiki writes flow through a queue with auto-approve + manual review.

## Contradiction Detection
Lint-style semantic contradiction detection between Neurons.

## Connector Attribution
Every Neuron tracks which connector created it (upload, chat, MCP, etc.).

## Multi-Tenant
Tenant-scoped KBs with plan-based limits.
```

### File Location

`docs/TRAIL-SCHEMA-GIST.md` — compact 2-3k ords dokument.

### Publication

Manuel publikation på gist.github.com/broberg. Tag-cross-reference: gist.github.com/broberg/trail-schema ↔ github.com/broberg-ai/trail.

## Interface

Internal only — no public API. The gist is a static markdown file published externally.

## Rollout

**Single-phase deploy.** Write the file → publish to gist → link from landing page. No code changes to Trail runtime.

## Success Criteria

- Gist live og linket fra trail.broberg.dk
- Analytics viser organisk trafik til trail fra gist-besøgende
- Cc-sessioner i eksterne repos kan kopiere gist'en ind og få "mini-Trail"-adfærd

## Impact Analysis

### Files created (new)
- `docs/TRAIL-SCHEMA-GIST.md`

### Files modified
- `CLAUDE.md` (reference to gist)
- `docs/ROADMAP.md` (marketing task)

### Downstream dependents
`CLAUDE.md` — not imported by any code. Documentation file only.

### Blast radius

None — this is a documentation/marketing feature with no runtime impact.

### Breaking changes

None.

### Test plan

- [ ] Gist file renders correctly on gist.github.com
- [ ] Gist link on trail.broberg.dk footer works
- [ ] Gist content is self-contained (no broken internal links)
- [ ] External cc session can paste gist into a new session and get Trail context
- [ ] Regression: no changes to Trail runtime code

## Implementation Steps

1. Write `docs/TRAIL-SCHEMA-GIST.md` as compact 2-3k word architecture summary.
2. Manually publish to gist.github.com/broberg with title "Trail — Karpathy-style LLM Wiki".
3. Add link to gist from trail.broberg.dk landing page footer.
4. Add cross-reference in CLAUDE.md.

## Dependencies

None.

## Open Questions

None — all decisions made.

## Related Features

- **F112** (User Notes) — can exemplify "LLM's job: compile. Your job: think."
- **F100** (Export) — gist describes the architecture that export operates on

## Effort Estimate

**Small** — 0.5 day.
- Half day: write gist content + publish + link from landing page
