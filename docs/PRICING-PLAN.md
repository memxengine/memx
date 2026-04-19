# Prissætnings-plan

*Tillæg til `SCALING-ANALYSIS.md`. Skrevet 2026-04-19. Definerer tiers, tilkøb, unit-economics, og beslutninger der skal lande før planen kan rulles ud.*

## Executive summary

Fem tiers: **Free / Starter / Pro / Business / Enterprise**. Pro har **modulære tilkøb** i stedet for en eller flere mellem-tiers. Multi-KB strategi opfordrer brugere til at opdele deres vidensbase i emne-adskilte sub-Trails, hvilket både løser contradiction-scan-skalering arkitektonisk og er psykologisk en naturlig upgrade-nudge.

**Kerne-beslutninger:**
- Ingen "Pro Extended" eller lignende mellem-tier. Pro rummer kunder fra $75 til ~$420/mdr via tilkøb.
- Pro→Business springet er bevidst: $999 skal repræsentere noget **kvalitativt** anderledes (SLA, dedicated infra, priority ingest), ikke bare "mere af det samme".
- Hobby er renamed til **Starter** og flyttet fra $15 → $20 for professionel branding + headroom til månedlig fuld-backfill-feature.

## Tier-oversigt

| Tier | Pris/mdr | Neurons | KBs | Parallelisme | Kontra-strategi | Support |
|---|---:|---:|---:|:---:|---|---|
| **Free** | $0 | 50 | 1 | P=1 | — | community |
| **Starter** | $20 | 500 | 1 | P=1 | on-mutation + månedlig backfill | email 72t |
| **Pro** | $75 | 5.000 | 3 | P=2 | + ugentlig sampling | email 48t |
| **Pro (max add-ons)** | $420 | 20.000 | 11 | P=4 | daglig sampling + priority ingest | email 48t |
| **Business** | $999 | 50.000 | 10 | P=4 | daglig sampling | SLA + 24t |
| **Enterprise** | $2.500+ | ∞ | ∞ | P=8+ | custom | dedicated |

### Pro tilkøb (modulær skalering)

Stackable add-ons oven på Pro base $75:

| Tilkøb | Pris/mdr | Giver | Max stack | Margin |
|---|---:|---|---:|---:|
| Neurons pack | $25 | +2.500 Neurons | ×6 (+15.000) | 80 % |
| Trails pack | $15 | +2 Trails m. egen Neuron-kvota | ×4 (+8) | 93 % |
| Parallel boost | $30 | +1 contradiction-worker (P=2 → P=4) | ×2 | 83 % |
| Daily sampling | $40 | Ugentlig → daglig fuld-sampling | ×1 | 50 % |
| Priority ingest lane | $20 | Egen ingest-kø (ellers delt) | ×1 | 90 % |
| Connector pack | $15 | Slack + GitHub + Linear + Notion | ×1 | 97 % |

Gennemsnits-margin på tilkøb: **~75 %**. Markant højere end grundtierens margin fordi infra-omkostningerne er marginale efter base-setup.

## Unit economics per tier

Alle tal er månedlige. Antagelser: Haiku 4.5 ($1/M input, $5/M output). Moderat aktiv bruger: 10-30 chat-queries/dag, regelmæssig ingest, typisk approval-rate 10/dag.

| Tier | Salgspris | LLM-cost | Infra | Support allocation | **∑ Kost** | **Margin** |
|---|---:|---:|---:|---:|---:|---:|
| Free | $0 | $1 | $0,25 | $0 | $1,25 | -$1,25 (leadgen) |
| Starter | $20 | $6 | $0,50 | $1 | $7,50 | **$12,50 (63 %)** |
| Pro base | $75 | $40 | $3 | $2 | $45 | **$30 (40 %)** |
| Pro max add-ons | $420 | ~$130 | $8 | $5 | $143 | **$277 (66 %)** |
| Business | $999 | $780 | $15 | $50 | $845 | **$154 (15 %)** |
| Enterprise | $2.500+ | varierer | varierer | varierer | 50-70 % | **30-50 %** |

**Pro basis-margin (40 %) er bevidst presset** for at gøre indgangs-tieren attraktiv. Den reelle profit-motor i Pro er add-ons: en gennemsnits-Pro-kunde på $150-200/mdr leverer 55-65 % margin.

**Business margin ser lav ud (15 %)** — det skyldes at contradiction-cost ved 50.000 Neurons daglig sampling er stor. Ved at udskifte daglig sampling med 2x ugentlig kan margin stige til 35 %. Er en forhandlings-knop med kunden ved kontraktindgåelse.

## Naturlig kunde-rejse (Pro)

| Kunde-profil | Setup | Månedlig |
|---|---|---:|
| Solokurator, 1 projekt | Pro base | $75 |
| Konsulent, flere klienter | Pro + 2 Trails-pack | $105 |
| Lille team, aktiv skrivning | Pro + 2 Neurons pack + daily sampling | $165 |
| Mellem team med flere projekter | Pro + 4 Neurons + 2 Trails + daily + priority | $265 |
| Stort team med LLM-tunge workflows | Pro max (alle add-ons) | $420 |

