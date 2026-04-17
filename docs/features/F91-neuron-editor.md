# F91 — Neuron Editor

> Curators can read Neurons but can't edit them. Several F90 action explanations (contradiction-alert's "Reconcile manually", orphan-neuron's "Link to sources", stale's "Still relevant") direct the user to "open the page and edit it" — but the admin doesn't have an editor. Ship one.

## Problem

The curator's loop today is:

1. See a finding in the queue (contradiction, orphan, stale).
2. Click an action button that describes what the system will do.
3. If no button fits, the explanation tells them to "open the Neuron and edit it manually".

Step 3 is a dead end. `/kb/<id>/neurons/<slug>` is a read-only reader. There's no edit path in the admin. The only way to change a Neuron's content right now is:

- `POST /api/v1/queue/candidates` with a `kind: 'ingest-page-update'` payload (curl-only)
- The MCP `write` tool from an external cc session
- Manually editing the SQLite row

None of these is a curator UX. This feature closes the gap.

## Scope

**In scope (v1):**
- Inline markdown editor on the Neuron reader page: toggle "Read / Edit".
- Edit content (markdown body + YAML frontmatter), `documents.title`, and `tags`.
- Save: server-side "create candidate + resolve as approve in one handler" — curator is both producer and reviewer, same audit trail as a manual queue click, no UI round-trip. See [Save path](#save-path-queue-candidate--resolve-in-one-handler) for why this is NOT F19 auto-approval.
- Optimistic concurrency: reject save if the doc's `version` has advanced since the editor loaded (someone else edited while you were typing).
- Cancel: discards local changes, no DB write.
- Unsaved-changes guard: `beforeunload` + in-app navigation block when the editor is dirty.

**Out of scope (v1):**
- Path / filename rename — v1 edits content in place. Rename requires `approveUpdate` extension + backlink rewrites; deferred to F91.1.
- Collaborative editing (two people at once) — server rejects stale-version saves, UI tells you to reload.
- Visual editor / WYSIWYG — v1 is a plain textarea with markdown preview pane (split view).
- Backlink auto-repair — deferred to F91.1 alongside rename.
- Create-new-Neuron from the admin — keep that in the queue-candidate path; this feature is edit-only for already-existing Neurons.
- LocalStorage draft recovery — `beforeunload` guard is enough for v1; add draft backup only if data-loss incidents surface.

## Why it lives in the admin (not just MCP)

The MCP `write` tool already works for cc sessions. But Sanne is not a cc user; she's a curator staring at a "Reconcile manually" button. If that path is "open a terminal and type `trail` MCP commands", we've punted on the UX. Admin editor = first-class curator tool.

## Design

### Route

`/kb/:kbId/neurons/:slug` already exists as the reader. Add a `?edit=1` query param that flips the view into edit mode. Keeps the URL stable (back button, bookmarks, shares), doesn't need a separate route.

### Auth

The Neuron reader uses session-cookie auth (`requireAuth` middleware). Editor inherits. No role gating in v1 — any authenticated user in a tenant can edit any Neuron there. Owner-vs-curator role gating can be added later if multi-role tenants show up in practice.

### Save path: queue candidate + resolve in one handler

F17's invariant (queue is the sole write path) holds. The catch — and the reason the earlier draft of this spec was wrong — is that F19's auto-approve policy explicitly refuses human-originated candidates. `packages/core/src/queue/policy.ts:58` has:

```ts
// Humans never auto-approve. If a curator wants a page in, they click it.
if (candidate.createdBy) return false;
```

This is deliberate. The policy's own docstring calls out: *"A human-originated candidate (createdBy set) NEVER auto-approves… Mixing the two corrupts the audit trail."* Adding `'user-correction'` to `TRUSTED_KINDS` + gating on an env flag (`TRAIL_AUTO_APPROVE_USER_CORRECTIONS`) does **nothing**, because the `createdBy` short-circuit fires first. Any fix that relaxes that guard breaks `autoApprovedAt`/`createdBy` audit semantics across every queue kind.

**Correct model:** the Save endpoint creates the candidate **and resolves it as approve in the same request**, with the curator as both producer and reviewer. That's exactly the two-step a human queue click would perform — just without the UI round-trip. No policy change. No env flag.

Server endpoint: `PUT /api/v1/documents/:id` (new), which calls a new core helper:

```ts
// packages/core/src/queue/candidates.ts
export async function submitCuratorEdit(
  trail: TrailDatabase,
  tenantId: string,
  docId: string,
  input: {
    title?: string;
    content: string;
    tags?: string | null;
    expectedVersion: number;
  },
  actor: Actor, // kind: 'user'
): Promise<ResolutionResult>;
```

Behaviour, all inside one tx:
1. Insert a `user-correction` candidate with `createdBy = actor.id`, `confidence: 1`, metadata `{ op: 'update', targetDocumentId: docId, expectedVersion }`.
2. Dispatch straight to `executeApprove` → `approveUpdate` (bypassing `shouldAutoApprove` — this isn't auto-approval, it's a curator approving their own submission).
3. `autoApprovedAt` stays `null`. `reviewedBy = actor.id`. `reviewedAt = now`. Wiki event emits with `actorKind: 'user'`.

The candidate row exists, the wiki event exists, and the audit trail says exactly what happened: user X created and approved an edit at time T.

Client payload (server constructs the candidate, client doesn't shape queue rows):

```ts
PUT /api/v1/documents/:id
{
  title?: string;
  content: string;
  tags?: string | null;
  expectedVersion: number; // doc.version at editor load
}
```

### Title source: `documents.title` is canonical

The Neuron has two "title" surfaces: the `documents.title` column and any `# H1` inside the markdown body. The editor's title input writes **only** `documents.title`. The `# H1` in the body is free markdown — the editor never parses or rewrites it. This matches the reader (`wiki-reader.tsx:96` renders `d.title ?? d.filename`) and avoids a sync loop where the editor would have to decide which surface wins.

### Optimistic concurrency

`approveUpdate` needs a new guard: if `metadata.expectedVersion` is present and the target doc's current version ≠ expectedVersion, throw a conflict error that the route translates to HTTP 409 with a message like "The Neuron was edited since you opened it. Reload to see the latest version." UI catches 409 and shows a banner with a "Reload" button that re-fetches and wipes the dirty editor state.

The check lands inside the same tx as the update, so a race between two curators is resolved by SQLite's write lock — loser gets the 409, winner's write is atomic.

### UI layout

Split view:
- Left pane: `<textarea>` with the raw markdown (frontmatter + body).
- Right pane: live markdown preview (`marked.parse` + `rewriteWikiLinks`).
- Header: title input (writes `documents.title`), tags input, version indicator, "Save" + "Cancel" buttons. No path/filename input in v1 (see F91.1).
- Footer hint: "⌘+S to save · Esc to cancel".

Textarea auto-grows with content; no fixed height. Tailwind utility classes only, no new npm dep.

**Dirty-state guard:** when the editor has unsaved changes, register a `beforeunload` listener that prompts on tab close / refresh, and intercept `preact-iso` in-app navigation to show a confirm dialog. Cleared on successful save or explicit cancel.

**Raw content:** the editor needs the document's raw markdown **including frontmatter**. Verify before implementation that `getDocumentContent(docId)` returns unmodified content (the reader passes it through `marked.parse` + `rewriteWikiLinks` client-side, which suggests raw is what the endpoint serves — but confirm and, if a `?raw=1` flag is needed, add it rather than forking the endpoint).

## Impact Analysis

### Files affected

- New: `apps/admin/src/panels/neuron-editor.tsx` — the split-view editor component (or fold the edit mode into `wiki-reader.tsx` behind a `?edit=1` conditional; decide based on component size).
- New: `apps/server/src/routes/documents.ts` — `PUT /api/v1/documents/:id` route calling `submitCuratorEdit`. If a `documents` route file already exists, extend it.
- Modify: `apps/admin/src/panels/wiki-reader.tsx` — add the "Edit" toggle button that sets `?edit=1`; route into editor component when the flag is on.
- Modify: `apps/admin/src/panels/queue.tsx` — action cards whose explanation tells the curator to "open and edit manually" (contradiction-alert's acknowledge, orphan-neuron's link-to-sources, stale's still-relevant) get a "Open editor" button that deep-links to `/kb/:kbId/neurons/:slug?edit=1`. Without this, the editor exists but the F90 flows that motivated it still dead-end.
- Modify: `apps/admin/src/api.ts` — helper `saveNeuronEdit(docId, { title, content, tags, expectedVersion })` that PUTs to the new endpoint.
- Modify: `packages/core/src/queue/candidates.ts` — add `submitCuratorEdit` helper (see [Save path](#save-path-queue-candidate--resolve-in-one-handler)); extend `approveUpdate` with the `expectedVersion` check.
- Modify: `packages/shared/src/queue.ts` (or wherever `QueueCandidateKind` lives) — add `'user-correction'` to the union.
- **No change** to `packages/core/src/queue/policy.ts`. The earlier draft suggested policy surgery; it's not needed and would break F19's audit contract.
- i18n: new keys in `apps/admin/src/locales/{en,da}.json` for editor chrome (Save, Cancel, conflict banner, stale-version warning, dirty-navigation confirm).

### Downstream dependents

- **F15 reference-extractor**: already listens on `candidate_approved` and re-parses frontmatter. Edits that change `sources:` auto-update the `document_references` table — no change needed.
- **F15 iter 2 backlink-extractor**: same, `[[wiki-links]]` are re-parsed.
- **F32 lint**: versioned fingerprints mean an edit re-qualifies stale/orphan findings automatically (F90 P6).
- **F39 cc-session ingest**: unchanged — MCP write path stays available for non-curator flows.

### Blast radius

Low. Additive feature. Existing read-only reader keeps working; no change to the URL shape. The optimistic-concurrency check is a new error path that doesn't exist today, but only fires when two clients race, which isn't a case we hit in practice yet.

### Breaking changes

None.

### Test plan

- TypeScript compiles: `pnpm -w tsc --noEmit`.
- Open a Neuron, click Edit, change title + body, Save → see the change on re-open.
- After save, query `queue_candidates` for the resulting row: `createdBy = <user.id>`, `autoApprovedAt IS NULL`, `reviewedBy = <user.id>`, `status = 'approved'`. This is the audit invariant.
- After save, `wiki_events` has one new row with `eventType = 'edited'`, `actorKind = 'user'`, `newVersion = doc.version + 1`.
- Edit, Cancel → changes discarded, no DB write, no candidate row.
- Open the same Neuron in two tabs. Save in tab A, then save in tab B → tab B gets a 409 banner, no second wiki_event emitted.
- Edit a Neuron that has `sources: [...]` in frontmatter → after save, the reference-extractor re-parses (verify via DB query on `document_references`).
- Click "Reconcile manually" action card in queue → lands in editor with `?edit=1` and correct Neuron loaded.
- Edit, then try to navigate (back button / click link / refresh) → confirm dialog fires; confirm proceeds, cancel stays on editor.
- Regression: `shouldAutoApprove` on a human-originated ingest-page-update still returns false (sanity-check that the "bypass policy" path for curator edits didn't leak into policy.ts).

## Implementation Steps

1. Verify `getDocumentContent(docId)` returns raw markdown (frontmatter intact). If not, add a `?raw=1` flag on the endpoint.
2. Add `'user-correction'` to `QueueCandidateKind` in `packages/shared`.
3. Extend `approveUpdate` in core with the `expectedVersion` guard (throws a typed conflict error; route layer maps to HTTP 409).
4. Add `submitCuratorEdit` helper in `packages/core/src/queue/candidates.ts` — one tx: insert candidate → dispatch to `executeApprove` → `approveUpdate`. Bypasses `shouldAutoApprove` entirely.
5. Add `PUT /api/v1/documents/:id` route mapping conflict-error → 409 and success → 200 with `{ version, wikiEventId }`.
6. Add `saveNeuronEdit` client helper in `apps/admin/src/api.ts`.
7. Build `neuron-editor.tsx`: split view, title/tags inputs, Save/Cancel, ⌘+S + Esc shortcuts, dirty-state + `beforeunload` guard, 409-banner handling.
8. Add Edit/Read toggle on the reader; route to editor when `?edit=1`.
9. Wire "Open editor" deep-links from the relevant F90 action cards in `queue.tsx` (acknowledge-with-manual-reconcile, orphan-neuron link-to-sources, stale still-relevant's "edit" branch).
10. i18n sweep: Save, Cancel, conflict banner, stale-version warning, dirty-navigation confirm — both `en.json` and `da.json`.
11. Manual test plan above; no unit tests in v1 (covered by existing queue tests + a smoke run through `scripts/trail restart`).

## Dependencies

- F17 Curation Queue (done — all writes route through).
- F19 auto-approve policy (done — **not modified**; the editor's create-and-resolve path sits *beside* the policy, not inside it).
- F87 event stream (done — Save emits the normal wiki_event which event listeners already react to).

## Effort Estimate

**Small-to-medium** — 1-2 days focused. Bulk of the time is the split-view UI + dirty-state guard + keyboard/autosize polish; the server changes are half a day (`submitCuratorEdit` helper + `expectedVersion` guard + PUT route + smoke test).

## Unlocks

- "Reconcile manually" in contradiction-alerts becomes a real path (was: dead end text).
- "Link to sources" in orphan-neuron actions becomes actionable (edit the frontmatter, save).
- A curator can fix typos without touching the terminal.
- Foundation for a future "suggest edit" flow where non-owner users propose edits that land in the queue for the owner to approve.

## Handoff notes for the cc session picking this up

- Read `packages/core/src/queue/candidates.ts` first — `approveUpdate` is where the `expectedVersion` check lands, and `submitCuratorEdit` sits next to it. Study `executeApprove` so your new helper dispatches identically.
- Read `packages/core/src/queue/policy.ts` once and **do not modify it**. The `createdBy` short-circuit is load-bearing for F19's audit contract.
- Read `apps/admin/src/panels/wiki-reader.tsx` to see how Neurons are currently loaded + rendered. The editor can either be a sibling panel or a mode inside the reader; pick based on how much of the reader's fetch/useMemo logic you'd duplicate.
- Check `apps/admin/src/panels/queue.tsx` for the action-card render sites you'll deep-link from.
- The admin uses Preact; don't reach for React hooks libs that don't ship preact-compat.
- Follow the i18n pattern in `apps/admin/src/lib/i18n.ts` — every new string gets a key in both `en.json` and `da.json`.
- Test with `scripts/trail restart` + open the admin at `http://127.0.0.1:58031`.
- Announce the start via buddy (`mcp__buddy__announce`) so the main trail session knows not to touch the same files.
