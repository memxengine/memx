# F128 — Signed Webhook Payloads (HMAC-SHA256)

*Planned. Tier: infrastruktur. Effort: 0.5 day.*

> Alle webhook-requests (F126 Trail→CMS) + alle indgående CMS-requests (F124 CMS→Trail) signeres med HMAC-SHA256 over body + timestamp. Beskytter mod replay-attacks og validerer sender-identitet uden at tokens eksponeres i headers.

## Problem

F124 og F126 bruger i dag bearer-token til auth. Det fungerer for servere-servere-kommunikation, men:
- Token er i HTTP Authorization header — logges ofte i proxies, CDN-logs, error-trackers
- Ingen beskyttelse mod replay hvis netværks-traffik opsnappes
- Timing-attacks mod token-compare (selvom vi har F5 timing-safe compare — stadig ikke ideelt for high-frequency)

CMS-branchen forventer HMAC-signed webhooks (Stripe, GitHub, Shopify alle bruger det).

## Solution

Hver request inkluderer:

```
X-Trail-Timestamp: 1745123456
X-Trail-Signature: sha256=<hex-hmac>
```

Signaturen:

```
signature = hmac_sha256(shared_secret, timestamp + "." + request_body)
```

Modtageren:
1. Verificerer timestamp er inden for 5 minutters tolerance (afviser replay)
2. Beregner HMAC over samme string
3. Sammenligner med timing-safe compare

Shared secret er per-(tenant, webhook-endpoint) genereret ved registrering, vises kun ved creation, kan rotateres.

## How

- Ny util `apps/server/src/lib/hmac-signer.ts`
- Middleware `requireSignedRequest` for indgående (F124's CMS→Trail)
- Signer-wrapper for udgående (F126's Trail→CMS)
- Graceful migration: behold bearer-token-only sti i 90 dage via feature-flag (`TRAIL_CMS_AUTH=bearer|signed|both`)
- SDK (F127) håndterer signering + verification automatisk

## Dependencies

Ingen. Standalone sikkerheds-enhancement.

## Success criteria

- Forkerte signaturer → 403 Forbidden
- Timestamp > 5min gammel → 403 med message "request too old"
- Valid signature ramt inden for tolerance → request proceeder normalt
- @webhouse/cms-integration kan bytte mellem bearer og signed uden code-changes (SDK dækker det)
