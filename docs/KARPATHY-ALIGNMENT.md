# Trail vs. Karpathy's Second-Brain — alignment + gaps

*Skrevet 2026-04-20 efter læsning af Nikhil's Medium-artikel "Andrej Karpathy Stopped Using AI to Write Code. He's Using It to Build a Second Brain Instead" (Apr 5, 2026) der refererer Karpathy's viral X-post + GitHub gist fra 3. april 2026.*

## Hovedbudskab

Trail's arkitektur konvergerer med Karpathy's system på **~90 % af substansen**. Vi har uafhængigt landet på samme insights: markdown-first, compile-once-read-many, `/neurons/` hierarki med concepts + entities + sources, `[[backlinks]]`, frontmatter, `overview.md` + `log.md`, tre-operations-model (ingest / query / lint), ingen vector-DB.

Det er **stærk validering** for vores tekniske valg — Karpathy's viral-tweet og hans gist giver os markedsføringsmæssig rygdækning for pattern'et "compile-wiki, don't RAG".

De 10 % der afviger er to slags:
1. **Gaps vi bør lukke** (slides-output, synthesis + comparison pages, web-clipper, user-notes)
2. **Bevidste forskelle** (multi-tenant SaaS vs. solo-local, queue-mediated vs. trust-LLM) — disse er value-ads for professionelle kontekster, men skal kunne skjules i **Solo-mode** for at passe Karpathy-type solo-bruger.

## Fuld alignment-oversigt

### 1:1 match (vi gør det allerede)

| Karpathy | Trail |
|---|---|
| `raw/` folder, uforanderlig | `kind='source'` documents, soft-archivable but not mutated |
| `wiki/` compiled output | `kind='wiki'` documents under `/neurons/` |
| CLAUDE.md / AGENTS.md som schema | CLAUDE.md + ingest-prompt i `services/ingest.ts` |
| Entity pages | `/neurons/entities/` — eksplicit i ingest-prompt |
| Concept pages | `/neurons/concepts/` — eksplicit i ingest-prompt |
| Per-source summary pages | `/neurons/sources/` — eksplicit i ingest-prompt |
| `log.md` (kronologisk record) | `overview.md` + `log.md` — identiske navne |
| `[[wiki-links]]` | `parseWikiLinks()` + `wiki_backlinks`-tabel |
| YAML frontmatter for metadata | parseret af `reference-extractor` + stored in `documents.metadata` |
| Tre operationer: Ingest / Query / Lint | `services/ingest.ts` + `/api/v1/chat` + `packages/core/src/lint/` |
| Incremental ingest (ej rebuild-from-scratch) | Per-source ingest merger ind i eksisterende struktur |
| "Compiling" terminologi | Vi bruger samme sprog i F95/docs + CLAUDE.md |
| Ingen vector-DB, ingen RAG | SQLite FTS5, ingen embeddings overhovedet |
| LLM læser index + summaries til queries | Chat-service spawn'er claude med MCP-tools der slår op via FTS |
| Lint som maintenance-pass | F32.1 orphans + stale + contradictions |
| Outputs feeder tilbage til wiki | `saveChatAsNeuron` → candidate → Neuron |

### Funktionelt-ækvivalent (anden mekanisme, samme outcome)

| Karpathy | Trail |
|---|---|
| Git versioning | `documents.version` + `wiki_events` med `contentSnapshot` |
| Obsidian som viewer | Web admin-UI på trail.broberg.dk |
| Plain markdown-filer på disk | SQLite med markdown som `content`-kolonne |
| Manuel LLM-kald til compile | Automatisk ingest-pipeline via `spawnClaude` ved source-upload |
| Kopier-gist-som-prompt for andre | CLAUDE.md er checked in som dogfood — andre cc-sessioner læser den automatisk |
| LLM navigerer index-filer ved query | FTS5 + chat-LLM med MCP-tools (`search`, `read`, `guide`) |

## Hvad Karpathy har, som vi IKKE har

Udtømmende liste fra artiklen. Nogle er feature-gaps, andre er bevidste forskelle.

### A — Output-generering ud over markdown

**A1. Slide presentations (Marp format)**
> "If he needs to present findings, the LLM generates slides directly."

