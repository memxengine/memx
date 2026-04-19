# Trail som docs-backend

*Tillæg til prissætnings-planen. Skrevet 2026-04-19. Besvarer: hvordan kan Trail drive docs.webhouse.app (og senere kunders docs), og hvilken model gør det uden at ødelægge hvad der allerede virker.*

## Udgangspunkt

`docs.webhouse.app` kører p.t. på @webhouse/cms (dogfood). Metrik:

| Metrik | Værdi |
|---|---|
| Dokumenter | 89 EN + 84 DA = 173 |
| Ord-volumen | ~15-25k ord totalt |
| Struktur | Feature-hierarchy (intro → core → advanced → changelog) |
| Features | FTS-søgning, i18n toggle, HelpCards in-app, v0.2.13 semantic versioning |
| Rendering | Static-first, custom theme, CDN |
| Mangler | Comments, chat-Q&A, cross-doc contradiction-detection |

Dagen i dag er @webhouse/cms **god nok** til selve rendering-laget. Diskussionen er ikke "erstatte", men "hvad kan Trail tilføje".

## Tre modeller, sammenlignet

### Model 1 — Trail som AI-lag oven på eksisterende CMS

- @webhouse/cms fortsætter uændret som rendering + SSG + public reader
- Trail tilføjes som backend for **chat-Q&A** + **contradiction-lint** + **LLM-search**
- Integration via webhook: docs-page gem → POST til Trail → auto-ingest som source → Neuron-compile
- Docs-siten får "Spørg AI"-knap der kalder `POST /api/v1/chat` mod docs-Trail

**Effort:** ~1 uges arbejde.
**Tier til Trail-siden:** Starter $20/mdr (173 sources → ~270 compiled Neurons, under 500-cap).
**Værdi:** AI-chat + modsigelses-detektion tilføjet, 0 risiko for eksisterende docs-setup.

### Model 2 — Trail som eneste backend

- Alle 173 docs flyttes til Trail som `kind='wiki'` Neurons (direkte-edit, skip ingest)
- Ny public reader-app konsumerer Trail's read-API
- Kræver 5 nye F-features (se nedenfor)

**Effort:** 3-4 uger.
**Tier:** Starter $20/mdr.
**Værdi:** One platform, men vi bygger funktionalitet @webhouse/cms allerede har. Dårlig ROI medmindre "docs-platform" bliver del af Trail's pitch.

### Model 3 — Docs som sources, AI-svar som Neurons (anbefalet hybrid)

- Hver docs-markdown-fil uploads til Trail som `kind='source'`
- LLM-compile → Neurons der besvarer "hvordan gør jeg X?"-spørgsmål på tværs af docs
- Trail's chat bruger de **compilerede** Neurons, ikke rå docs
- @webhouse/cms renderer fortsat siden, men `/docs/<page>` tilføjer "AI-svar-hits"-panel der viser relevante Neurons
- Contradiction-lint fanger når to docs-versioner siger noget forskelligt om samme API

**Effort:** 2-3 uger.
**Tier:** Pro $75/mdr (kræver ugentlig sampling for contradiction-lint at give værdi på docs-versions-drift; plus LLM-compile på hver docs-update koster compute).
**Værdi:** LLM fletter docs, finder modsigelser på tværs af versioner, AI-chat over struktureret viden — alt det Trail er designet til.

## Anbefaling

**Model 3.** Det er den eneste af de tre der **bruger Trail's kerne-primitiver** (ingest-compile, curation-queue, contradiction-lint). Model 1 og 2 ville være at betale for features vi ikke bruger.

### Implementerings-flow

1. **Git-sync-connector** (ny F-feature): webhook fra docs-repo → POST til Trail
2. **Source-kind = 'docs-md'**: specifik kind så ingest-promptet behandler markdown-strukturerede docs anderledes end PDFs (preserver headers, bevar code-blocks eksakt, ekstrahér cross-references som backlinks)
3. **Compile-target**: per docs-page → én `/neurons/docs/<slug>` Neuron der består af den LLM-komprimerede "hvad er pointen" + links til kildeplaceringen i rå markdown
4. **Public chat-endpoint**: `POST /api/v1/public/chat/:docsKbId` — anonymt læse-only, rate-limited, CORS-enabled, returnerer svar + citations
5. **Embedding på docs.webhouse.app**: iframe eller React-widget der kalder Trail's chat-API

## llms.txt support (kritisk for LLM-tilgængelighed)

**Hvorfor:** llms.txt er det emergent standard (llmstxt.org, 2024/2025) for at give LLM-klienter en markdown-struktureret oversigt over et sites indhold. Når en AI-agent (Claude Code, ChatGPT med browsing, Cursor, Windsurf) besøger et docs-site, tjekker den først for `/llms.txt` som index og `/llms-full.txt` som fuld korpus — hurtigere og mere præcist end at parse HTML.

