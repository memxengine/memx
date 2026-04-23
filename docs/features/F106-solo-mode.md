# F106 — Solo Mode

> "Release the tyranny" af queue-mediated curation. Solo-brugere stoler på LLM'en — alle auto-approves, queue-tab skjules, contradiction-toasts dæmpes. Samme audit-trail under motorhjelmen, bare usynlig som default. Kan toggles tilbage til Curator når som helst. Tier: Free (tvunget), Starter (default), Pro (toggle). Effort: Small (1-2 days). Status: Planned.

## Problem

Queue-mediated writes, pending candidates, auto-approval-thresholds, contradiction-alerts-på-skema — alt er value-add for professionelle kurator-teams men tyranni for enkeltbrugere der stoler på deres LLM. Karpathy skriver wiki-siden direkte; vi tvinger godkendelses-ceremoni per default. Det frastøder Free/Starter-segmentet.

## Secondary Pain Points

- Free-tier users see a Queue tab they can't use (no approval permissions).
- New users are overwhelmed by pending candidates on first login.
- Re-ingest requires confirmation modal even for trivial updates.
- Scheduled contradiction scans run on small KBs where they add no value.

## Solution

New column on `users`:

```sql
ALTER TABLE users ADD COLUMN mode TEXT
  CHECK (mode IN ('solo', 'curator'))
  NOT NULL DEFAULT 'curator';
```

When `users.mode = 'solo'`, the following defaults change WITHOUT removing underlying functionality:

| Surface | Curator-default | Solo-default |
|---|---|---|
| F19 auto-approval threshold | 0.8 for LLM, blocked for user | 0.0 for user (auto-approver alt) |
| Nav: Queue-tab | synlig med pending-badge | skjult; erstattes af Audit-link i Settings |
| Chat Save as Neuron | modal → queue | auto-approver direkte, toast |
| Re-ingest knap | bekræftelses-modal | ingen modal, direkte udfør |
| Scheduled contradiction-scan | aktiv | deaktiv (manuel via Settings-knap) |
| On-mutation contradiction-scan | aktiv | deaktiv (toggle-able) |
| Contradiction-findings | som pending candidates i queue | samles i Settings > Potentielle modsigelser |
| Auto-fix lint-findings (F113) | deaktiv | aktiv på høj-confidence |

## Non-Goals

- Removing the queue system entirely (queue still runs, just auto-approved).
- Hiding audit trail (full history is available in Settings > Audit).
- Different data models for solo vs curator (same tables, same candidates, different UI defaults).
- Per-KB mode setting (mode is per-user, applies to all KBs they access).
- Disabling contradiction detection entirely (just changes where findings surface).

## Technical Design

### Schema migration

```sql
ALTER TABLE users ADD COLUMN mode TEXT
  CHECK (mode IN ('solo', 'curator'))
  NOT NULL DEFAULT 'curator';
```

### F19 policy patch

The auto-approval policy in F19 reads the actor's mode and adjusts threshold:

```ts
// apps/server/src/queue/policy.ts
export function shouldAutoApprove(candidate: Candidate, actor: Actor): boolean {
  if (actor.mode === 'solo') return true; // auto-approve everything
  return candidate.confidence >= 0.8; // curator threshold
}
```

### Admin UI conditional rendering

```tsx
// Navigation
{currentUser.mode === 'curator' ? (
  <QueueTab badge={pendingCount} />
) : (
  <SettingsLink label="Audit" href="/settings/audit" />
)}
```

### Settings toggle

Settings > Account adds mode-toggle with explanatory copy + "du kan skifte når som helst":

```
Mode: [Solo ○] [Curator ●]
Solo: LLM approves automatically. Best for personal use.
Curator: Review each change. Best for teams.
```

## Interface

### User schema

```ts
interface User {
  // ... existing fields
  mode: 'solo' | 'curator';
}
```

### Settings API

```
PATCH /api/v1/users/me
Body: { mode: 'solo' | 'curator' }
  → 200 { user }
```

## Rollout

**Single-phase deploy.** Schema migration adds column with default 'curator'. Existing users are unaffected. New Free-tier users default to 'solo'. Starter users default to 'solo' but can switch. Pro users default to 'curator' but can switch.

## Success Criteria

- Solo-bruger ingester source → ser Neurons live i wiki-tree uden nogensinde at åbne Queue-tab.
- Skift til Curator-mode viser fuld historik af auto-approves som accepterbar audit.
- Re-ingest kan udføres i ét klik i Solo, kræver modal-bekræftelse i Curator.
- Free-tier users cannot switch to Curator mode (enforced at API level).

## Impact Analysis

### Files created (new)

- `apps/admin/src/panels/settings/audit.tsx` (audit view for solo-mode users)

### Files modified