Karpathy laver slide-decks i Marp (markdown-til-slides) fra sit wiki. Vi har **ingen slide-output**.

**A2. Charts og visualizations (matplotlib)**
> "Data from the wiki gets turned into visual representations."

Han genererer grafer fra wiki-data. Vi har **ingen chart-generering**.

**A3. Comparison-tables som output-format**
> "Comparison tables that put ideas side by side in a structured format."

Output-formatet er ikke bare markdown men også strukturerede sammenligningstabeller. Vores output er udelukkende markdown-tekst.

### B — Første-klasses Neuron-typer vi mangler

**B1. Synthesis pages**
> "Synthesis pages provide overviews that tie multiple sources together around a theme."

Distinct fra concept-pages: synthesis er **tematisk sammenknytning af flere kilder**. Vores ingest-prompt nævner ikke denne type; den opstår implicit som koncept-pages men uden eksplicit "tie-together" intent.

**B2. Comparison pages**
> "Comparison pages put related ideas side by side. If two papers propose competing approaches to the same problem, the LLM writes a comparison that draws out the differences."

Proaktiv sammenligning. Vi har **contradiction-alerts** (negativ framing: "disse to modsiger hinanden"), men ikke **positive comparison-pages** (positiv framing: "disse to foreslår forskellige tilgange, her er trade-offs").

Contradiction-detection er når noget ER galt. Comparison er en legitim konkurrence mellem to lige gode tilgange.

**B3. Per-source "digest" som konsistent format**
> "Summaries are per-source digests. Each raw document gets a summary page that captures the key points without you having to read the entire original."

Vores source-summaries genereres af ingest-prompten, men uden strikt "digest"-format. Karpathy's er mere strikt struktureret.

### C — Input-pipeline (raw-collection)

**C1. Obsidian Web Clipper-workflow**
> "For web articles, Karpathy uses the Obsidian Web Clipper browser extension, which converts web pages into markdown files with one click."

Én-klik-clipping af web-sider som markdown. Vi har **ingen browser-extension**. Vores upload-flow kræver manuel filupload.

**C2. Download af relaterede images lokalt**
> "He also downloads related images locally so the LLM can reference them directly instead of relying on web URLs that might break."

For web-artikler downloades inline-images som lokale filer, så de ikke forsvinder når URLen bryder. Vores PDF-pipeline extraherer images — men for markdown-artikler der refererer eksterne URLs har vi **ingen image-archiving**.

**C3. "Every business has a raw/ directory"** (fra en respons til Karpathy, citeret i artiklen)
> "Every business has a raw/ directory. Nobody's ever compiled it. That's the product."

En provokerende påstand som Karpathy accepterer. Det positionerer `raw/` som universal start-state for enhver organisation. Vi har intet tilsvarende **conceptuelt framing** i vores markedsføring.

### D — Storage- og data-ejerskab

**D1. Plain markdown-filer på lokal disk**

Karpathy ejer bogstaveligt sit data som filer han kan åbne i enhver editor. Vi har markdown i SQLite-DB — kun tilgængeligt via admin-UI eller API-endpoints.

Konsekvens: vendor-lock-in bekymring. Hvis Trail forsvinder, hvad har kunden? I dag: adgang til en DB-backup de skal selv parse. Hos Karpathy: en mappe de kan åbne overalt.

**D2. Ingen vendor lock-in, ingen subscription, ingen cloud dependency**
> "If Obsidian disappears tomorrow, you still have a folder full of text files you can open in anything."

Dette er **direkte kritik af vores SaaS-model**. Vi kan afbøde: export-endpoint der pakker alle Neurons + sources som en ZIP-arkiv i Obsidian-kompatibelt format.

**D3. Git-versionering som ejerskabs-garanti**

Han kan checke wiki'en ind i et personligt git-repo. Vi har versions-historik i DB men ingen git-export.

### E — LLM-interaktion og auto-healing

**E1. Lint der kan fix problems automatisk**
> "The LLM flags these issues and can fix many of them automatically."

Karpathy's lint kan **auto-fix** mange af de fundne problemer. Vores lint flagger som candidates som kurator skal godkende.

For Solo-mode: lint kan auto-fix på høj-confidence findings (fx "dead link til arkiveret Neuron → fjern reference automatisk").