### Struktur af llms.txt

Spec'ens format:

```markdown
# Webhouse CMS

> @webhouse/cms er et AI-native headless CMS der compiler indhold
> gennem LLM-pipelines, med statisk-first rendering og Next.js +
> Astro adapters.

## Docs

- [Quick Start](https://docs.webhouse.app/quick-start): Kom i gang på 5 minutter
- [cms.config.ts reference](https://docs.webhouse.app/config): Alle konfigurationsmuligheder
- [AI Lock System](https://docs.webhouse.app/ai-lock): Sådan beskyttes indhold mod LLM-drift
- [Visibility Scoring](https://docs.webhouse.app/visibility-score): F37 scoring-algoritmen
...

## Adapters

- [Next.js](https://docs.webhouse.app/adapters/nextjs): App router + static export
- [Astro](https://docs.webhouse.app/adapters/astro): SSG-native integration

## Optional

- [Changelog](https://docs.webhouse.app/changelog): Release history
- [Migration guides](https://docs.webhouse.app/migrate/v01-to-v02)
```

Dertil `/llms-full.txt` som er **hele docs-korpus** concateneret til ét markdown-dokument. For 173 docs à ~150 ord = ~25.000 ord = ~35.000 tokens. Passer indenfor Claude 200k-context og langt under Haiku 4.5's 200k cap.

### Trail's rolle

Trail skal **generere og servere** llms.txt + llms-full.txt:

**Nye endpoints:**

```
GET /api/v1/public/kb/:kbId/llms.txt         — index (markdown)
GET /api/v1/public/kb/:kbId/llms-full.txt    — fuld korpus (markdown)
```

**llms.txt-generering:**
- Header: `# <KB-navn>` + blockquote med `kb.description`
- Sektioner: grupperet efter `documents.path` (fx `/neurons/adapters/` → "## Adapters")
- Hvert link: `- [<title>](<public-url>): <first-paragraph-of-content>` (trimmed til 200 chars)
- Sortering: alfabetisk per sektion, undtagen "## Optional"-sektioner (changelog, migration guides) som lander sidst

**llms-full.txt-generering:**
- Iteration over alle `kind='wiki'` Neurons, ikke-arkiveret, sorteret per `path` → `filename`
- Hver Neuron indsættes som:
  ```
  ## <title>
  
  _Path: <path>_
  _Updated: <ISO-date>_
  
  <content uden frontmatter>
  ```
- Separator `\n---\n` mellem Neurons
- Cache-Control: `public, max-age=300` (5 min — frisk nok til at AI-agents får opdateringer, cached nok til at CDN ikke druknes)

**Mini-kolonne på documents:**
```sql
ALTER TABLE documents ADD COLUMN public_visibility TEXT
  CHECK(public_visibility IN ('public', 'internal', 'hidden'))
  NOT NULL DEFAULT 'internal';
```

- `public`: inkluderes i `/llms.txt` + `/llms-full.txt` + public-read
- `internal`: kun for authenticated curatorer (default for alle eksisterende rækker)
- `hidden`: vis ikke engang for curator-browsing (draft, archived-pending)

Kurator-UI tilføjer en "Publiceret / Intern / Skjult" switch pr. Neuron i Neuron-editoren.

### llms.txt for Trail selv (dogfood!)

Vi skal også generere `/llms.txt` på **Trail's egne docs** (F-feature-dokumentation under `docs/`). Betyder: når en cc-session eller Cursor-instans vil vide noget om Trail's API, starter den ikke med "søg i repo", men med `curl trail.broberg.dk/llms.txt`.

Forslag til path:
- `https://trail.broberg.dk/llms.txt` — public index
- `https://trail.broberg.dk/llms-full.txt` — alle F-feature-specs + ROADMAP + CLAUDE.md concateneret

Genereres af en simpel bun-script `scripts/build-llms-txt.ts` der læser `docs/FEATURES.md` + alle filer i `docs/features/*.md` og bygger den. Kan køres pre-commit hook eller som del af CI.

## Kunde-features hvis Trail-som-docs-backend sælges

Hvis vi går **Model 3**-vejen og tilbyder det til andre kunder, bliver disse nye SKUs relevante:

| Feature | Del af | Pris-effekt |
|---|---|---|
| Public chat-widget (embed på kundens site) | Pro + | $20/mdr tilkøb ELLER inkluderet over Business |
| llms.txt + llms-full.txt generering | Starter + | inkluderet — det er "gratis" ud fra eksisterende data |
| Git-sync connector | Pro + | del af "Connector pack" eller +$15/mdr separat |
| Named release-tags (v1.2.3 snapshots) | Pro + | inkluderet |
| Version-contradiction-lint (docs X siger A i v1, B i v2) | Business + | del af Business-SLA, ikke splittet |
| Custom domain for public reader (docs.kunden.dk) | Business + | inkluderet |
| SSO gating på "internal" docs | Business + | inkluderet |