- `packages/db/src/schema.ts` (add `mode` column to `users`)
- `apps/server/src/queue/policy.ts` (read actor-mode, adjust threshold)
- `apps/admin/src/components/nav.tsx` (conditional Queue-tab rendering)
- `apps/admin/src/components/chat-panel.tsx` (solo-mode auto-approve on save)
- `apps/admin/src/components/re-ingest-button.tsx` (solo-mode skip modal)
- `apps/admin/src/panels/settings.tsx` (add mode-toggle + audit link)
- `apps/server/src/services/lint-scheduler.ts` (solo-mode disable scheduled scans)

### Downstream dependents

`packages/db/src/schema.ts` — Central schema file. Adding `mode` column to `users` is additive (NOT NULL with DEFAULT); no downstream changes required.

`apps/server/src/queue/policy.ts` — Auto-approval policy. Adding mode-read changes threshold behavior but not the function signature. Downstream consumers (candidate creation, approval handler) are unaffected.

`apps/admin/src/components/nav.tsx` — Navigation component. Adding conditional rendering is additive; no downstream changes.

`apps/admin/src/components/chat-panel.tsx` — Chat panel. Adding solo-mode auto-approve changes save behavior but not the component API.

`apps/admin/src/components/re-ingest-button.tsx` — Re-ingest button. Adding solo-mode skip modal changes click behavior but not the component API.

`apps/admin/src/panels/settings.tsx` — Settings panel. Adding mode-toggle is additive; no downstream changes.

`apps/server/src/services/lint-scheduler.ts` — Lint scheduler. Adding mode-check for scheduled scans changes scheduling behavior but not the service API.

### Blast radius

- All changes are conditional on `users.mode` — curator-mode users see no change.
- Queue still runs for solo users — candidates are auto-approved, not skipped.
- Full audit trail is preserved in `wiki_events` + `queue_candidates` — nothing is hidden.
- Free-tier enforcement (no Curator mode) is an API-level check, not just UI.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `shouldAutoApprove()` returns true for solo-mode actor regardless of confidence
- [ ] Unit: `shouldAutoApprove()` returns false for curator-mode actor with confidence < 0.8
- [ ] Integration: solo-mode user ingests source → Neurons appear in wiki-tree without queue step
- [ ] Integration: curator-mode user ingests source → candidates appear in queue as before
- [ ] Manual: switch from Solo to Curator mode, verify full audit history is visible
- [ ] Manual: Free-tier user cannot switch to Curator mode (API returns 403)
- [ ] Regression: existing curator-mode users see no change in queue behavior
- [ ] Regression: existing ingest flow still works for both modes

## Implementation Steps

1. Add `mode` column to `users` table via Drizzle migration.
2. Update F19 policy in `apps/server/src/queue/policy.ts` to read actor-mode and adjust threshold.
3. Update admin nav in `apps/admin/src/components/nav.tsx` for conditional Queue-tab rendering.
4. Update chat panel in `apps/admin/src/components/chat-panel.tsx` for solo-mode auto-approve.
5. Update re-ingest button in `apps/admin/src/components/re-ingest-button.tsx` for solo-mode skip modal.
6. Add mode-toggle + audit link to admin Settings panel.
7. Update lint scheduler in `apps/server/src/services/lint-scheduler.ts` to disable scheduled scans for solo-mode.
8. Add API-level enforcement for Free-tier (no Curator mode switch).
9. Test: verify solo-mode and curator-mode behaviors end-to-end.

## Dependencies

None. Bygger direkte på eksisterende F17 Queue + F19 Policy.

## Open Questions

1. **Contradiction findings for solo users.** Should they appear as toast notifications, or only in Settings > Potentielle modsigelser? Leaning: Settings only (less noisy), but make it toggle-able.
2. **Team KBs with mixed modes.** If a solo-mode user and a curator-mode user share a KB, whose mode wins? Leaning: mode is per-user, per-action — solo user's actions auto-approve, curator user's actions go to queue.
3. **Mode change mid-ingest.** What if a user switches mode during an ingest run? Leaning: mode is read at ingest start, switch takes effect on next ingest.

## Related Features

- **F17** (Curation Queue API) — queue still runs, just auto-approved for solo
- **F19** (Auto-Approval Policy) — threshold adjustment based on mode
- **F97** (Activity Log) — audit trail for solo-mode auto-approves
- **F105** (Proactive Save Suggestion) — save-path behavior depends on mode
- **F113** (Auto-fix Lint Findings) — solo-mode enables auto-fix on high-confidence

## Effort Estimate

**Small** — 1-2 days.

- Schema migration: 30 min
- F19 policy patch: 30 min
- Admin UI conditional rendering (nav, chat, re-ingest): 2 hours
- Settings mode-toggle + audit link: 1 hour
- Lint scheduler update: 30 min
- Free-tier enforcement: 30 min
- Testing: 2 hours
