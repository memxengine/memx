# F107 — Marp Slide Output

*Planned. Tier: Pro+. Effort: 2-3 days.*

> Brugeren beder chat-LLM'en om "make me slides about X" og får en Marp-formateret markdown-fil der renderes som slide-deck. Alt indhold genereres fra Neurons — slides er endnu et output-format oveni markdown, ligesom Karpathy beskriver i sin gist.

## Problem

Trail's chat-API returnerer kun markdown-body. Karpathy's gist nævner eksplicit slide-decks (Marp) som output-format der feeder tilbage til wiki som kompaktet præsentation. Brugere der arbejder med Trail som research-platform har ingen vej til præsentationsklar output — de skal manuelt klippe/klistre til PowerPoint eller Keynote.

## Solution

Ny endpoint `POST /api/v1/knowledge-bases/:kbId/render/slides`:

```json
{
  "prompt": "Lav 8-10 slides om akupunktur-contraindications",
  "sources": ["concept:contraindications", "concept:needling-safety"],
  "style": "marp-default"
}
```

Returnerer Marp-markdown:

```markdown
---
marp: true
theme: default
---

# Akupunktur Contraindications
*Fra Trail KB, 2026-04-20*

---

## 1. Bleeding disorders
- Vermeiden hos patienter med hæmofili
- Kilde: [[concept:contraindications]]

---
```

Brugeren kan save tilbage som Neuron (type='slides'), eksportere som .md, eller — fremtidigt — rendere til PDF via serverside Marp-CLI.

## How

- Nyt tool til chat-LLM'en: `generate_slides(prompt, kb_scope)` der returnerer Marp-markdown
- Rendering sker client-side i admin-UI via eksisterende Marp-plugin-ækvivalent (fx marp-web-component)
- Server-side PDF-export defereres til næste iteration (sparer opscopering)
- Marp-plugin i Obsidian-export (F100) renderer slides natively når brugeren eksporterer

## Dependencies

- F100 (Obsidian-export — Marp-filer virker direkte i Obsidian med Marp-plugin)
- F105 (proactive save-suggest — LLM kan foreslå "Skal jeg gemme slides som Neuron?")

## Success criteria

- "Generate slides om X" i chat returnerer gyldig Marp-markdown
- Admin-UI kan preview slides som deck i browser
- Eksport via F100 inkluderer slides som `.md` med `marp: true` frontmatter → åbner som slide-deck i Obsidian
- Pro-tier marketing-asset: "Generate presentations directly from your knowledge base"
