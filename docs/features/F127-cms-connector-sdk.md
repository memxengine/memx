# F127 — @trail/cms-connector-sdk NPM Package

*Planned. Tier: infrastruktur. Effort: 2-3 days.*

> Publicér NPM-pakke `@trail/cms-connector-sdk` der wrapper F124+F125+F126-endpoints i type-safe TypeScript/JavaScript-API. Mål: CMS-kunde kan integrere på <1 dag ved at installere pakken + tilføje 10 linjer kode.

## Problem

CMS-kunder der integrerer med Trail skal i dag:
- Læse OpenAPI-spec
- Bygge egen HTTP-client
- Håndtere retry, bearer-auth-rotation, webhook-signatur
- Type-definere request/response shapes

Det er ~3-5 dages integrations-arbejde. Med en SDK reduceres det til få linjer.

## Solution

`@trail/cms-connector-sdk` eksponerer:

```ts
import { TrailCmsConnector } from '@trail/cms-connector-sdk';

const trail = new TrailCmsConnector({
  baseUrl: process.env.TRAIL_BASE_URL!,
  token: process.env.TRAIL_CONNECTOR_TOKEN!,
  kbId: process.env.TRAIL_KB_ID!,
});

// Push artikel
await trail.upsertArticle({ id, slug, title, path, locale, markdown, metadata });

// Delete
await trail.deleteArticle(id);

// Bulk sync med prune
await trail.bulkSync({ articles, prune: true });

// Chat-proxy
const response = await trail.chat({ message: "...", locale: "en" });

// Webhook handler
const handler = trail.webhookHandler({
  onContradictionDetected: async (event) => { /* show in CMS admin */ },
});
app.post('/trail-webhook', handler);
```

SDK håndterer:
- HMAC-signatur verifikation (F128)
- Automatic retry på 5xx + network errors
- TypeScript-typings for alle request/response shapes
- Token-rotation advisory (logger warning ved 401 så kunden ved token er udløbet)

## How

- Ny mappe i monorepo: `packages/cms-connector-sdk/`
- Published som separat NPM-package (ikke del af Trail-monorepo-workspace alene — Christian's NPM-publisher-workflow)
- Bundle: esm + cjs via Vite eller tsup
- Docs-site på trail.broberg.dk/sdk med eksempler per CMS-platform

## Dependencies

- F124 (content-sync endpoint)
- F125 (chat-proxy)
- F126 (webhook — for handler-feature)
- F128 (signed payloads — SDK håndterer verification)

## Success criteria

- NPM: `npm install @trail/cms-connector-sdk` virker
- 10-linjers quickstart i README demonstrerer fuld content-sync
- TypeScript-typings er fuldkomplette (ingen `any`)
- Mønster-test: @webhouse/cms-integration bruger SDK for alle Trail-kald