Ved **$400-500** i Pro-usage bliver Business naturligt attraktivt fordi SLA + dedicated infra er ting der ikke kan købes til Pro. Det er den ønskede upgrade-trigger: kunden **føler** værdien af Business.

## Multi-KB strategi (skalerings-fundamentet)

Lint-scheduler er i dag per-KB men serielt. Ved at **parallelisere per-KB** scaler contradiction-scan med KB-antal i stedet for total Neuron-antal:

| Setup | Sekventiel | Per-KB parallel |
|---|---:|---:|
| 1 Trail × 10.000 Neurons | 28 t | 28 t |
| 5 Trails × 2.000 Neurons | 28 t | 5,6 t |
| 10 Trails × 1.000 Neurons | 28 t | 2,8 t |

Samme total Neurons, samme LLM-cost, men **10× wall-time speedup** ved 10-split. Det løser 24h-cycle-problemet uden at ty til sampling.

**Psykologisk gevinst:** per-KB Neuron-cap fungerer som soft-onboarding til at opgradere. "Opret ny Trail" CTA når den aktuelle nærmer sig cap er en bedre prompt end "du har brugt 80 % af din plan".

**Semantisk trade-off:** cross-KB contradictions detekteres ikke. Det er **faktisk ønsket** for topisk-isolerede domæner (akupunktur og urtemedicin skal ikke krydstjekkes). Ulempen er når et fælles koncept (fx "Cortisol") dukker op i flere KBs — det duplikeres. Chat-Q&A kan stadig spørge på tværs af KBs i samme tenant.

## TAM-overvejelser

Total Addressable Market = det totale årlige omsætningspotentiale hvis hver kunde der *kunne* bruge Trail faktisk blev betalende. Estimeres som `antal potentielle kunder × ACV`.

**Relevant her fordi prissætningen skal spejle markedets form:**

| Segment | Est. potentielle kunder globalt | ACV-range | TAM |
|---|---:|---|---:|
| Solokuratorer / wiki-maintainers | ~5M | $240-900 | $1,2-4,5B |
| SMB-teams (Starter/Pro) | ~500k | $900-3.600 | $450M-1,8B |
| Mellem-store firmaer (Business) | ~50k | $12.000-36.000 | $600M-1,8B |
| Enterprise (Fortune 5000) | ~5k | $30.000-150.000 | $150M-750M |

Samlet TAM ~$2-8B. Det retfærdiggør både **Starter-tier** ($20 × solokurator-volumen er hvor pengene ligger på længere sigt) og **Pro som default-tier** ($75-200 × SMB-volumen er 2025-2027-væksten).

**Anbefaling udledt af TAM:**
- **Starter** $20 skal være let at sige ja til — marketing-barrieren er lav, target-kunden er én person der betaler af egen lomme.
- **Pro** skal være "den åbenlyse team-ting at vælge" — $75-150 er inden for "jeg spørger ikke først" budget for teams.
- **Business** skal sælges enterprise-agtigt med demo + kontraktforhandling, ikke self-service. Derfor det store spring.

## Sanne som Pro-kunde

Sanne har ~75 sources → estimeret **160-230 Neurons** (75 source-summaries + 50-90 concept-pages + 30-60 entity-pages + 2 hub-pages). Det ligger under Starter's 500-Neurons-cap.

**Men hun skal alligevel på Pro fordi:**

1. **Ingest-kapacitet**: 75 medicinske papers × ~25 sider = ~1.900 ingest-pages. Starter's ingest-kvota bør ligge på ~1.000 pages (margin-matematik for Starter holder under den grænse). Pro (5.000 pages) rammer hende med 2,5× headroom.
2. **Growth-trajectory**: hun står ikke stille på 75 sources. Neuron-cap på Starter (500) rammer hun inden for 12-18 mdr.
3. **Contradiction-sampling er en feature hun har reel brug for**: medicinsk domæne hvor subtile modsigelser (dosering, kontraindikationer, tekniske parametre) er kritiske. On-mutation alene fanger ikke drift mellem to stagnante Neurons — hun har mange af slagsen når forståelsen udvikler sig over år. Ugentlig sampling er Pro-only.

Pro $75/mdr er en retvisende reflektion af hendes værdi + compute-forbrug. Når hun vokser til 200+ sources eller begynder at have flere undervisnings-Trails ved siden af, er det Pro + Trails-pack (+$15 for 2 ekstra) = $90.

## Arkitektoniske prerequisites før salg

Før disse fem ting er på plads kan vi ikke sælge Pro+ ansvarligt:

1. **API-migration** (`services/claude.ts` → Anthropic SDK direct i stedet for CLI). 2-3 dage. Forudsætning for at multi-tenant overhovedet er lovligt — Max subscription TOS tillader ikke SaaS-videresalg.
2. **`documents.last_contradiction_scan_at` kolonne** + scheduler-logic der respekterer den. 1 dag. Forudsætning for sampling.
3. **Parallelisme-runner** (Promise.all med concurrency limit via fx `p-limit`). 0,5 dag. Forudsætning for at holde Business-tier under SLA og for at tilkøbet "Parallel boost" er reelt.
4. **Per-tenant LLM-budget-tracking + soft-cap**. 2-3 dage. Forudsætning for at sælge Pro+ uden fare for runaway costs (kunden må ikke kunne bruge $500/mdr i compute på en $75-plan ved uheld).
5. **Plan-grænser re-modelleret på `tenants`-tabellen**: `maxKbs`, `maxNeuronsPerKb`, `parallelism`, `samplingFrequency`, `connectorPack` som enum-kolonner. 1 dag. Forudsætning for tilkøb overhovedet.

Total: **~8 dages arbejde** fra "idé" til "kan fakturere en Pro-kunde". Add hertil Stripe-integration for metered billing på tilkøb (~3-5 dage) og vi lander på **~2 ugers sprint**.

## Break-even per-tier

Ved fuld-utilization af tier-kapacitet:

| Tier | Pris | Profit/mdr | Kunder for 1 FTE (100k/år) |
|---|---:|---:|---:|
| Starter | $20 | $12,50 | 667 |
| Pro base | $75 | $30 | 278 |
| Pro m. $200 gns. | $200 | ~$120 | 70 |
| Business | $999 | $154 | 54 |
| Enterprise | $2.500+ | $750+ | 11 |

**Break-even for en udvikler + drift (anslået $120k/år):** 
- 80 Business-kunder, eller 
- 100 Pro-kunder ved gennemsnits-add-on-stack ($200/mdr)
- 800 Starter-kunder (mere konverteringsgrundlag, mindre margin pr. head)

Realistisk 2026Q3-mål: **100 Pro, 400 Starter, 5-10 Business** → ~$35-45k MRR, selvbærende.

## Open questions der kræver kundevalidering

1. **$39 Starter eller $20 Starter?** Vi valgte $20 for at sænke indgangsbarrieren, men Notion Plus ($10) og Grammarly Premium ($12) er dyrere end $20 per referencepunkt, så vi kunne presse den højere. Kræver 10-20 user-interviews med Sanne-profil før validering.
2. **Skal Business have brugerkvota eller seat-pricing?** Nuværende plan er "per tenant". Seat-based (fx $99/bruger efter 3 brugere) er mere enterprise-venligt men komplicerer multi-KB-modellen. Udskydes til efter de første 5 Business-kunder landes.
3. **Hvilke connectors skal være i Pro base vs. Connector pack?** p.t. er MCP + buddy gratis i Pro (fordi de er vores egen dogfood-sti). Slack + GitHub + Linear + Notion er tilkøb. Ændrer sig hvis markedet viser at Pro-kunder forventer Slack-integration som default.
4. **TAM-validering**: før vi går all-in på Starter-volumen-strategi bør vi validere at der faktisk er 500k+ SMB-teams der ville betale $75/mdr for en AI-native KB. Konkurrent-research + 50-100 customer-discovery interviews i 2026Q1.

## Feature-gating matrix

| Feature | Free | Starter | Pro | Business | Enterprise |
|---|:-:|:-:|:-:|:-:|:-:|
| Ingest (upload, chat) | ✓ | ✓ | ✓ | ✓ | ✓ |
| MCP connector | ✗ | ✓ | ✓ | ✓ | ✓ |
| On-mutation contradictions | ✗ | ✓ | ✓ | ✓ | ✓ |
| Månedlig backfill | ✗ | ✓ | ✓ | ✓ | ✓ |
| Ugentlig sampling | ✗ | ✗ | ✓ | ✓ | ✓ |
| Daglig sampling | ✗ | ✗ | +$40 | ✓ | ✓ |
| Parallelism > P=1 | ✗ | ✗ | +$30/step | ✓ (P=4) | ✓ (P=8+) |
| Multiple Trails | ✗ | ✗ | 3 base, +tilkøb | 10 | ∞ |
| Connector pack (Slack, GitHub, Linear, Notion) | ✗ | ✗ | +$15 | ✓ | ✓ |
| Priority ingest lane | ✗ | ✗ | +$20 | ✓ | ✓ |
| SLA (uptime + response) | ✗ | ✗ | ✗ | ✓ (99,5 %) | ✓ (99,9 %) |
| Dedicated infra | ✗ | ✗ | ✗ | ✗ | ✓ |
| SSO / SAML | ✗ | ✗ | ✗ | ✓ | ✓ |
| Audit log export | ✗ | ✗ | ✗ | ✓ | ✓ |
| Custom connectors | ✗ | ✗ | ✗ | ✗ | ✓ |

## Næste skridt

1. Beslut om $20 Starter er rigtigt eller om vi tester $29 parallelt i 2026Q1.
2. Land de 5 arkitektoniske prerequisites (F100-serie features).
3. Byg Stripe-integration til metered billing på Pro-tilkøb.
4. Customer discovery: 20 Sanne-profil-interviews + 20 SMB-team-interviews før Pro launch.
5. Rul Starter + Pro ud først. Business + Enterprise afventer de første 10 design-partners.