**E2. "Living AI knowledge base that actually heals itself"**

Self-healing-konceptet. Vores lint opdager men fixer ikke uden menneske. Karpathy's heler.

**E3. 10-15 wiki-pages opdateret per nye source**
> "The LLM reads it, extracts the important information, and updates 10–15 wiki pages."

Mere aggressiv update-pattern end vores. Vores ingest-prompt siger "2-5 concepts". Han laver op til 3× så mange cross-page updates per kilde. Potentielt rigere backlink-graph.

Uklart om forskellen er prompt-engineering eller bevidst conservatism fra vores side.

### F — UX for brugerens egen tænkning

**F1. Luhmann-kritik — synthesis er human work**
> "The LLM is excellent at the reconnaissance phase mapping the territory, organizing information, finding connections you might have missed. But synthesis actually forming original ideas from the material is still a human job."
>
> "Reading someone else's summary is not the same as formulating the idea yourself."

Karpathy accepterer dette som begrænsning. Hans system **opfordrer ikke aktivt** brugeren til at tilføje egen synthesis — det er noget man må beslutte selv.

Vi har **ingen UX** der prompter curator: "LLM har compileret dette. Hvad er DIN tanke?". Vores Neuron-reader viser kun LLM's output.

**F2. Chat-output-feed-tilbage som compounding**
> "When he asks a complex question and gets a thorough answer, he 'files' that answer back into the wiki. This means his own explorations and queries always compound — every question makes the knowledge base richer."

Vi har `saveChatAsNeuron`, men den går **gennem queue** (candidate pending approval). For Karpathy er det én-klik-save der auto-indekseres.

### G — Output back-feed som multi-format

**G1. Multi-format output-options**

Karpathy's "file output back" er **ikke kun markdown** — det kan være slides, charts, comparison-tables der alle gemmes i wiki'en. Hver query beriger wiki'en i det format der passer spørgsmålet.

Vores save-back er udelukkende markdown-body.

### H — Meta: sharing og reproducerbarhed

**H1. Schema som "idea file" (copy-paste-able gist)**
> "He shared what he called an 'idea file' — a GitHub gist laying out the full architecture, designed to be copied and pasted directly into an LLM agent so it can build the system for you."
>
> "In this era of LLM agents, there is less of a point/need of sharing the specific code/app, you just share the idea, then the other person's agent customizes & builds it for your specific needs."

Karpathy's pointe er **paradigmeskifte**: i LLM-agent-æraen deles ideer, ikke kode. Hans gist er den idé.

Vores CLAUDE.md er ikke public-shareable som gist. Vi kunne publicere den som "Trail's idea-file" — lad folk kopiere mønsteret selv.

Det rammer direkte vores B2B-positionering: **Trail er Karpathy's idea-file realiseret som hostet platform**. Hvem vil ikke bygge den selv, men hellere abonnere på den.

**H2. Domain-agnostic via schema-swap**
> "The system is domain-agnostic because the schema layer absorbs all the domain-specific configuration. Change the instructions in your CLAUDE.md file, and the same architecture compiles a different kind of wiki."

Karpathy's CLAUDE.md er pr. wiki — forskellige wikis har forskellige CLAUDE.md'er. Vores ingest-prompt er **global server-side** i `services/ingest.ts`.

Trail burde tillade **per-KB ingest-prompt-override**. En medicinsk KB kunne have én prompt, en kodebase-KB en anden, en studie-KB en tredje.

### I — Fremtidige retninger Karpathy nævner

**I1. Synthetic training data + fine-tune**
> "Once your wiki is clean, comprehensive, and well-linked, you could use it to generate synthetic training data and fine-tune a smaller LLM so it actually 'knows' the information in its weights."

Avanceret use-case. Vi har intet tilsvarende.

Potentiel Pro+/Business-tier-feature: "Export wiki as fine-tuning dataset" — en knap der genererer prompt-completion-pairs fra Neurons. Teknisk simpelt, markedsføringsmæssigt stærkt som "differentierende feature".

## Hvad Trail har, som Karpathy IKKE har

For balance — vi er langt fra bare "catch up" med ham.

