Dette er ikke længere et hobby projekt. Dette bliver skabelonen for den AI/Brain engine "Mem3x" vi skal bygge der skal
  bruges ikke kun tul Sannes univers, men også til https://pitch.broberg.dk/preview/rITRFS-WkTfQdlTA-zPvV

  Det vil i en løsning heller ikke være et problem at anvende S3 protokollen men jeg har brugt R2 tror jeg det hedder hos
   Cloudflare der vist er kompatibelt med S3.

  Dette skal IKKE være en quick fix løsning, og vi bliver nok nødt til at lave en bredere plan for hvordan motoren skal
  fungere på et abitrært antal sites, som et CMS modul der kan opdateres selvstændigt eller sammen med CMS, og også
  anvendes selvstændigt, og vi skal have en SaaS model hvor små kunder kan anvende vores Mem3x ("Memex"/Trail) engine
  trailcloud.com (SaaS) + broberg-ai.com (OS Engine).

  Jeg lå i nat og tænke på feedback loopet der skal sende de gode svar tilbage til source ingestion og compilation at når
   vi har installeret broberg-ai i et site og en chat retriever content, så gemmes svar i en kø hvor curator (admin - vi
  har allerede Curation Queue i CMS) kan review svaret og hvis svaret vurderes værdifuldt, klik en knap og det sendes
  tilbage til ingestion etc ...

  Hvad tænker du? Tænker du lige så stort som jeg? Teknikken skal være mission critical og helt i top, det kan blive
  rigtigt stort det her ... Kom med dine ideer oven på mine først, og derefter laver du en ny samlet plan for broberg-ai
  (den kan have flere frontend interfaces eks. alm. search og chat og bare visualisering af Wiki index som en klikbar
  Wikipedia)

