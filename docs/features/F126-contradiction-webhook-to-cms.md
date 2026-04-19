# F126 — Contradiction Webhook to CMS

*Planned. Tier: Business default, Pro som add-on. Effort: 2 days.*

> Trail pusher notifikation til CMS-kundens webhook-URL når contradiction-lint opdager modsigelse mellem to CMS-sourcede artikler. CMS'en viser en "docs-quality"-alert i sit admin. Matcher CMS-CONNECTOR.md § "Protokol 3".

## Problem

CMS-kunder der sync'er artikler ind i Trail har interesse i at vide hvornår deres docs modsiger hinanden (fx v0.2 og v0.3 beskriver samme API med forskellige signatures). Trail detekterer det i dag via contradiction-lint, men informationen bliver liggende i Trail's queue — CMS-kunden ser det ikke i sit eget system.

## Solution

Ny webhook-endpoint registreret per (tenant, kbId) i admin:

```
Trail → CMS's webhook-URL
POST <cms-webhook>
Content-Type: application/json
X-Trail-Signature: sha256=<hmac>

{
  "type": "contradiction_detected",
  "kbId": "kb_...",
  "newDocument": { "cmsId": "art_xyz", "path": "/docs/a", "locale": "en" },
  "existingDocument": { "cmsId": "art_abc", "path": "/docs/b", "locale": "en" },
  "summary": "Doc A says useCms() returns array, Doc B says object",
  "candidateId": "cnd_..."
}
```

CMS'en verificerer signaturen, viser alert i admin. Brugeren klikker "Acknowledge" → CMS kalder tilbage `POST /api/v1/cms-connector/:kbId/contradictions/:candidateId/ack`.

## How

- Ny tabel `kb_webhooks` med (kbId, url, secret, event_types, active, created_at)
- Lint-pipeline subscriber fyrer POST ved `contradiction-alert` candidate_created events med CMS-origin
- HMAC-signatur (F128) på hver request
- Retry med exponential backoff hvis 5xx fra CMS (3 forsøg over 30 min)
- Admin UI: Settings > Trail > Webhooks til at registrere URLer

## Dependencies

- F128 (signed payloads)
- F124 (CMS content-sync så cmsId er kendt)

## Success criteria

- @webhouse/cms admin modtager webhook inden for 2s af contradiction-detection
- HMAC-signatur validerer i CMS-server
- Retry-behavior verificeret ved simuleret 5xx
- Acknowledge round-trip opdaterer candidate til 'approved' status i Trail