1. **Multi-tenant + hosted** — han er personlig-lokal. Vi er SaaS-klar.
2. **Curation Queue (F17)** — hver LLM-skrivning er pending → approve. Hos ham skriver LLM'en direkte.
3. **F19 confidence-baseret auto-approval-policy** — vores hybrid mellem trust-LLM og human-review.
4. **Reference-extractor som separat pass** — `document_references`-tabel (provenance ≠ navigation ≠ content).
5. **LLM-drevet contradiction-detection som first-class** — han har lint, vi har en dedikeret LLM-checker i `contradiction-lint.ts`.
6. **Multi-language translation-cache på candidates** — han har ingen i18n.
7. **Connector-attribution (F95)** — vi ved hvor hver Neuron kom fra.
8. **SSE live event-stream** — live-update i admin-UI.
9. **Wiki_events replay-chain** — strukturel time-travel med contentSnapshots.
10. **Auto-link-sources effect** — orphan-Neuron får LLM til at foreslå hvilke sources den burde cite (F90.1).
11. **Bearer-token API** — service-to-service integration-vej (buddy, CI, andre CMS'er).
12. **MCP-server** — cc-sessioner og Cursor kan arbejde direkte mod Trail.
13. **Settings + admin-UI** — visuel kurator-oplevelse for ikke-tekniske brugere.
14. **F32.2 scheduled dreaming-pass** — tidsstyret re-scan af hele KB. Hans er ad-hoc.
15. **Multi-KB per tenant** — Karpathy har én wiki. Vi har flere "Trails" pr. bruger.

## Solo-mode — "Release the Tyranny"

Queue-mediated writes, pending candidates, auto-approval-thresholds, contradiction-alerts på skema. Alle disse er features for et professionelt kurator-team. For Karpathy-style solo-brugere der stoler på deres LLM er det **tyranni** af godkendelses-ceremonier.

Solo-mode fjerner ceremonien — men bevarer auditeringen under motorhjelmen.

### Hvad Solo-mode ændrer

Kolonne: `tenants.mode` eller `users.mode` (bedst — pr. bruger, ikke pr. tenant, så et tenant kan have både sole og curator-brugere):

```sql
ALTER TABLE users ADD COLUMN mode TEXT
  CHECK (mode IN ('solo', 'curator'))
  NOT NULL DEFAULT 'curator';
```

Når `mode = 'solo'`:

#### Auto-approval
- **F19 auto-approval-threshold** flyttes fra 0.8 til 0.0 for candidates med `createdBy = <this user>`
- Alle LLM-genererede candidates fra denne bruger's ingest-sessions auto-approves
- `autoApprovedAt` sættes stadig, så audit-trail er intakt — intet skjules for admin

#### Queue-tab
- Queue-tab i nav **skjules som default**
- Erstattes af "Audit"-link (samme data, anden framing) nederst i settings
- Badge-count fjernes (ingen "47 pending"-anxiety)
- Hvis bruger alligevel åbner Audit, kan de se alle auto-approvals som kronologisk feed

#### Chat-save
- "Save as Neuron" ved chat-svar **auto-approves uden modal**
- Toast: "Gemt som Neuron" i stedet for "Gemt til køen, gennemgå i Queue-fanen"
- Citation-links peger direkte på den nye Neuron, ikke på candidate-detail

#### Re-ingest
- "Re-ingest this source"-knappen **udfører direkte** uden bekræftelses-modal
- Stadig LLM-dyr, men curator-brugeren kan acceptere den frihed (eller toggle tilbage)

#### Lint
- **Scheduled dreaming-pass deaktiveres** (TRAIL_LINT_SCHEDULE_HOURS effektiv 0 for solo-users)
- Erstattes af manual "Run lint" knap i settings
- On-mutation contradiction-scan også deaktiveret som default (toggle-able)
- Lint-findings auto-fixer når confidence er høj (kræver impl. af auto-fix — se gap E1)

#### Ingest-modals
- Upload → ingest-start modal skjules. Upload trigger direkte automatisk ingest.
- Kun fejl-tilstand viser notification

#### Contradiction-UI
- Contradiction-alerts vises ikke som candidates i navbar
- Samles i en "Potentielle modsigelser" sektion i settings som bruger KAN åbne når de føler for det
- Ingen auto-toast om "Ny modsigelse opdaget"

### Toggle-oplevelse

I Settings > Account tilføjes:

```
┌─────────────────────────────────────────────────────┐
│  Trail-tilstand                                      │
│                                                      │
│  ○ Kurator (anbefalet til teams)                     │
│     Alle LLM-skrivninger gennemgås i kø før de       │
│     lander. Fuld audit, fuld kontrol.                │
│                                                      │
│  ● Solo (anbefalet til enkeltbrugere)                │
│     LLM skriver direkte. Audit-log er tilgængeligt   │
│     i Settings når du har brug for det. Ingen kø,    │
│     ingen godkendelses-ceremoni.                     │
│                                                      │
│  Du kan skifte til enhver tid.                       │
└─────────────────────────────────────────────────────┘
```

### Hvad Solo-mode IKKE ændrer

Intet af dette fjernes — kun skjules eller ændres i default-opførsel:

- **Wiki-events + contentSnapshot-historik** skrives stadig. Hvis bruger vil rulle tilbage, det kan de.
- **Queue-tabellen persisterer stadig candidates** — de er bare alle auto-approved med `createdBy = <user>`.
- **Bearer-auth, session-auth, tenant-scoping** — alt identisk.
- **API-endpoints** — uændret. Solo-mode er kun en UI-flag.
- **Kunne skifte tilbage til Curator-mode når som helst** og se alle historiske auto-approvals i Audit.

### Tilgængelighed per tier

Solo-mode er **kun for Starter og hobby-agtige single-user tiers**. Pro (der allerede antager team-brug) eksponerer det som valgbar setting, men default er Curator. Business har Solo-mode skjult — enterprise-compliance tillader ikke "bare-trust-the-LLM"-mode.

| Tier | Solo-mode adgang |
|---|---|
| Free | Tvunget Solo (ingen Queue-UI overhovedet) |
| Starter | Default Solo, kan skifte til Curator |
| Pro | Default Curator, kan skifte til Solo |
| Business | Kun Curator (compliance) |
| Enterprise | Custom pr. kontrakt |

### Implementering-estimat

~1-2 dages arbejde:
- Kolonne + migration
- F19-policy-patch: læs actor's mode, juster threshold
- Admin-UI: nav-tab conditional rendering + Audit-view (genbrug af queue-view med andet label)
- Toggle i Settings > Account

Ingen ændring til core-pakken, ingen nye endpoints, ingen skema-breaking ændringer.

## Prioriteret action-plan

Fra gap-listen, rangeret efter **impact/effort**:

### Top tier (bygges først — høj impact, lav effort)

1. **Solo-mode settings-toggle** (1-2 dage) — fjerner queue-friktion for solo-tier-brugere. Afgørende for at kunne konkurrere mod Karpathy's "lokalt + gratis"-fortælling.
2. **Per-KB ingest-prompt override** (1 dag) — lader KB specialisere sig til domæne uden global kode-ændring. Matcher Karpathy's "domain-agnostic via schema-swap".
3. **Export til Obsidian-kompatibelt markdown** (2 dage) — ZIP-arkiv med alle Neurons som `.md`-filer + frontmatter + wiki-links. Løser vendor-lock-in-kritikken direkte.
4. **Synthesis + Comparison som first-class Neuron-typer** (1 dag prompt-engineering) — tilføj `/neurons/synthesis/` og `/neurons/comparisons/` til ingest-prompten. Gør Trail mere konkret-sammenligneligt med Karpathy's artikel.

### Mellemtier (byg hvis der er kapacitet)

5. **Chat-browser-extension** (3-5 dage) — "Trail Web Clipper" for Chrome/Firefox. Én klik fra webside til source i Trail.
6. **User-note / "Din tanke"-felt på Neurons** (2-3 dage) — Luhmann-type synthesis-prompt. Tydeligør at Trail er second-brain-augmentation, ikke erstatning.
7. **Slide-output via Marp** (2-3 dage) — direkte konkurrence-feature mod Obsidian + manual-workflow. Markedsføringsstærkt.
8. **Chart-generering** (3-4 dage) — matplotlib via Python-subprocess eller direkte SVG-gen via LLM. Mindre vigtigt end slides.
9. **Auto-fix i lint** (2-3 dage) — på høj-confidence findings, lad lint fixe uden kurator-input. Vigtigt for Solo-mode at give den "heals-itself"-følelse.

### Lavtier (parkér til efter produkt-market-fit)

10. **Trail "idea-file" som public gist** (0.5 dag) — publicér vores schema som Karpathy publicerede sin. Marketing-gevinst, minimal kode.
11. **Image-archiving ved web-clipping** (1-2 dage) — download inline images som binary sources. Mest værdi ved aktiv web-clipper brug.
12. **Synthetic training data export** (5+ dage) — Pro+/Business-feature. "Eksportér wiki som fine-tuning-dataset". Koncept-stærkt men krævende at bygge rigtigt.
13. **Git-versionering som export** (3 dage) — genererer git-repo fra wiki-events-historik. Nische-feature.

### Ikke relevant / bevidst IKKE gjort

- **Obsidian som viewer** — vi har vores egen admin-UI. At bygge Obsidian-plugin ville være re-implementering for intet.
- **Plain-filer på disk** — vores SaaS-model kræver DB. Export-featuren (action #3) løser behovet uden at flytte hele storage-modellen.
- **Ingen subscription** — vi ER subscription-modellen. Kompensation: vi giver Karpathy-style functionality + team-features + hosted convenience.

## Meta-observation — markedsførings-opportunity

Karpathy's virale tweet + GitHub gist er **content-gold** for Trail's positionering. Vi kan:

- **Skrive en teknisk blog-post**: "Vi byggede Karpathy's system som SaaS (før han tweetede det)". Etablere prior-art og samtidig appropriere hans tribal-momentum.
- **Reach out til Karpathy direkte**: han kunne være interesseret i at se vores hostede version af sin idé. Low-risk outreach.
- **Tagge artiklens forfatter Nikhil** på Twitter/X med Trail-demo. Writer-relation-building.
- **Bygge en "Import from Karpathy's gist"-feature** der tager hans CLAUDE.md og maker Trail-KB. Direct-aftermarket for hans tweet-traffic.

Alt dette er lav-effort, høj-potentiel-upside. Overvej at dedikere én eftermiddag til content + outreach inden for 1-2 uger mens viral-vinduet er åbent.

## Decision log

- **Alignment er stærk (90%)** — ikke tilfældigt. Vi bygger samme idé, fra uafhængig kilde.
- **Top-gap at lukke er Solo-mode** — fjerner curator-friktion for single-user tiers, matcher Karpathy's model.
- **Export til Obsidian-format bør prioriteres** — neutraliserer vendor-lock-in-kritik.
- **Synthesis + Comparison pages** — få ord i ingest-promten, stor værdi.
- **Slides + charts** — feature-differentiering men ikke critical-path.
- **Multi-tenant, hosted, queue-mediated** bevares som default — det er hvad gør Trail til SaaS, ikke scripted note-taking.
- **Vi markedsfører "Trail er Karpathy-arkitekturen, hostet og team-ready"** — kort, sand, salgbar.

## Åbne spørgsmål

1. **Skal vi aktivt distancere os fra Karpathy-brandet** (ikke nævne ham direkte for at undgå reference-trap), eller **omfavne** (som "implementation of the pattern X pioneered")? Mit instinkt: omfavn og krediter. Det fjerner skepsissen ved "endnu en AI-knowledge-base" og giver os intellektuel-credibility.
2. **Solo-mode's target-tier** — Starter default Solo eller default Curator? Mit bud: Starter default Solo, Free tvunget Solo, Pro default Curator.
3. **Hvor aktivt skal vi markedsføre "export til Obsidian"?** Det kan signalere "du kan stikke af fra os når som helst" — sundt for tillid, men måske churn-accelererende. Anbefaling: tilbyd featuren, markedsfør det ikke.
4. **Skal per-KB ingest-prompt-override være sluttet til alle tier eller kun Pro+?** Mit bud: alle tier får det som "Advanced" setting. Complexity-barrieren begrænser naturligt uønsket brug.
5. **Skal "auto-fix lint" default-on i Solo-mode og default-off i Curator?** Ja. Det er hele pointen med Solo.
