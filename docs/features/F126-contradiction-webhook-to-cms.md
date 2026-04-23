# F126 — Contradiction Webhook to CMS

> Trail pusher notifikation til CMS-kundens webhook-URL når contradiction-lint opdager modsigelse mellem to CMS-sourcede artikler. CMS'en viser en "docs-quality"-alert i sit admin. Matcher CMS-CONNECTOR.md § "Protokol 3". Tier: Business default, Pro som add-on. Effort: 2 days. Status: Planned.

## Problem

CMS-kunder der sync'er artikler ind i Trail har interesse i at vide hvornår deres docs modsiger hinanden (fx v0.2 og v0.3 beskriver samme API med forskellige signatures). Trail detekterer det i dag via contradiction-lint, men informationen bliver liggende i Trail's queue — CMS-kunden ser det ikke i sit eget system.

## Secondary Pain Points

- CMS admins have no visibility into docs quality issues detected by Trail
- Manual check required: CMS admin must log into Trail to see contradictions
- No automated alerting for docs team when contradictions are found
- Contradiction resolution workflow lives entirely in Trail, not in CMS where docs are authored

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

## Non-Goals

- Webhook delivery guarantee (at-least-once with retries, not exactly-once)
- Custom webhook event types (only contradiction_detected for now)
- Webhook management UI for end users (admin-only configuration)
- Webhook payload customization (fixed schema)
- Bi-directional sync (CMS acknowledges, but resolution happens in Trail)

## Technical Design

### Webhook Registry Table

```sql
CREATE TABLE kb_webhooks (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,  -- HMAC secret shared with webhook receiver
  event_types TEXT NOT NULL DEFAULT '["contradiction_detected"]',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_webhooks_kb ON kb_webhooks(kb_id);
```

### Webhook Dispatcher

```typescript
// apps/server/src/services/webhook-dispatcher.ts
import { createHmac } from 'node:crypto';

interface WebhookPayload {
  type: 'contradiction_detected';
  kbId: string;
  newDocument: { cmsId: string; path: string; locale: string };
  existingDocument: { cmsId: string; path: string; locale: string };
  summary: string;
  candidateId: string;
}

export async function dispatchWebhook(
  kbId: string,
  eventType: string,
  payload: WebhookPayload,
): Promise<void> {
  const webhooks = await db.select().from(kbWebhooks)
    .where(and(eq(kbWebhooks.kbId, kbId), eq(kbWebhooks.active, true)));

  for (const webhook of webhooks) {
    if (!webhook.event_types.includes(eventType)) continue;

    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');

    await withRetry(async () => {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trail-Signature': `sha256=${signature}`,
        },
        body,
      });
      if (!response.ok) throw new Error(`Webhook failed: ${response.status}`);
    }, { maxRetries: 3, backoffMs: 300_000 }); // 3 retries over 30 min
  }
}
```

### Retry with Exponential Backoff

```typescript
async function withRetry(fn: () => Promise<void>, options: { maxRetries: number; backoffMs: number }): Promise<void> {
  for (let i = 0; i <= options.maxRetries; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (i === options.maxRetries) throw err;
      await sleep(options.backoffMs * (i + 1));
    }
  }
}
```

### Contradiction Lint Integration

Lint-pipeline subscriber fyrer POST ved `contradiction-alert` candidate_created events med CMS-origin:

```typescript
// In contradiction-lint.ts, after detecting contradiction:
if (docA.metadata.cmsId && docB.metadata.cmsId) {
  await dispatchWebhook(kbId, 'contradiction_detected', {
    type: 'contradiction_detected',
    kbId,
    newDocument: { cmsId: docA.metadata.cmsId, path: docA.metadata.path, locale: docA.metadata.locale },
    existingDocument: { cmsId: docB.metadata.cmsId, path: docB.metadata.path, locale: docB.metadata.locale },
    summary: contradictionSummary,
    candidateId: candidate.id,
  });
}
```

### Acknowledge Endpoint

```
POST /api/v1/cms-connector/:kbId/contradictions/:candidateId/ack
Authorization: Bearer <connector-token>

→ 200 { candidateId, status: 'approved' }
```

Updates candidate to 'approved' status in Trail.

## Interface

### Webhook Payload

```typescript
interface ContradictionWebhookPayload {
  type: 'contradiction_detected';
  kbId: string;
  newDocument: { cmsId: string; path: string; locale: string };
  existingDocument: { cmsId: string; path: string; locale: string };
  summary: string;
  candidateId: string;
}
```

### HMAC Signature Verification (CMS side)

```typescript
// CMS verifies:
const expected = createHmac('sha256', sharedSecret).update(body).digest('hex');
const received = req.headers['x-trail-signature'];
if (received !== `sha256=${expected}`) throw new Error('Invalid signature');
```

### Admin UI

Settings > Trail > Webhooks til at registrere URLer:
- Add webhook URL
- Set HMAC secret (auto-generated or custom)
- Select event types (currently only contradiction_detected)
- Toggle active/inactive
- View delivery status (last sent, last error)

