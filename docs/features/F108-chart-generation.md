# F108 — Chart & Visualization Generation

*Planned. Tier: Pro+. Effort: 3-4 days.*

> Chat-LLM'en kan generere grafer og visualiseringer fra data i Neurons — matplotlib-style bar/line/scatter charts, comparison-tables, timelines. Leveres som SVG (embeddes i markdown) eller PNG (standalone). Matcher Karpathy's gist-hint om "charts (matplotlib), canvas" som første-klasses output-format.

## Problem

Neurons indeholder ofte strukturerede data — dosage-tables, version-historik, benchmarks — der ville være tydeligere som grafer. Karpathy nævner matplotlib-charts direkte som output-format. Trail har ingen vej til at bede LLM'en render visualisering; output er ren tekst.

## Solution

Tre tilgange, rangeret efter kompleksitet:

**MVP — SVG via LLM direct**: LLM-tool `render_chart(type, data, title)` der producerer rå SVG-markup. Bygger på at moderne LLMs kan generere SVG fra tal. Ingen subprocess, ingen matplotlib-install. Limitation: komplekse charts (stacked bar, violin) er upålidelige.

**V2 — Python subprocess med matplotlib**: Server kører `python3 -c 'import matplotlib; ...'` med sandboxed input. Kræver Python + matplotlib i runtime image. Mere kode at udvikle men meget mere præcis output.

**V3 — Chart.js-kompatibel JSON + client render**: LLM genererer Chart.js config, admin-UI renderer interaktivt. Best UX hvis målgruppen er web-visning.

Start med MVP (SVG). Tilføj V2 hvis brugere beder om mere kompleksitet.

## How

- Chat-API tilføjer `chartsGenerated: ChartOutput[]` i response
- Admin-UI rendrer SVG direkte (sanitized)
- Obsidian-export (F100) inkluderer charts som `.svg`-filer i `wiki/assets/`
- Save-as-Neuron bevarer chart-data + markdown med `![chart](./assets/chart-1.svg)`-ref

## Dependencies

- F100 (eksport af charts som assets)
- F107 (slides kan inkludere charts)

## Success criteria

- "Lav en bar-chart af antal sources per måned" producerer valid SVG
- Chart gemmes som del af Neuron når "Save as Neuron" bruges
- Eksport-ZIP inkluderer `wiki/assets/` med alle genererede charts
- Marketing: "Trail turns your data into presentations — automatically"
