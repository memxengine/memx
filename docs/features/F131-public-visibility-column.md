# F131 — documents.public_visibility Column

*Planned. Tier: alle. Effort: 0.5 day.*

> Ny kolonne `documents.public_visibility` ENUM('public','internal','hidden') der styrer om Neurons inkluderes i F130 llms.txt-output + fremtidig connector-API-eksposition. Selv om Trail ikke leverer public UI-visninger, er filteret stadig nødvendigt — nogle Neurons skal ikke engang være i llms-full.txt der kunne pipe ind i LLM-agenter.

## Problem

Nogle Neurons indeholder intern info (kunde-navne, hemmelige interne processer, draft-content) der ikke skal eksponeres — selv ikke via authenticated llms.txt. I dag har vi ingen måde at markere en Neuron som "indekseret men ikke eksponeret".

## Solution

```sql
ALTER TABLE documents ADD COLUMN public_visibility TEXT
  CHECK (public_visibility IN ('public', 'internal', 'hidden'))
  NOT NULL DEFAULT 'internal';
```

Semantik:
- `public` — inkluderes overalt (admin-UI, llms.txt, fremtidig public-API hvis den kommer)
- `internal` (default) — kun for authenticated members af tenant'en (admin, chat, llms.txt for auth'ed consumers)
- `hidden` — skjules også for ikke-owner-members (draft, arkiveret-pending, personlige notes)

F130 llms.txt inkluderer KUN `public` og `internal`. Nogle fremtidige public-features kunne kun vise `public`. Ingen nu-public-endpoint — kolonnen er forbered-til-fremtiden.

Kurator-UI i Neuron-editor får en "Synlighed"-dropdown.

## How

- Schema-migration med default='internal' for eksisterende rows
- Admin-UI udvides med visibility-switcher i Neuron-editor sidebar
- F130 llms.txt-query filtrerer på `public_visibility != 'hidden'`
- Default for nye Neurons: internal
- Ingest-prompt (F103) respekterer eksisterende values når den opdaterer

## Dependencies

- F130 (primær consumer)

## Success criteria

- Kurator kan markere Neuron som 'hidden' → forsvinder fra llms.txt output
- Default for alle eksisterende Neurons er 'internal' (backwards-compatible)
- Admin Wiki-tree har visuel indikator (ikon) for non-default visibility
