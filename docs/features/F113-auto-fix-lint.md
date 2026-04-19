# F113 — Auto-fix in Lint

*Planned. Tier: Solo-mode default-on, Curator-mode opt-in per rule. Effort: 2-3 days.*

> Når contradiction/orphan/stale-lint finder et problem med høj confidence (fx "broken [[wiki-link]] til arkiveret Neuron"), fikser LLM'en det automatisk i stedet for at åbne et curator-candidate. Matcher Karpathy's "living AI knowledge base that actually heals itself".

## Problem

Vores lint flagger problemer og lægger dem i queue som candidates for kurator. For Solo-brugere er det friktion — mange findings er trivielle ("fjern dead link") som LLM'en kunne fixe uden menneskelig intervention. Karpathy's design: "The LLM flags these issues and can fix many of them automatically."

## Solution

Hver lint-detector får en `autoFixConfidence: 0-1`-score per finding. Over en threshold (fx 0.9) og hvis brugeren er i Solo-mode (eller har opt'ed auto-fix for denne rule i Curator), udfører LLM'en en direkte fix:

| Lint-rule | Auto-fix når... | Handling |
|---|---|---|
| Dead `[[wiki-link]]` (target archived) | target arkiveret i 30+ dage | fjern link, log i wiki_events |
| Duplicate concepts (2 Neurons, samme topic) | similarity ≥95 % | merge til newest, archive other, log |
| Missing frontmatter `type:` | kan udledes deterministisk af path | tilføj inferred type |
| Stale date field | >365 dage siden source-opdatering | refresh date til today |
| Orphan source (no Neurons cite) | >180 dage gammel + Neurons citerer samme emne | generer source-summary |

Contradiction-findings auto-fixes IKKE — semantisk for kompleks, altid kurator-beslutning.

Alle auto-fixes registreres i wiki_events med `actorKind='llm'` + `actor.id='system:auto-fix'`. Solo-mode Audit-view viser dem i kronologisk feed.

## How

- Udvid `LintFinding`-typen med `autoFix?: { confidence: number; action: FixAction; dryRunDescription: string }`
- Ny effect `effect: 'auto-fix'` i candidate-handling → bypasser human-approval
- Runner i `services/lint-scheduler.ts`: ved auto-fix-tærsklen dispatch til fix direkte
- Audit-view i Solo-mode viser auto-fixes med "Auto-fixed: {description} — Undo"-link (30 dages angre-vindue)

## Dependencies

- F106 (Solo-mode) — primary consumer
- F118 (sampling) — auto-fix skal respektere sampling-budget

## Success criteria

- Dead-link-fix udføres uden manuel intervention i Solo-mode
- Audit-view viser fix med begrundelse + undo-link
- False-positive rate <2 % (målt ved at kurator "Undo"-klik skal være sjældent)
- Marketing: "Your knowledge base heals itself"
