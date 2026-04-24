# Trail — Hvorfor en Hjerne I Stedet For En Fil

> En oprindelses-historie om et memex-inspireret videns-infrastruktur-projekt bygget i Aalborg 2026. Skrevet til både at tjene som reference-kilde for Trail's egne ingest-tests OG som grundtekst til landingssidens "Om Trail"-sektion.

## Drømmen fra 1945 — Memex

I juli 1945 publicerede den amerikanske ingeniør **Vannevar Bush** artiklen *As We May Think* i The Atlantic. Bush havde netop ledet koordineringen af 6000 amerikanske forskere under Anden Verdenskrig, og han så klart at det største problem efter krigen ikke ville være *at producere viden* — det ville være *at finde igen hvad man allerede havde lært*.

Hans løsning var **Memex** (memory-extender): et mekanisk skrivebord med mikrofilm-arkiv, hvor læseren kunne følge associative trails — spor af forbundne dokumenter — fra ét emne til et andet. "Associative trails" gav Trail sit navn halvfjerds år senere.

Memex blev aldrig bygget. Men konceptet inspirerede både hypertext, World Wide Web, og — i tech-bobblen omkring 2020 — en bølge af personlige videnssystemer: Obsidian, Roam Research, Logseq, Notion.

## LLM Wiki — Karpathys Revival (2026)

I marts 2026 publicerede **Andrej Karpathy** en Medium-artikel med titlen *The LLM Wiki*. Hans observation var enkel: store sprogmodeller havde gjort det trivielt at *generere* tekst, men ikke at *kuratere hvad der huskes*. Karpathy foreslog en simpel kontrakt: kilder gennemgår en LLM-drevet "compile"-fase der producerer en wiki — et netværk af sammenkoblede sider — snarere end at arkivere kilden ordret.

Det var første gang nogen klart artikulerede forskellen mellem **verbatim memory** (gem teksten) og **compile-at-ingest** (udled koncepterne, bevar kilde-referencen). Trail følger Karpathy's mønster direkte.

Se også [[LLM Wiki (Karpathy)]] og [[Memex]] for relaterede idéer.

## Compile-at-ingest: Trail's Kerne-filosofi

Når en kilde uploades til Trail, sker der ikke blot at teksten gemmes. En **Claude Code**-subprocess kører en ingest-prompt der:

1. Læser kilden (`read`)
2. Undersøger eksisterende wiki-struktur (`search`)
3. Udleder 2-5 nøglekoncepter
4. Skriver hver som en [[Neuron]] i `/neurons/concepts/`
5. Wrapper enhver navngiven person eller organisation i [[wiki-links]]
6. Logger ingesten

Resultatet er ikke en dump af kilden — det er et *destillat*. Den oprindelige PDF, DOCX eller Markdown-fil gemmes stadig som Source, men curator'en og Trail's retrieval-lag arbejder primært med de kompilerede Neuroner.

## Neuron som atomen

En **Neuron** er Trail's grundenhed. Det er en markdown-fil med YAML-frontmatter (`title`, `tags`, `date`, `sources`), et brødtekst-afsnit, og kontekstuelle wiki-links til andre Neuroner. Hver Neuron har:

- Et deterministisk filnavn (slugified title)
- En stabil per-KB sekvens-ID (kbPrefix-underscore-8-cifret sekvens, se [[Per-KB Sekvens-ID]])
- Typed edges til andre Neuroner (7 gyldige typer: cites, is-a, part-of, contradicts, supersedes, example-of, caused-by)
- Et confidence-felt der henfalder over tid ved inaktivitet

En Neuron er et knowledge-atom. [[Knowledge Base]] er en samling af Neuroner — én [[Trail]] ejer mange knowledge-baser, og hver KB ejer tusindvis af Neuroner.

## Curator-rollen

Trail's vigtigste arkitektoniske beslutning er at **ingen Neuron skrives direkte til wiki'en**. Alt flyder gennem en **Curation Queue** hvor en menneskelig curator godkender, afviser eller omskriver kandidater foreslået af enten LLM'en under ingest, lint-detektorer, chat-interaktioner, eller eksterne connectors (web clipper, MCP-servere, Slack-bots).

Det lyder som friktion, men det er pointe: curator'en er den eneste der kan afgøre om to koncepter skal flettes, om en foreslået tag-rename er rigtig, eller om en kontradiktion mellem to kilder skal markeres. LLM'er er svage til den type skøn.

## Christian Broberg & WebHouse

Trail blev født i **WebHouse ApS** i Aalborg, grundlagt af **Christian Broberg** i 1995. WebHouse driver et porteføljeselskab af SaaS-produkter inklusive codepromptmaker.com (CPM), Apple Music MCP, og DNS Manager — hver af dem løser et smalt problem tæt ved Christian's daglige arbejde som software-arkitekt.

