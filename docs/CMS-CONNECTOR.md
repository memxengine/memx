# CMS-connector — reusable ingestion-pattern

*Tillæg til PRICING-PLAN.md og TRAIL-AS-DOCS-BACKEND.md. Skrevet 2026-04-19. Planlægger hvordan @webhouse/cms-integrationen formaliseres til en reusable connector-type som andre CMS-platforme kan adoptere.*

## Udgangspunkt

@webhouse/cms er den første CMS der integrerer med Trail som chat-motor. Flere af Christians CMS-kunder har tilkendegivet interesse i samme kapacitet for deres egne systemer (Storyblok-adjacent setups, Sanity-frontends, custom-built headless-CMS'er). Mønsteret skal **fra starten** bygges så det er genbrugbart — ikke hardcoded til @webhouse/cms' specifikke schema.

**Mål:** én `cms` connector-type i Trail's registry, to protokoller (sync + chat), og en plug-and-play Client SDK som CMS-platforme kan integrere i under 1 dag.

## Connector-type i Trail's registry

Tilføjes til `packages/shared/src/connectors.ts`:

```ts
{
  id: 'cms:webhouse',
  label: { en: 'Webhouse CMS', da: 'Webhouse CMS' },
  kind: 'cms',
  status: 'live',
  description: {
    en: 'Webhouse CMS (docs.webhouse.app) feeding articles into Trail.',
    da: 'Webhouse CMS der sender artikler ind i Trail.',
  },
}
```

Og roadmap-stubs for andre kunder:

```ts
{ id: 'cms:storyblok', status: 'roadmap' }
{ id: 'cms:sanity', status: 'roadmap' }
{ id: 'cms:custom', status: 'roadmap', description: 'Generic CMS via REST adapter' }
```

**Hvorfor `cms:<vendor>` pattern?** Samme måde som `mcp:claude-code` vs. `mcp:cursor`. Hver CMS-instans identificerer sig entydigt, men de deler protokolstack.

## Protokol 1 — Content-sync (CMS → Trail)

Push-based. Hver content-mutation i CMS trigger en HTTP-kald til Trail.

### Endpoints Trail eksponerer

```
POST /api/v1/cms-connector/{kbId}/articles
Authorization: Bearer <token>
Content-Type: application/json

{
  "id": "art_xyz",           // CMS's eget article-ID (stable)
  "slug": "field-types",
  "title": "Field Types Reference",
  "path": "/docs/reference",
  "locale": "en",
  "markdown": "## Field Types\n\n...",
  "metadata": {
    "version": "0.2.13",
    "updatedAt": "2026-04-18T10:00:00Z",
    "tags": ["reference", "fields"],
    "author": "Christian"
  }
}
```

Trail-siden:
- Match `(kbId, cms-id)` — upsert semantik (create eller update)
- Map til existing schema: `documents.filename = slug.md`, `documents.path = path + '/'`, `documents.content = markdown`, `documents.metadata = JSON.stringify({...metadata, cms: { id, version }})`
- Kind = `source` med `source-kind: 'cms-md'` → aktiverer CMS-optimized compile-prompt (se TRAIL-AS-DOCS-BACKEND.md)
- Returner `201 Created` eller `200 OK` med document-ID + compile-status

```
DELETE /api/v1/cms-connector/{kbId}/articles/{cmsId}
```

Soft-archive: sætter `archived=true` på den matchende source + relaterede Neurons. Chat-svar returnerer ikke længere citations til archived content.

```
POST /api/v1/cms-connector/{kbId}/bulk-sync
Authorization: Bearer <token>

{
  "articles": [ /* array af samme shape som single-article endpoint */ ],
  "prune": true   // hvis true, archive alle Trail-sources der IKKE findes i denne batch
}
```

Bulk-variant for initial backfill eller periodisk full-resync. `prune: true` rydder forældede artikler der er blevet slettet i CMS uden at trigger en DELETE-webhook.

### Authentication

**Option A — statisk bearer-token pr. KB** (MVP, simplest):
- Trail provisionerer én token pr. (tenant, cmsKbId)-par
- Token stored i CMS-servers env-vars
- Token rotation via Trail's admin-UI (ny token genereres, gammel beholder 48h overlap)

**Option B — signed webhook-payloads** (fremtidig, hvis CMS-kunder har strammere sec-krav):
- CMS signer hver request med HMAC-SHA256 over body + timestamp
- Trail verificerer signatur + afviser requests ældre end 5 min
- Token stadig bruges som secret, men eksponeret i færre HTTP headers

Start med A, migrer til B når første kunde beder om det.

## Protokol 2 — Chat-proxy (CMS → Trail → CMS)

Allerede defineret i TRAIL-AS-DOCS-BACKEND.md. Kort genopsummering:

```
POST /api/v1/chat
Authorization: Bearer <cms-tenant-token>

{
  "knowledgeBaseId": "kb_...",
  "message": "user's question",
  "locale": "en" | "da" | ...
}
```

Returnerer svar + citations. CMS-serveren proxier fra admin-UI, beriger med egen session-auth, logger lokalt.

**Spec-krav for CMS-integrationen:**
- Max 10 queries/min pr. admin-bruger (rate-limit i CMS-proxy, ikke Trail)
- Query-log eksporteres månedligt som CSV til kunden (compliance: "hvem spurgte hvad om vores docs?")
- Citations-format skal returnere både Trail's internal `documentId` OG den originale `cms-id` så CMS'en kan linke tilbage til sine egne docs-routes

## Protokol 3 — Contradiction-notifikationer (Trail → CMS)

Ny webhook-sti. Når Trail's contradiction-lint opdager en modsigelse mellem to docs, kan CMS'en abonnere på en notifikation.

```
POST <cms-webhook-url>
Content-Type: application/json
X-Trail-Signature: sha256=<hmac>

{
  "type": "contradiction_detected",
  "kbId": "kb_...",
  "newDocument": { "cmsId": "art_xyz", "path": "/docs/a" },
  "existingDocument": { "cmsId": "art_abc", "path": "/docs/b" },
  "summary": "Doc A says useCms() returns array, Doc B says object",
  "candidateId": "cnd_..."  // for acknowledge/dismiss flow
}
```

CMS-siden viser det i sit admin-UI som en "docs-quality"-alert. Kunden kan klikke "Acknowledge" (sender POST tilbage til Trail) eller "Dismiss" (samme, med dismissal-reason).

**Webhook-URL konfigureres pr. (tenant, kbId)** i Trail's admin. Retry med exponential backoff hvis CMS ikke svarer 2xx inden 10s.

## Client SDK

For at reducere integration-tid fra 1 uge til 1 dag: publicér `@trail/cms-connector-sdk` NPM-pakke som CMS-platforme kan installere.

```ts
import { TrailCmsConnector } from '@trail/cms-connector-sdk';

const trail = new TrailCmsConnector({
  baseUrl: process.env.TRAIL_BASE_URL!,
  token: process.env.TRAIL_INGEST_TOKEN!,
  kbId: process.env.TRAIL_KB_ID!,
});

// Push article
await trail.upsertArticle({
  id: 'art_xyz',
  slug: 'field-types',
  title: 'Field Types Reference',
  path: '/docs/reference',
  locale: 'en',
  markdown: '...',
  metadata: { version: '0.2.13', updatedAt: new Date(), tags: ['reference'] },
});

// Delete
await trail.deleteArticle('art_xyz');

// Chat (proxy endpoint)
const response = await trail.chat({
  message: 'How do I add a custom field type?',
  locale: 'en',
});
```

SDK'en håndterer:
- Automatisk retry på 5xx
- Request-signering (når Option B kommer)
- Token-rotation-handling
- TypeScript-typings for request/response
- Webhook-signaturverifikation

**Implementerings-estimat:** 2 dage for MVP, ~1 uge for alle 3 protokoller + dokumentation.

## Pricing + packaging

CMS-connector bør positioneres som **Pro-tier-feature** eller som dedikeret **tilkøb**.

### Som Pro-tilkøb

| Tilkøb | Pris/mdr | Giver |
|---|---:|---|
| CMS connector | $30 | 1 CMS-integration med en KB, bulk-sync, chat-proxy, contradiction-notifikationer |
| CMS multi-KB | +$15/KB | Per ekstra CMS-KB ud over den første (fx en kunde der kører EN + DA fra samme CMS) |

Margin: ~85 % (det er 100 % software-engineering oven på eksisterende primitiver, ingen ekstra compute hvis Max-subscription).

### Som Business-default

Business-tier inkluderer CMS-connector. SLA dækker at Trail svarer CMS-webhooks inden for 500ms P95. Dette er det attraktive loft for større kunder der ikke vil have surprise tilkøbs-regninger.

### Enterprise-anomalien

Enterprise-kunder kan sign-up til **custom CMS-adapter** hvor Trail-teamet bygger integrationen mod kundens interne CMS-stack. Kvoted som professional services, $5-15k engangs.

## Roll-out-plan

**Fase 1 — @webhouse/cms pilot (uge 1-2):**
- Implementer protokol 1 + 2 end-to-end for @webhouse/cms
- Brug som dogfood på docs.webhouse.app admin-chat
- Finpuds auth-flow, error-handling

**Fase 2 — Extraction af SDK (uge 3):**
- Refactor @webhouse/cms-specifik kode ud af Trail-server
- Generalisér til `cms:` connector-type
- Publicér `@trail/cms-connector-sdk` første version

**Fase 3 — Anden pilot (uge 4-5):**
- Første eksterne CMS-kunde integrerer via SDK
- Feedback-loop → SDK v1.1, dokumentation, troubleshooting guide
- Contradiction-webhook (protokol 3) lander her — kunde-signal viser om det er værdifuldt nok til at retfærdiggøre kompleksiteten

**Fase 4 — Åben adoption (måned 2-3):**
- Landing-page på trail.broberg.dk/integrations/cms
- Listing i Trail-admin under "Marketplace" af roadmap-connectors
- Første 3-5 CMS-kunder i betalende brug = signal til at sælge aktivt

## Afgrænsning — hvad CMS-connectoren IKKE er

1. **Ikke en generel webhook-receiver** — den er CMS-specifik. Generelle webhook-modtagere dækkes af `external-feed` candidate-kind (F39).
2. **Ikke en RSS-reader eller crawler** — CMS'en skal eksplicit push'e; Trail pull'er ikke. Pull-mode er en fremtidig `connector:rss`-feature hvis efterspurgt.
3. **Ikke en GraphQL-federation-node** — Trail eksponerer REST, ikke GraphQL. CMS'en må selv oversætte hvis dens eget schema er GraphQL.
4. **Ikke en public search-endpoint** — alle chat-queries går via CMS-admin-bruger. Ingen anonyme queries. Hvis CMS-kunde vil have public search på deres site, skal de bygge deres eget lag (eller bruge existing FTS5 i @webhouse/cms).
5. **Ikke et media-upload-interface** — kun markdown-tekst. Billeder, video, PDF'er uploades via Trail's eksisterende `/documents/upload` endpoint (separate flow).

## Åbne spørgsmål

1. **Skal CMS-connectoren understøtte real-time sync via WebSockets**, eller er webhooks nok? (Anbefaling: kun webhooks indtil en kunde beder om andet)
2. **Bulk-sync: hvad er den maksimale batch-størrelse?** Forslag: 100 artikler per request, batch større split automatisk af SDK'en
3. **Hvordan håndterer vi schema-drift mellem CMS-versioner?** Fx @webhouse/cms v0.2 og v0.3 sender forskellige metadata-shapes. Forslag: Trail accepterer ukendte metadata-felter som arbitrære JSON og bevarer dem uden at validere
4. **Skal CMS-kunden kunne se rå Trail-admin?** Anbefaling: nej — CMS-kunden ser kun deres egen dashboard via SDK. Trail-admin er vores værktøj, ikke kundens
5. **Data-exit — hvordan eksporterer en CMS-kunde sine Trail-data hvis de opsiger?** Forslag: `GET /api/v1/cms-connector/{kbId}/export` returner JSON-dump af alle sources + Neurons + candidates. Tilsvarende Trail's eksisterende admin-export-flow.

## Relation til TRAIL-AS-DOCS-BACKEND.md

TRAIL-AS-DOCS-BACKEND.md beskriver **den konkrete @webhouse/cms-integration** — den første CMS-connector-pilot. Dette dokument beskriver **det generaliserede mønster** som senere CMS-kunder vil bruge.

I praksis implementeres de i parallel: protokol 1-3 bygges first for @webhouse/cms-specifik brug, derefter refactoreres til SDK + `cms:` connector-type i fase 2. Rækkefølgen spiller roller for at ikke-over-engineere — vi skal have én fungerende integration før vi generaliserer.

## Sammenhæng med business plan

CMS-connectoren er den **tydeligste vej til at få Trail solgt som B2B-infrastruktur** snarere end kun direct-to-curator SaaS. Værdi-proposition:

- **For CMS-platforme:** "tilføj AI-chat + contradiction-lint til jeres produkt uden at bygge RAG"
- **For CMS-kunder:** "få en AI-assistent der kender hele vores indhold"
- **For Trail:** recurring revenue × N CMS-platforme × deres kunde-base

Break-even-acceleration: hvis Webhouse CMS har 50 kunder og halvdelen adopterer Trail-connector på Pro-tier ($75 × 25 = $1.875/mdr + $30 CMS-tilkøb × 25 = $750/mdr = $2.625/mdr), krydser vi break-even for én fuld udvikler på den kanal alene.

Det er grunden til at det giver mening at bygge protokollerne **generelt fra starten** — der er en reel salgshypotese bag.