## Rollout

**Single-phase deploy.** New table, new service, new endpoint — no migration needed for existing functionality. Webhook dispatch only fires for CMS-sourced documents (cmsId present).

## Success Criteria

- @webhouse/cms admin modtager webhook inden for 2s af contradiction-detection (measured: detection → webhook delivery time)
- HMAC-signatur validerer i CMS-server (verified: CMS receives valid signature, verification passes)
- Retry-behavior verificeret ved simuleret 5xx (verified: webhook fails 3 times, retries over 30 min, succeeds on 4th)
- Acknowledge round-trip opdaterer candidate til 'approved' status i Trail (verified: CMS POST /ack → candidate status = 'approved')

## Impact Analysis

### Files created (new)

- `apps/server/src/services/webhook-dispatcher.ts`
- `apps/server/src/routes/cms-contradictions.ts`
- `apps/server/src/services/__tests__/webhook-dispatcher.test.ts`

### Files modified

- `packages/db/src/schema.ts` (add `kb_webhooks` table)
- `apps/server/src/services/contradiction-lint.ts` (dispatch webhook on CMS-sourced contradictions)
- `apps/server/src/app.ts` (mount cms-contradictions routes)
- `apps/admin/src/components/settings-webhooks.tsx` (new component for webhook management)

### Downstream dependents

`packages/db/src/schema.ts` is imported by 15+ files across the monorepo:
- `apps/server/src/services/webhook-dispatcher.ts` (1 ref) — new consumer
- `apps/server/src/services/contradiction-lint.ts` (1 ref) — needs update to dispatch webhook
- All other consumers unaffected by new table

`apps/server/src/services/contradiction-lint.ts` is imported by 2 files:
- `apps/server/src/services/lint-scheduler.ts` (1 ref) — calls lint, unaffected by webhook dispatch
- `apps/server/src/routes/lint.ts` (1 ref) — manual lint trigger, unaffected
Webhook dispatch is side-effect — lint logic unchanged.

`apps/server/src/app.ts` is imported by 4 files:
- `apps/server/src/index.ts` (1 ref) — creates app, unaffected
- `apps/server/src/routes/auth.ts` (1 ref) — dev mode, unaffected
- `apps/server/src/routes/health.ts` (1 ref) — health check, unaffected
- `apps/server/src/routes/api-keys.ts` (1 ref) — API key routes, unaffected
Mounting new route is additive.

### Blast radius

- Webhook dispatch is async side-effect — failure should not block contradiction detection
- Retry logic must not block lint scheduler — use fire-and-forget or background job
- HMAC secret must be stored securely — not logged, not exposed in API responses
- Webhook URL validation: must reject localhost, internal IPs, malformed URLs
- Acknowledge endpoint must validate connector-token scope (only CMS connector tokens can ack)

### Breaking changes

None — all changes are additive. New table, new service, new endpoints.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Migration runs: `CREATE TABLE kb_webhooks` succeeds
- [ ] Webhook dispatched on CMS-sourced contradiction → POST received at test server
- [ ] HMAC signature in webhook request validates correctly
- [ ] Webhook retry: simulated 5xx → retry after backoff, succeeds on retry
- [ ] Webhook with invalid URL → error logged, no crash
- [ ] Acknowledge endpoint: POST /ack → candidate status updated to 'approved'
- [ ] Acknowledge endpoint: invalid connector-token → 401
- [ ] Regression: contradiction detection still works for non-CMS documents (no webhook dispatched)
- [ ] Regression: lint scheduler still runs on schedule with webhook dispatch overhead

## Implementation Steps

1. Create `kb_webhooks` table via Drizzle migration.
2. Implement `webhook-dispatcher.ts` with HMAC signing and retry logic.
3. Integrate webhook dispatch into `contradiction-lint.ts` (fire on CMS-sourced contradictions).
4. Create acknowledge endpoint in `cms-contradictions.ts` route file.
5. Mount routes in `app.ts`.
6. Build Admin Settings UI for webhook management (Settings > Trail > Webhooks).
7. End-to-end test: contradiction detected → webhook received → acknowledged → candidate approved.

## Dependencies

- F128 (signed payloads)
- F124 (CMS content-sync så cmsId er kendt)

## Open Questions

- Should webhook dispatch be synchronous (blocks lint) or async (fire-and-forget via background job)? Async is safer but adds complexity.
- Should we support multiple webhook URLs per KB (e.g., one for docs team, one for engineering)?

## Related Features

- **F128** (Signed Payloads) — HMAC signature for webhook verification
- **F124** (CMS Content-Sync) — populates cmsId needed for webhook payload
- **F127** (CMS Connector SDK) — provides webhook handler helper
- **F17** (Curation Queue API) — webhook acknowledges candidate in queue

## Effort Estimate

**Small** — 2 days. Table + dispatcher + lint integration + acknowledge endpoint + admin UI.
