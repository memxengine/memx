# F109 — Synthesis Neuron Type

*Planned. Tier: alle. Effort: 1 day (prompt + path).*

> Nyt `/neurons/synthesis/` hierarki med proaktivt-genererede synthesis-pages — tværgående tematisk sammenknytning af flere sources. Tydeliggør value-add'en som Karpathy's gist nævner eksplicit som distinct fra concept-pages.

## Problem

Vores nuværende ingest-prompt producerer source-summaries, concept-pages, og entity-pages. Vi har **ikke** en eksplicit kategori for "ties multiple sources together around a theme" — Karpathy's synthesis-page. Sådanne sider opstår måske implicit som concept-pages, men uden clear intent eller prompt-guidance om at LAVE dem.

## Solution

Ingest-prompten (via F104 per-KB-profile) tilføjer trin:

> "Efter trin 5 (entity-pages): reflektér over om denne nye source skaber et **tema** der spænder på tværs af 3+ eksisterende Neurons. Hvis ja, opret eller opdater en synthesis-page i `/neurons/synthesis/<theme>.md` der:
> - Identificerer temaet i én sætning
> - Lister de bidragende Neurons via `[[wiki-links]]`
> - Opsummerer hvad tværsnittet afslører (modsætninger, fælles mønstre, tidsmæssig udvikling)
> - Har `type: synthesis` i frontmatter"

## How

- Path-konvention: `/neurons/synthesis/<slug>.md`
- F101 deriveType mapper path → `type: synthesis`
- Ingest-prompt tilføjer synthesis-evaluation som valgfrit trin (ikke obligatorisk — LLM kan vurdere at der ingen er)
- F113 auto-fix-lint kan foreslå synthesis-candidates når orphan-lint finder 3+ concepts der ofte cites sammen

## Dependencies

- F101 (type-frontmatter)
- F104 (prompt-profiler — synthesis-prompt i researcher.md)

## Success criteria

- Ingest af source der relaterer til 3+ eksisterende concepts producerer (eller opdaterer) en synthesis-page
- Synthesis-pages er browsable i wiki-tree under dedikeret `/neurons/synthesis/` gren
- Obsidian-eksport (F100) placerer dem i `wiki/synthesis/`-undermappe
- Graph-view i Obsidian viser synthesis-pages som hubs med mange indgående links
