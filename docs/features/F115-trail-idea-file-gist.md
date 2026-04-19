# F115 — Trail "Idea File" as Public Shareable Gist

*Planned. Tier: infrastruktur/marketing. Effort: 0.5 day.*

> Trail publicerer sin egen arkitektur-skema som en offentlig GitHub gist — matching Karpathy's llm-wiki.md idea-file. Folk der googler "Karpathy LLM wiki" eller "second brain SaaS" finder vores gist → genererer prospect-traffic til trail.broberg.dk.

## Problem

Karpathy's gist er viral fordi den er **copy-paste-able i en hvilken som helst LLM-agent**. Vi har vores CLAUDE.md checked in i repo'en men ikke som standalone public gist. Det betyder:

1. Andre udviklere kan ikke nemt "kopiere mønsteret" fra os — de skal clone hele repo'et
2. SEO-potentiale på "Karpathy-style knowledge base"-søgninger er ikke realiseret
3. Intellektuel positionering (vi er "Karpathy-pattern-implementation") er implicit, ikke eksplicit

## Solution

Publicér `docs/TRAIL-SCHEMA-GIST.md` som:
- **offentlig GitHub gist** fra Christians account
- Link til gist'en fra trail.broberg.dk forside ("Our architecture, in one file")
- Gist'en er strukturmæssigt en udvidet version af Karpathy's med:
  - Trail's tre-lag-arkitektur (raw / wiki / schema) citerende Karpathy
  - Tilføjelser: curation queue, contradiction-lint som LLM-drevet, connector-attribution, multi-tenant
  - "Copy this into your cc/Cursor session to understand Trail's design"

## How

- Skriv gist-indhold som compact 2-3k ords dokument i `docs/TRAIL-SCHEMA-GIST.md`
- Manuel publikation på gist.github.com/broberg (kan ikke automatiseres uden token-management)
- Link fra landing-page footer + CLAUDE.md
- Tag-cross-reference: gist.github.com/broberg/trail-schema ↔ github.com/broberg-ai/trail

## Dependencies

Ingen.

## Success criteria

- Gist live og linket fra trail.broberg.dk
- Analytics viser organisk trafik til trail fra gist-besøgende
- Cc-sessioner i eksterne repos kan kopiere gist'en ind og få "mini-Trail"-adfærd
