# F128 — Signed Webhook Payloads (HMAC-SHA256)

> Alle webhook-requests (F126 Trail→CMS) + alle indgående CMS-requests (F124 CMS→Trail) signeres med HMAC-SHA256 over body + timestamp. Beskytter mod replay-attacks og validerer sender-identitet uden at tokens eksponeres i headers. Tier: infrastruktur. Effort: 0.5 day.

## Problem

F124 og F126 bruger i dag bearer-token til auth. Det fungerer for servere-servere-kommunikation, men:
- Token er i HTTP Authorization header — logges ofte i proxies, CDN-logs, error-trackers
- Ingen beskyttelse mod replay hvis netværks-traffik opsnappes
- Timing-attacks mod token-compare (selvom vi har F5 timing-safe compare — stadig ikke ideelt for high-frequency)

CMS-branchen forventer HMAC-signed webhooks (Stripe, GitHub, Shopify alle bruger det).

## Secondary Pain Points

- Bearer tokens i logs kan lække ved debugging/fejlrapportering
- Ingen tidsbegrænsning på gyldigheden af en opsnappet request
- Token rotation kræver koordineret downtime

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

## Non-Goals

- Erstatte bearer-token auth fuldt ud — migration er gradvis
- Implementere OAuth2 / mTLS — HMAC er tilstrækkeligt for webhook-scenariet
- Signere GET-requests — kun POST/PUT med body

## Technical Design

### HMAC signer utility

```typescript
// apps/server/src/lib/hmac-signer.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifySignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
  maxAgeMs: number = 5 * 60 * 1000,
): boolean {
  if (Date.now() - timestamp * 1000 > maxAgeMs) return false;
  const expected = signPayload(secret, timestamp, body);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

### Middleware

```typescript
// apps/server/src/middleware/require-signed-request.ts
export function requireSignedRequest(secret: string) {
  return async (c: Context, next: Next) => {
    const timestamp = parseInt(c.req.header('X-Trail-Timestamp') || '0', 10);
    const signature = c.req.header('X-Trail-Signature') || '';
    const body = await c.req.text();
    if (!verifySignature(secret, timestamp, body, signature)) {
      return c.json({ error: 'invalid signature' }, 403);
    }
    await next();
  };
}
```

### Outgoing signer wrapper

Trail→CMS webhook-sender (F126) wraps fetch med signering:

```typescript
async function sendSignedWebhook(url: string, secret: string, body: unknown) {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyStr = JSON.stringify(body);
  const signature = signPayload(secret, timestamp, bodyStr);
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trail-Timestamp': String(timestamp),
      'X-Trail-Signature': `sha256=${signature}`,
    },
    body: bodyStr,
  });
}
```

## Interface

### Request Headers (indgående)

| Header | Type | Beskrivelse |
|---|---|---|
| `X-Trail-Timestamp` | Unix epoch (sekunder) | Request-tidspunkt |
| `X-Trail-Signature` | `sha256=<hex>` | HMAC-SHA256 signatur |

### Response

- 403 Forbidden med `{ error: "invalid signature" }` eller `{ error: "request too old" }`

### Config

- `TRAIL_CMS_AUTH=bearer|signed|both` — feature-flag for gradvis migration (90-dages overlap)

## Rollout

**Gradvis migration med feature-flag:**
1. Deploy med `TRAIL_CMS_AUTH=both` — accepterer både bearer og signed
2. CMS-integration (F127 SDK) skifter til signed
3. Efter 90 dage: `TRAIL_CMS_AUTH=signed` — bearer afvises
4. Ingen rollback-path nødvendig — HMAC er backwards-compatible via `both`-mode

## Success Criteria

- Forkerte signaturer → 403 Forbidden
- Timestamp > 5min gammel → 403 med message "request too old"
- Valid signature ramt inden for tolerance → request proceeder normalt
- @webhouse/cms-integration kan bytte mellem bearer og signed uden code-changes (SDK dækker det)
- Zero auth failures i 7 dage efter switch til `signed`-only mode

## Impact Analysis

### Files created (new)
- `apps/server/src/lib/hmac-signer.ts`
- `apps/server/src/middleware/require-signed-request.ts`

### Files modified
- `apps/server/src/routes/cms-sync.ts` (F124 — tilføj signature verification)
- `apps/server/src/services/webhook-sender.ts` (F126 — tilføj outgoing signing)
- `packages/cms-integration/src/client.ts` (F127 SDK — auto-signing)

### Downstream dependents
`apps/server/src/routes/cms-sync.ts` — new file, no dependents yet.
`apps/server/src/services/webhook-sender.ts` — new file, no dependents yet.
`packages/cms-integration/src/client.ts` — imported by CMS-side consumers. Adding signing is additive — existing API surface unchanged.

### Blast radius

- Alle CMS→Trail og Trail→CMS kommunikation påvirkes
- Feature-flag (`TRAIL_CMS_AUTH`) giver sikker migration uden downtime
- Shared secret rotation kræver koordineret update på begge sider
- Edge case: clock skew mellem servere — 5-min tolerance håndterer typisk drift

### Breaking changes

None — all changes are additive. Bearer-token path bevares i 90 dage via feature-flag.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] `signPayload` + `verifySignature` round-trip med kendt secret → valid
- [ ] Forkert secret → verifySignature returns false
- [ ] Timestamp > 5min gammel → verifySignature returns false
- [ ] Middleware med gyldig signatur → request passerer (200)
- [ ] Middleware med ugyldig signatur → 403 Forbidden
- [ ] Middleware med gammel timestamp → 403 "request too old"
- [ ] `TRAIL_CMS_AUTH=both` accepterer både bearer og signed
- [ ] Regression: eksisterende CMS-sync fungerer med bearer-token i `both`-mode

## Implementation Steps

1. Opret `apps/server/src/lib/hmac-signer.ts` med `signPayload` + `verifySignature` + tests.
2. Opret `apps/server/src/middleware/require-signed-request.ts` middleware.
3. Udvid F124's CMS→Trail route med `requireSignedRequest` middleware (bag `both`-flag).
4. Udvid F126's webhook-sender med outgoing signering.
5. Opdater F127 SDK med auto-signing + verification.
6. Dokumenter secret rotation procedure.
7. Manuelt test: curl med gyldig/ugyldig signatur, bekræft 200/403.

## Dependencies

- F124 (CMS→Trail content-sync — indgående webhook path)
- F126 (Trail→CMS webhooks — udgående webhook path)
- F127 (CMS SDK — client-side signing)

## Open Questions

None — all decisions made.

## Related Features

- **F124** — CMS→Trail content-sync (primær consumer af indgående verification)
- **F126** — Trail→CMS webhooks (primær consumer af udgående signing)
- **F127** — CMS Integration SDK (auto-signing i client library)
- **F5** — Timing-safe compare (genbruges i HMAC verification)

## Effort Estimate

**Small** — 0.5 day.
- 0.25 day: hmac-signer utility + middleware + tests
- 0.15 day: outgoing signing i webhook-sender + SDK
- 0.1 day: dokumentation + manuel verification