Trail adskiller sig fra det portfolio ved at være det første produkt bevidst designet til også at kunne køre hos eksterne kunder. Fase 1 er single-tenant MVP; Fase 2 er multi-tenant SaaS på `app.trailmem.com`; Fase 3 er enterprise med on-prem-option.

## Kunde #1: Sanne Andersen

Trail's første betalende kunde er **Sanne Andersen**, en healer og zoneterapeut fra Aalborg med 25 års klinisk materiale — kursusnoter, behandlingsprotokoller, kundehistorier — i Word-dokumenter, PDF'er og håndskrevne noter. Hendes spørgsmål var: *"Kan du gøre det til noget jeg kan spørge ind til på dansk?"*

Sanne's KB er blevet reference-workload for Trail. Hver arkitektonisk beslutning testes først på hende. Hvis Trail ikke virker for en enkelt terapeut der vil have sine egne noter tilbage på dansk — virker Trail ikke.

## Den Tekniske Stak

Trail er bygget på en bevidst let stack:

- **Bun** som runtime — hurtig kold-start, indbygget TypeScript, ingen bundler-trin
- **Hono** som HTTP-framework (4.6) — tynd og hurtig, ingen magi
- **libSQL** embedded (Turso's SQLite-fork) — én fil pr. tenant, FTS5 full-text search, WAL-journaling
- **Preact** + Vite som admin-UI — 30KB bundle, hook-kompatibelt med React-økosystemet
- **Claude Code** CLI som ingest-subprocess — subprocess-isolation gør at compile-fejl ikke crasher serveren
- **Drizzle ORM** til type-safe queries over libSQL

Alle seks er single-file-dependencies der kan skiftes ud hvis bedre alternativer dukker op. Vi bundler ikke teknisk gæld ind i stakken.

## Tre Faser Til SaaS

Trail ship'es i tre faser, hver uafhængigt deployerbar:

**Fase 1 — MVP** (2026-04): Single-tenant, Christian og Sanne som eneste brugere. Alt kører lokalt hos Christian, database på Fly.io arn-region i Stockholm. Fase 1 beviser at kompilerings-pipelinen virker på ægte indhold.

**Fase 2 — Business SaaS** (2026-Q3): Multi-tenant på `app.trailmem.com`. Tenant-provisioning, Stripe-billing, Cloudflare R2 storage, custom subdomains. Phase 2 beviser at Trail kan betjene mange kunder samtidigt.

**Fase 3 — Enterprise** (2027+): On-prem option, SAML SSO, audit log, dedikerede clusters. Phase 3 beviser at Trail kan leve i regulerede branches som healthcare og legal.

Se [[Trail Roadmap]] for den fulde F-nummererede liste.

## Hvad Gør Trail Anderledes?

Der findes hundrede knowledge-management-værktøjer. Hvorfor bygge endnu et?

Svaret ligger i **compile-at-ingest**-kontrakten. Obsidian, Roam og Notion er note-taking-værktøjer — de hjælper dig med at *skrive* noter. De har tilføjet AI-assistenter ovenpå, men AI'en rører ikke den underliggende struktur. Trail vender det om: AI er *ingest*-laget; kurateringen er menneskelig; det endelige produkt er en wiki der er læsbar for både mennesker og andre LLM'er via MCP.

Det betyder at Trail's output er *compoundable* — flere kilder → samme wiki → smartere retrieval → bedre chat → flere kilder. Jo mere du putter ind, jo bedre bliver det. Det er ikke tilfældet for verbatim-memory-systemer hvor flere kilder blot øger støjen.

## Vejen Fremad

Trail har 152 F-nummererede features som jeg skriver dette. Næste leveringer er:

- [[F148]] — Link Integrity (ingen 404-fejl i hjernen)
- [[F149]] — Pluggable Ingest Backends (OpenRouter-fallback-chain)
- [[F150]] — admin-UI til broken-links, bygger ovenpå F148
- [[F151]] — cost & quality dashboard, bygger ovenpå F149
- [[F152]] — runtime model-dropdown, supersedes manual env-baseret model-switch

Ingen af dem vil være synlige for Sanne — hun bruger Trail gennem admin-UI'et uden at tænke på hvilken model der kompilerer hendes kilder. Det er hele pointen. Infrastruktur skal være usynlig når den virker.

---

*Denne fil er både en reference-kilde for Trail's ingest-tests (se `ingest-reference.ground-truth.json` for forventede aggregater) og en udkast-tekst til `trailmem.com`s "Om Trail"-sektion. Fortsat redigering velkomment.*