## Prerequisites før docs-backend kan sælges

**Tekniske F-features der skal landes:**

1. **F-docs-1 — Public read mode**: `documents.public_visibility` kolonne + anonyme `/api/v1/public/kb/:kbId/...` endpoints. Rate-limited, CORS-enabled. ~3 dage.
2. **F-docs-2 — llms.txt + llms-full.txt generering**: de to nye endpoints beskrevet ovenfor. Cache-headers. ~1 dag.
3. **F-docs-3 — Git-sync connector**: webhook-receiver + `kind='docs-md'` source-handling. Ingest-prompt tilpasset markdown-docs. ~5 dage.
4. **F-docs-4 — Named release-tags**: ny tabel `knowledge_base_releases` med `(kbId, tag, createdAt, documentSnapshotIds[])`. Tag-switcher i public reader. ~3 dage.
5. **F-docs-5 — Chat-widget JS-snippet**: standalone embed der kalder public chat-API, inkluderet i kundens docs-site med én script-tag. ~1 uge.

**Total:** ~3 uger engineering.

## Unit economics for Webhouse's egne docs på Trail

**Antagelser:**
- Trail-KB: 173 docs ingesteret → ~270 Neurons compiled (lavere ratio end Sanne fordi docs-struktur er mere "én source, én pointe")
- Chat-forbrug: ~100 queries/dag på public docs-siden (anslået baseret på typisk docs-trafik × 5 % AI-chat-konverteringsrate)
- LLM-compile køres på hver docs-update: ~10 updates/uge

**Cost breakdown:**

| Post | Månedlig cost |
|---|---:|
| On-mutation contradiction-lint | $4 |
| Ugentlig sampling (270 Neurons, 1 pass) | $3 |
| Chat Q&A (100/dag × $0,01 gns.) | $30 |
| LLM-compile på docs-updates (40/mdr × $0,25) | $10 |
| llms.txt serving (ingen LLM, CDN cache) | $0,50 |
| Infra-share | $2 |
| **∑ Cost** | **~$50/mdr** |

Det matcher **Pro $75/mdr** med sund margin (33 %). Vi dogfooder produktet på os selv og betaler "intern pris" for at drive vores egne docs — symboliserer samtidig noget salg af produktet.

## Tidslinje-forslag

| Uge | Deliverable |
|---|---|
| 1 | F-docs-1 (public read) + F-docs-2 (llms.txt) — minimum viable for **Model 1** embed |
| 2 | F-docs-3 (git-sync) — aktivér **Model 3** for docs.webhouse.app |
| 3 | F-docs-5 (chat-widget) — embed på docs-siten |
| 4 | F-docs-4 (release-tags) — hvis tidstilladelse, ellers skippes til Q3 |
| 5 | Customer discovery: vis docs.webhouse.app's Trail-integration til 10 prospects, få feedback på om det er noget de vil have |

**Beslutnings-punkt efter uge 3:** hvis prospects er lunkne på "docs-backend" pitchen, saml F-docs-3/4/5 som "enterprise embed"-feature kun for Business + kunder. Hvis lun varme, pak det som eget produkt på Pro-tilkøbs-siden.

## Marketing-narrative

"**Vi bruger Trail til vores egne docs.** Besøg docs.webhouse.app og klik på 'Spørg AI' — den kører på Trail. Det samme kan du gøre for dine egne docs på 5 minutter med vores embed-widget."

Det kobler **dogfooding** + **public credibility** + **salesfunnel** i én historie. @webhouse/cms-kunder er sandsynligvis også Trail-kandidater.

## Åbne spørgsmål

1. **Skal Trail-docs-KB'en for webhouse.app være public læsbar for LLM-agents uden authentication?** (ja, det er hele pointen med llms.txt; men vi skal verificere at vi ikke utilsigtet eksponerer intern knowhow)
2. **Skal git-sync køre mod hoveddocs-repo med auto-create af sources, eller skal der være en pre-commit "approve for Trail"-gate?** (default: auto-create, kurator-queue beslutter om Neuron-compile skal bruges)
3. **llms-full.txt cache-TTL**: 5 min er konservativt. 1 time er rimeligere for de fleste docs-sites. Skal konfigureres per-KB.
4. **Rate-limit på public chat**: hvad er en rimelig gratis-kvota før vi beder om sign-up? Foreslag: 10 queries/IP/time, 100/IP/dag.
5. **Hvilken Trail-instans skal drive webhouse-docs — samme som trail-development KB, eller separat multi-tenant setup?** (anbefaling: separat — "webhouse-docs" tenant, ingen spill-over til trail-development)
