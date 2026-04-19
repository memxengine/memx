# F110 — Comparison Neuron Type

*Planned. Tier: alle. Effort: 1 day.*

> Nyt `/neurons/comparisons/` hierarki der eksplicit sammenligner to eller flere konkurrerende tilgange side-om-side. Positiv framing af noget vores contradiction-alerts dækker som "modsigelse" — ikke enhver forskel er en fejl; nogle gange er det to valide alternativer.

## Problem

Vores contradiction-lint flagger når to Neurons modsiger hinanden (negativ framing: noget er galt). Men ofte er det ikke modsigelse — det er to tilgange der konkurrerer legitimt. Karpathy's gist: *"Comparison pages put related ideas side by side. If two papers propose competing approaches to the same problem, the LLM writes a comparison that draws out the differences."* Det er positiv framing.

## Solution

Ingest-prompten (via F104 researcher-profil) tilføjer:

> "Hvis denne source beskriver en tilgang/metode der konkurrerer med en anden eksisterende Neurons tilgang (uden at modsige den faktuelt), opret en comparison-page i `/neurons/comparisons/<topic-a-vs-topic-b>.md` der:
> - Har `type: comparison` i frontmatter
> - Starter med én-sætnings-formulering af valget (Hvad skal vælges?)
> - Har tre kolonne-tabel: Aspekt | A | B
> - Linker til begge via `[[wiki-links]]`
> - Slutter med 'Tradeoffs'-sektion"

## How

- Path: `/neurons/comparisons/<slug>.md`
- F101 deriveType: path-prefix → `type: comparison`
- Adskilt fra contradiction-alerts: comparisons er designede Neurons, contradictions er flags
- Ingest-prompt: LLM beslutter om forskellen er comparison eller contradiction ud fra om begge kan være gyldige samtidigt

## Dependencies

- F101, F104

## Success criteria

- Ingest af en source der foreslår alternativ til eksisterende koncept producerer comparison-page (ikke bare contradiction-alert)
- Comparisons har konsistent markdown-table-struktur i frontmatter + body
- Chat Q&A "hvornår skal jeg vælge A vs B?" finder comparison-page som primær citation