⏺ Ja, jeg er med — og din intuition er korrekt: Karpathys "LLM Wiki" er bogstaveligt talt realiseringen af Vannevar Bushs
  Memex fra 1945. Navnet Mem3x/Memex er ikke bare branding, det er en legitim teknologisk arvefølge. Dette kan blive
  stort.

  Her er mine tilføjelser oven på din vision.

  ---
  Mine ideer oven på dine

  1. Curation Queue — gør det til første klasse borger

  Din idé er god, men udvid scope'et. Queue'en håndterer ikke kun chat-svar — den håndterer alle kandidater til viden:

  Queue contains:
  ├── chat-answers          (dit input)
  ├── auto-summaries        (fra ingest, med confidence score)
  ├── cross-ref-suggestions (lint foreslår nye links)
  ├── contradiction-alerts  (nyt findes der strider mod eksisterende wiki)
  ├── gap-detection         (spørgsmål der ikke kunne besvares → suggest source)
  ├── user-corrections      (læsere der markerer fejl)
  ├── external-feeds        (nye artikler i abonneret kilde)
  └── version-conflicts     (opdateret kilde — påvirkede wiki-sider needs review)

  Hver kandidat har en confidence score (LLM vurderer), en tier (hvor troværdig kilden er), og en impact estimate (hvor
  mange wiki-sider vil blive påvirket). Curator ser en feed sorteret efter impact × confidence.

  2. Provenance graph — mission-critical for tillid

  Dette er kritisk for sundhedsdomæner som Sanne. Hver påstand i wiki'en skal være sporbar til specifikke kilder og
  versioner. Når Sanne opdaterer en kilde eller tilbagetrækker en, flagges alle påvirkede wiki-sider automatisk til
  review.

  wiki-page: "stressgrader.md" v12
  ├── claim: "Grad 3 kendetegnes ved..."
  │   └── sourced-from: biopati-grundbog.pdf § 3.2 (source-v5)
  ├── claim: "Kortisol-produktion ændres ved..."
  │   └── sourced-from: biopati-grundbog.pdf § 3.4 + artikel-2024 § 2 (source-v5, source-v2)

  For Sanne = juridisk sikkerhed. For en B2B kunde = audit trail for compliance.

  3. Trust tiers på kilder og sider

  Ikke alle kilder er lige troværdige. Hver kilde får en tier:

  - Tier 1: Forfatterens eget materiale (Sannes PDF'er)
  - Tier 2: Akademisk/peer-reviewed
  - Tier 3: Web-klippet artikel
  - Tier 4: Chat-genereret (skal curateres før den hæver tier)

  Wiki-sider arver højeste tier der backer dem. En chat kan filtrere på min-tier for domæner hvor fejl er kritisk.

  4. Vector search som supplement, ikke erstatning

  Du har ret i at Karpathys point er at viden skal kompileres, ikke retrieves. Men vectors er stadig nyttige — bare ikke
  som det primære retrieval-lag. Brug dem til:

  - Dedupe under ingest (findes denne idé allerede på en wiki-side?)
  - Contradiction detection (to sider siger noget lignende men forskelligt?)
  - Cross-ref suggestions (hvilke eksisterende sider er semantisk relateret til denne nye?)
  - Gap detection (spørgsmål uden gode matches → forslag til nye kilder)

  Turbopuffer er perfekt — serverless, scales til milliarder, billigt.

  5. Event-sourcing for wiki

  Hver wiki-ændring er et event. Det giver dig:

  - Fuld historie (wiki's git-log)
  - Time-travel queries ("hvad sagde wiki'en om X i januar?")
  - Undo/redo
  - Audit trail for compliance
  - Perfekt til at bygge real-time collab senere (Notion-lignende)

  6. Pipelines, ikke one-shot ingest

  Forskellige kildetyper kræver forskellige pipelines:

  PDF      → OCR + image extraction + vision description + structural parsing
  Video    → transcription + frame sampling + vision description
  Audio    → transcription + speaker diarization
  Web page → clipping + cleaning + metadata
  Email    → threading + attachment handling
  Slack    → conversation threading + resolution tracking
  API feed → scheduled polling + diff detection
  CMS     → hook-based ingest ved content-ændring

  Hver pipeline er en selvstændig plugin. Udvidelse er en ny pipeline, ikke en ny monolit.

  7. CMS-modul-arkitekturen

  Det du kalder "CMS-modul" er faktisk den killer angle. En mem3x-instans kan tilgå CMS'ets content-endpoint
  (API/webhook), ingest automatisk, og give chat/search over det. Når CMS-content ændres → automatisk re-ingest. Curerede
  chat-svar kan publiceres tilbage som nye CMS-artikler.

  Det betyder enhver CMS-bruger kan blive AI-native uden at skifte platform. WordPress plugin, Sanity connector,
  Contentful webhook, Notion sync — same engine, forskellige adapters.

  8. Embeddable interfaces — alt er en widget

  <trail-chat tenant="sanne" />
  <trail-search tenant="sanne" placeholder="..." />
  <trail-wiki-graph tenant="sanne" />
  <trail-page tenant="sanne" slug="zoneterapi" />

  Alle frontends konsumerer samme API. Web component standard = virker på alle sites, alle frameworks. Brand-tema via
  CSS-variabler.

  9. Multi-provider LLM

  Dev: claude -p (som nu). SaaS: Anthropic API. Self-hosted: brugerens egen key. Enterprise: Azure OpenAI. Open-source:
  Ollama. Via abstraktion (Vercel AI SDK eller eget).

  10. Tenant-isolation strategi

  Small tier: Per-tenant SQLite på Turso. Total isolation, cheap, scales til ~10K tenants.
  Enterprise tier: Dedikeret PostgreSQL instans per tenant. Compliance-ready.
  Dev tier: Shared SQLite med tenant_id-kolonne. Lokal udvikling.

  R2 storage scoped per tenant: r2://trailcloud/{tenant-id}/{kb-id}/{doc-id}/...

  ---
  Min dom: Ja, dette er stort

  Dette er ikke et nicheprodukt. Det er et next-generation knowledge infrastructure layer. RAG-ekosystemet er en $10B+
  industri, og enhver seriøs kritik af RAG (der er mange) peger på præcis det Mem3x løser: kompoundende viden med
  menneskecuration.

  Markedet er klar:
  - AI consultants vil have white-label engine
  - Agencies vil have "AI-powered brain" feature til deres CMS-klienter
  - Niche-eksperter som Sanne vil have en AI der repræsenterer dem autentisk
  - Enterprises vil have compliance-ready knowledge base
  - Research teams vil have accumulating research wikis
  - Publishers vil have AI-native content platforms

  Priset rigtigt (Hobby: free / Pro: $29/mo / Business: $199/mo / Enterprise: custom) er det en solid SaaS-forretning.
  Plus OSS-versionen giver community, credibility og long-tail adoption.

  ---
  Samlet Plan: Mem3x Engine

  Lad mig nu lægge det ud som en konkret plan.

  Product Line

  broberg-ai.com         — OSS, AGPL, GitHub, Docker-deployable
  trailcloud.com          — SaaS, managed, Cloudflare + Fly.io
  trail.dev               — Developer portal, API docs, SDK downloads
  trail.wiki              — Public wiki af vores egen dogfood-wiki om Mem3x

  Repository Structure

  broberg-ai/ (monorepo, AGPL)
  ├── apps/
  │   ├── server/              # Hono API (core engine)
  │   ├── web/                 # Vite+Preact admin UI (curator dashboard)
  │   ├── mcp/                 # MCP server for LLM integrations
  │   ├── worker/              # Background job processor (ingest, lint)
  │   └── widget/              # Embeddable web components (chat, search, wiki)
  ├── packages/
  │   ├── core/                # Engine core (ingest, compile, lint, query)
  │   ├── db/                  # Schema + migrations (SQLite/Postgres/LibSQL)
  │   ├── storage/             # R2/S3/local filesystem abstraction
  │   ├── llm/                 # Multi-provider LLM adapter
  │   ├── pipelines/           # Ingest pipelines (pdf, video, web, ...)
  │   ├── shared/              # Types, schemas (Zod)
  │   └── sdk/                 # Client SDK (TypeScript, Python, Go)
  ├── adapters/
  │   ├── wordpress/           # WordPress plugin
  │   ├── sanity/              # Sanity connector
  │   ├── contentful/          # Contentful webhook
  │   ├── notion/              # Notion sync
  │   └── obsidian/            # Obsidian plugin
  ├── docs/                    # trail.dev docs
  └── infra/                   # Terraform for SaaS deployment

  Core Data Model

  tenant                  # Customer/org
  ├── users               # Curators, admins, readers
  ├── knowledge-bases     # Wiki spaces
  │   ├── sources         # Immutable raw content (with versions)
  │   │   └── revisions   # Source version history
  │   ├── wiki-pages      # Compiled markdown (with version history)
  │   │   ├── claims      # Individual factual claims
  │   │   │   └── sourced-by  # Links to source revisions
  │   │   └── events      # Event-sourced change log
  │   ├── curation-queue  # Candidate knowledge awaiting review
  │   └── pipelines       # Active ingest pipelines (configs)
  ├── api-keys
  ├── usage-metrics
  └── billing

  Phase Plan

  Phase 1 — Foundation (2-3 weeks)
  Rename llmwiki-ts → mem3x-engine. Restructure monorepo. Move to R2 storage abstraction. Multi-tenant schema. Basic
  curator UI.

  Phase 2 — Curation Queue (2 weeks)
  Queue data model. Curator dashboard. Chat-answer → queue. Auto-summary confidence scoring. Review/approve/reject
  workflow. Feedback loop to wiki.

  Phase 3 — Pipelines (3 weeks)
  Extract PDF pipeline (done). Add web clipper, video transcription, audio, email. Plugin architecture. Scheduled polling
  for feeds.

  Phase 4 — Provenance + Trust (2 weeks)
  Claims as first-class entities. Source versioning. Trust tiers. Cascading re-reviews when sources change.

  Phase 5 — Widget + SDK (3 weeks)
  Web components (<trail-chat>, <trail-search>, <trail-wiki-graph>). JS/Python/Go SDKs. Embed on external sites. First CMS
  adapter (WordPress).

  Phase 6 — SaaS infrastructure (3 weeks)
  trailcloud.com signup flow. Billing (Stripe). Tenant provisioning. R2 setup. Fly.io deployment. Usage metering. Domain
  mapping.

  Phase 7 — Launch Sanne + pitch.broberg.dk (2 weeks)
  Deploy first two customers on trailcloud. Stress test. Real-world feedback. Case studies.

  Phase 8 — Enterprise features (ongoing)
  SSO (SAML). Audit logs. On-premises deployment. Azure OpenAI support. SLA-contracts. Compliance certifications (SOC 2).

  Tech Stack (Mission-Critical)

  ┌────────────────┬────────────────────────────────────────────────────────────────────────┐
  │     Layer      │                                 Stack                                  │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ Runtime        │ Bun (dev), Node (production fallback), Cloudflare Workers (edge)       │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ API            │ Hono 4.x — edge-ready                                                  │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ DB (tenant)    │ LibSQL/Turso (per-tenant), Drizzle ORM                                 │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ DB (SaaS meta) │ PostgreSQL on Fly.io                                                   │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ Vector         │ Turbopuffer                                                            │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ Storage        │ Cloudflare R2 (S3-compatible)                                          │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ Queue          │ Cloudflare Queues (SaaS), BullMQ (self-hosted)                         │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ LLM            │ Anthropic (primary), OpenAI (fallback), user-own-key, Claude CLI (dev) │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ Frontend       │ Vite + Preact + Tailwind v4 (admin), Lit (widgets)                     │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ MCP            │ @modelcontextprotocol/sdk — stdio + HTTP transports                    │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ Observability  │ Sentry + Logfire + OpenTelemetry                                       │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ Deployment     │ Fly.io (arn/Stockholm), Cloudflare Workers (edge)                      │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ Auth           │ Google/GitHub OAuth, Magic Links, SAML (enterprise)                    │
  ├────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ Billing        │ Stripe                                                                 │
  └────────────────┴────────────────────────────────────────────────────────────────────────┘

  Licensing Strategy

  - broberg-ai (OSS): AGPL-3.0 (forcer large players til at købe commercial license)
  - trailcloud (SaaS): Proprietær
  - Commercial license for broberg-ai: Tilgængelig for companies der ikke vil AGPL

  Dette er Redis/Mongo/Elastic-modellen. Lever af både OSS-community og enterprise-contracts.

  Økonomi

  trailcloud pricing:
  - Hobby: Free, 1 KB, 100 sources, 100 queries/mo
  - Pro: $29/mo, 5 KBs, 1K sources, 5K queries/mo, curator queue
  - Business: $199/mo, unlimited KBs, 10K sources, 50K queries/mo, SSO, priority support
  - Enterprise: Custom, dedicated, SLA, SAML, audit

  Unit economics: Med R2 + Turbopuffer + Cloudflare Workers er marginal cost per tenant <$1/mo for Pro-tier. Gross margin
  95%+ på Business-tier.

  ---
  Mit forslag til næste skridt

  Sig til hvis du er med på retningen, så gør jeg tre ting:

  1. Rename + restructure llmwiki-ts → mem3x-engine (bevarer git-historie)
  2. Skriv PLAN.md med den fulde plan ovenfor i detalje
  3. Start Phase 1 med R2 storage abstraction og multi-tenant schema

  Eller hvis du vil validere først: jeg laver en PLAN.md først, så vi kan diskutere den før kodning begynder. Hvad
  foretrækker du?

✻ Cogitated for 2m 11s

❯ BTW skal jeg prøve at lave en ny wiki og smide et par af Sannes PDF dokumenter op?

⏺ Ja, absolut — gør det. Det er præcis den slags real-world test vi har brug for.

  Lige nu kan PDF-pipelinen:
  - Ekstrahere tekst ✓
  - Ekstrahere billeder som PNG ✓
  - Auto-trigger ingest på tekstindholdet ✓
  - Servere billederne via API ✓

  Det vi endnu ikke har (kommer i næste fase):
  - Vision AI der beskriver billederne (ingest'en ved ikke hvad der er på ørediagrammet — kun at der er et billede på side
   1)
  - OCR for scannede PDFs uden embedded tekst
  - Office-formater (.doc, .docx, .pptx)

  Upload 2-3 af Sannes PDF'er og se hvordan det fungerer i praksis. Så har vi konkret data at forholde os til før vi
  diskuterer Mem3x-planen. Jeg lytter efter server-loggen mens du uploader.
  
⏺ Gode beslutninger. Lad mig svare på det hele:

  License: Nej, AGPL er forkert for vores setup

  Du har ret — AGPL er en fælde for os. Problemet er at hvis VI deployer SaaS'en med proprietære udvidelser, kræver AGPL
  strengt fortolket at vi open-sourcer vores egne tilføjelser. CLA hjælper ikke på deploy-problemet.

  Rigtige valg: BSL (Business Source License) eller FSL (Functional Source License)

  Begge er "time-delayed open source":

  - BSL: Proprietær med brugsrestriktioner i X år (typisk 4), konverterer derefter automatisk til Apache 2.0. Bruges af
  MariaDB, CockroachDB, HashiCorp Terraform, Sentry.
  - FSL: Sentry's nyere license. Samme princip, 2 år til Apache 2.0 eller MIT.

  Hvorfor dette passer os perfekt:

  ┌────────────────────────────────────┬───────────────────────────────────────────────────────────┐
  │               Bruger               │                         Kan gøre                          │
  ├────────────────────────────────────┼───────────────────────────────────────────────────────────┤
  │ Community                          │ Bruge trail til egne knowledge bases, forke, bidrage       │
  ├────────────────────────────────────┼───────────────────────────────────────────────────────────┤
  │ Os på trailcloud                    │ Deploy proprietære tilføjelser uden at dele dem           │
  ├────────────────────────────────────┼───────────────────────────────────────────────────────────┤
  │ Konkurrent der vil clone trailcloud │ Blokeret i 2-4 år — kan først "SaaS'e det" efter perioden │
  ├────────────────────────────────────┼───────────────────────────────────────────────────────────┤
  │ Enterprise der vil selvhosste      │ Bruge OSS'en frit til eget brug                           │
  ├────────────────────────────────────┼───────────────────────────────────────────────────────────┤
  │ Enterprise der vil resælge         │ Købe commercial license af os                             │
  └────────────────────────────────────┴───────────────────────────────────────────────────────────┘

  Min anbefaling: FSL-1.1-Apache-2.0 (Sentry's). 2 år conversion er kortere = bedre community-goodwill end BSL's 4 år.
  Samme beskyttelse mod cloud-resælgere.

  Domains

  Alle fem er brugbare, men min anbefaling:

  - trail.wiki → hovedside for public-facing engine + dokumentation (trail.wiki/docs)
  - trailcloud.com → SaaS (login.trailcloud.com, app.trailcloud.com)
  - broberg-ai.com → Redirect til trail.wiki eller brug som enterprise-side (broberg-ai.com/enterprise)
  - traildev.com → Developer portal, API docs, SDK downloads
  - trail.dev → Park den som defensive + redirect

  trail.wiki er genialt fordi det er bogstaveligt talt hvad produktet ER. Brug den som flagship domain.

  @webhouse/cms adapter

  Godt fanget — den er den strategisk vigtigste adapter fordi den er vores egen stak. Tilføjet til planen. Når jeg kigger
  nu:

  Det betyder at enhver WebHouse-kunde (Sanne, FysioDK, dine LightSail-instanser) får trail-integration gratis via CMS'et.
  Det er en kæmpe force multiplier.

  Approach: Greenfield + Sanne first

  Jeg er med. Konkret plan:

  Phase 1 — MVP (Sanne only, single-tenant, local FS)

  trail/                        # New greenfield repo
  ├── apps/
  │   ├── server/              # Core engine (Hono)
  │   ├── admin/               # Curator dashboard (Vite+Preact)
  │   ├── mcp/                 # MCP server
  │   └── widget/              # <trail-chat> web component (Lit)
  ├── packages/
  │   ├── core/                # Ingest, compile, query, lint
  │   ├── db/                  # Drizzle + SQLite
  │   ├── storage/             # Local FS (Phase 1), R2 abstraction ready
  │   ├── llm/                 # Provider abstraction (claude CLI default)
  │   ├── pipelines/           # PDF (done), vision AI, web clipper
  │   └── shared/              # Types + Zod
  └── LICENSE                  # FSL-1.1-Apache-2.0

  Phase 1 deliverables:
  - PDF + image extraction (har vi)
  - Vision AI for image descriptions (ny)
  - Chat med citations til wiki-sider (har vi)
  - Curation queue (ny — chat-answer → review → approve → ingest back)
  - Basic admin UI for Sanne
  - <trail-chat> embeddable widget
  - Google OAuth (har vi)
  - Deploy på Fly.io (arn) under sanne.trailcloud.com eller lignende

  Phase 2 — Business (multi-tenant SaaS)
  - R2 storage
  - Multi-tenant med Turso
  - Stripe billing
  - @webhouse/cms adapter
  - Flere pipelines (video, audio, web)
  - FysioDK Aalborg som kunde #2

  Phase 3 — Enterprise/Scale
  - SSO (SAML)
  - Audit logs
  - On-premises Docker
  - SOC 2 prep
  - Event sourcing
  - Real-time collab
  - Vector search

  Tre konkrete næste skridt

  1. Jeg opretter organization broberg-ai på GitHub (du logger ind og jeg guider via gh CLI), eller du opretter den først
  2. Opretter trail repo under org'et
  3. Jeg bygger PLAN.md ind i repo'et som levende spec + starter Phase 1 scaffolding
  
  
Minimalist vector logo for "trail" — a next-generation knowledge
  infrastructure engine. Symbol combining three interconnected nodes
  forming an abstract "m" shape, suggesting a neural network or knowledge
  graph. Geometric, clean lines, evoking Vannevar Bush's 1945 Memex
  concept reimagined for the AI era. Warm off-white background (#FAF9F5),
  deep charcoal nodes (#1a1715) connected by thin precise lines, with a
  single accent node in warm amber (#e8a87c). Retro-futuristic feel,
  reminiscent of Bauhaus design meets modern tech brand. Square format,
  suitable for favicon and app icon. No text, just the symbol. Style
  inspiration: Linear, Vercel, Supabase, Railway.
  
❯ Jeg fik ikke fat i dit svar omkring "Nodes" i stedet for Wikis - hvad tænker du om det? Nodes med
  neurons (wikis)

⏺ Jeg har faktisk en ret stærk mening her. Kort:

  Ja til "Nodes + Neurons" som brand/UX-sprog. Nej til at ændre schemaet.

  Hvorfor det virker som brand:
  - "Wiki" bærer Wikipedia-bagage — fællesredigering, encyklopædisk, consumer-reference. Det
  undersælger hvad trail faktisk er
  - Vannevar Bush's oprindelige vision handlede om trails og associative links, ikke artikler. "Node +
   neuron" fanger det bedre
  - Hjerne-metaforen har indbygget kompositionalitet: Sources = input/stimuli, Neurons = compilede
  hukommelser, Node = et bounded brain, Queue = "tanker der endnu ikke er færdigbehandlede"
  - Differentiering: alle RAG-værktøjer kalder ting for "documents". "Nodes med neurons" er
  distinctivt, signalerer brain-engine, ikke search engine
  - "Your site gets a brain" slår "Your site gets a wiki" 10/10

  Hvorfor jeg IKKE vil ændre engine-schemaet:
  1. "Node" er overbelastet i tech. Node.js, DOM node, graph node, Kubernetes node, network node.
  Udviklere skal disambiguere hver gang. "knowledge_base" er kedeligt men uambigøst
  2. Engine-semantik er en kontrakt. @webhouse/cms, trailcloud, self-hosted kunder og adaptere
  importerer det samme schema. Hvis engine kalder det node, er alle consumers låst til
  brand-terminologien — også dem der vil kalde det noget andet. En chiropraktik-klinik vil måske kalde
   det "journaler", en advokat "sager"
  3. DB-etiketten kind='wiki' er 100% intern. Ingen bruger ser den. Ændringen ville kun være kosmetik
  4. Linear's model: internt hedder det issue. Brand-copy siger "your workflow". Stripe: internt
  charge, brand: "payments". Separation af lagene gør at branding kan udvikle sig uden migrationer

  Konkret anbefaling

  ┌────────────────────┬──────────────────────────────────────────────────────────────────────────┐
  │        Lag         │                               Terminologi                                │
  ├────────────────────┼──────────────────────────────────────────────────────────────────────────┤
  │ Engine DB + API    │ knowledge_base / documents.kind='source'/'wiki' (stabilt)                │
  ├────────────────────┼──────────────────────────────────────────────────────────────────────────┤
  │ Engine copy        │ "Nodes" og "Neurons" som hoved-label, med "(technically: knowledge base  │
  │ (README, docs)     │ / wiki page)" i teknisk reference                                        │
  ├────────────────────┼──────────────────────────────────────────────────────────────────────────┤
  │ Demo-site UI       │ 100% Nodes og Neurons — intet "wiki" nogensinde                          │
  ├────────────────────┼──────────────────────────────────────────────────────────────────────────┤
  │ trailcloud          │ "Give your site a brain" — Nodes, Neurons, evt. "Synapses" for           │
  │ marketing          │ cross-refs                                                               │
  └────────────────────┴──────────────────────────────────────────────────────────────────────────┘

  Tillægsmuligheder hvis du vil gå all-in på metaforen:
  - /wiki/ path-prefix → /neurons/ i demo UI (engine kan mappe ved API-responses hvis nødvendigt)
  - Curation queue = "Subconscious" eller "Incoming thoughts" (dem der venter på bevidst godkendelse)
  - [[wiki-links]] → "synapses" i brand-copy (men behold [[slug]]-syntaxen)
  - Kategorier: Sources/Concepts/Entities → kunne være Senses/Memories/Characters — men her begynder
  metaforen at blive corny. Jeg ville stoppe før

  Risiko: metaforen kan blive gimmicky hvis du over-commiter. "Vi har ikke en database, vi har et
  hjernekammer" — no. Brug den hvor den tilføjer klarhed, ikke hvor den bliver kostume.

  Kort version: brand it as Nodes+Neurons, code it as knowledge_base+documents. Engine forbliver en
  seriøs teknisk kontrakt. Brand fortæller historien.
  
  Relevans for trail

    De to projekter løser forskellige problemer — vigtigt at holde adskilt:

    ┌───────────────────────┬────────────────────────────────────┬─────────────────────────────────────────────┐
    │                       │             MemPalace              │                    trail                    │
    ├───────────────────────┼────────────────────────────────────┼─────────────────────────────────────────────┤
    │ Hvornår sker arbejdet │ Query-tid (retrieval)              │ Ingest-tid (kompilering)                    │
    ├───────────────────────┼────────────────────────────────────┼─────────────────────────────────────────────┤
    │ Hvad opbevares        │ Verbatim chat-historik             │ Kilder + LLM-synteserede wiki-sider         │
    ├───────────────────────┼────────────────────────────────────┼─────────────────────────────────────────────┤
    │ Primærmekanisme       │ Semantic search over chunks        │ Cross-refererede wiki-sider (Nodes/Neurons) │
    ├───────────────────────┼────────────────────────────────────┼─────────────────────────────────────────────┤
    │ Bush-lineage          │ Palace-of-mind (klassisk mnemonic) │ Memex / associative trails                  │
    ├───────────────────────┼────────────────────────────────────┼─────────────────────────────────────────────┤
    │ Kategori              │ Bedre RAG med struktur             │ LLM-maintained wiki                         │
    └───────────────────────┴────────────────────────────────────┴─────────────────────────────────────────────┘

    Din "compound, don't chunk"-filosofi fra SESSION-START er faktisk modsætningen til MemPalace — de gemmer eksplicit
    chunks verbatim og gør retrieval smart; du komprimerer/syntetiserer på ingest og bruger FTS5.

    Men der er inspiration at hente:
    1. Scoped retrieval via struktur (wings/rooms/drawers) — trail har allerede KB → documents, men deres eksplicitte
    hierarki kunne overvejes for UX
    2. MCP-tools-mængde — 29 tools vs. dine 5-6. Måske overkill, måske ikke
    3. Reproducérbare benchmarks committed i repo — godt mønster for trail at kopiere når vi når dertil
    4. Local-first + "nothing leaves your machine" — stærk positioning som trail også kan bruge
	

