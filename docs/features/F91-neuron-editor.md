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
- Edit metadata too: title, path, tags, YAML frontmatter (`sources:`, any custom keys).
- Save: writes a queue candidate with `kind: 'user-correction'` + `op: 'update'`; the F19 auto-approval policy fires for curator-role users (owners + curators), landing the change as a wiki page immediately via the usual approval path — audit trail preserved through `wiki_events`.
- Optimistic concurrency: reject save if the doc's `version` has advanced since the editor loaded (someone else edited while you were typing).
- Cancel: discards local changes, no DB write.

**Out of scope (v1):**
- Collaborative editing (two people at once) — server rejects stale-version saves, UI tells you to reload.
- Visual editor / WYSIWYG — v1 is a plain textarea with markdown preview pane (split view).
- Backlink auto-repair — if a rename orphans inbound `[[links]]`, those stay broken. F15 iter 3 could wire automatic rewrites.
- Create-new-Neuron from the admin — keep that in the queue-candidate path; this feature is edit-only for already-existing Neurons.

## Why it lives in the admin (not just MCP)

The MCP `write` tool already works for cc sessions. But Sanne is not a cc user; she's a curator staring at a "Reconcile manually" button. If that path is "open a terminal and type `trail` MCP commands", we've punted on the UX. Admin editor = first-class curator tool.

## Design

### Route

`/kb/:kbId/neurons/:slug` already exists as the reader. Add a `?edit=1` query param that flips the view into edit mode. Keeps the URL stable (back button, bookmarks, shares), doesn't need a separate route.

### Auth

The Neuron reader uses session-cookie auth (`requireAuth` middleware). Editor inherits. No role gating in v1 — any authenticated user in a tenant can edit any Neuron there. Owner-vs-curator role gating can be added later if multi-role tenants show up in practice.

### Save path: queue candidate, not direct write

Keep the F17 invariant (queue is the sole write path). Save produces:

```ts
POST /api/v1/queue/candidates
{
  knowledgeBaseId,
  kind: 'user-correction',
  title: '<updated Neuron title>',
  content: '<full new markdown, frontmatter included>',
  metadata: JSON.stringify({
    op: 'update',
    targetDocumentId: '<doc id>',
    expectedVersion: <doc.version at load>,
  }),
  confidence: 1,
}
```

The F19 auto-approve policy today has `'user-correction'` outside `TRUSTED_KINDS`, so it lands pending. Before shipping: add `'user-correction'` with a user-role actor to the auto-approve path so the edit commits immediately when a curator submits it. **Design decision to confirm before implementation:** do user corrections auto-approve (feel like a local edit) or wait in the queue (another curator reviews)? Single-curator trails probably want auto-approve; multi-curator trails (future) might want review. Starting with auto-approve for single-tenant cases + env toggle `TRAIL_AUTO_APPROVE_USER_CORRECTIONS=1`.

### Optimistic concurrency

Core's `resolveCandidate > approveUpdate` needs a new guard: if `metadata.expectedVersion` is present and the target doc's current version ≠ expectedVersion, throw `409 Conflict` with a message like "The Neuron was edited since you opened it. Reload to see the latest version." UI catches 409 and shows a banner with a "Reload and resolve manually" button.

### UI layout

Split view:
- Left pane: `<textarea>` with the raw markdown (frontmatter + body).
- Right pane: live markdown preview (marked.parse + rewriteWikiLinks).
- Header: title input, path input, tags input, version indicator, "Save" + "Cancel" buttons.
- Footer hint: "⌘+S to save · Esc to cancel".

Textarea auto-grows with content; no fixed height. Tailwind utility classes only, no new npm dep.

## Impact Analysis

### Files affected

- New: `apps/admin/src/panels/neuron-editor.tsx` — the split-view editor component.
- Modify: `apps/admin/src/panels/wiki-reader.tsx` (or whatever hosts the current read-only view) — add the "Edit" toggle button that sets `?edit=1`.
- Modify: `apps/admin/src/api.ts` — helper `saveNeuronEdit(docId, { title, content, path, tags, expectedVersion })` that posts the queue candidate.
- Modify: `packages/core/src/queue/candidates.ts > approveUpdate` — read `op.expectedVersion`, throw on mismatch.
- Modify: `packages/core/src/queue/policy.ts` — conditional auto-approve for `'user-correction'` gated on `TRAIL_AUTO_APPROVE_USER_CORRECTIONS`.
- i18n: new keys in `apps/admin/src/locales/{en,da}.json` for editor chrome (Save, Cancel, conflict banner, stale-version warning).

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

- Open a Neuron, click Edit, change title + body, Save → see the change on re-open.
- Edit, Cancel → changes discarded, no DB write.
- Open the same Neuron in two tabs. Save in tab A, then save in tab B → tab B gets a 409 banner.
- Edit a Neuron that has `sources: [...]` in frontmatter → after save, the reference-extractor re-parses (verify via DB query on `document_references`).
- Edit without `TRAIL_AUTO_APPROVE_USER_CORRECTIONS` set → candidate lands in the queue as pending, not live.
- Edit with the flag set → Neuron updates immediately, badge doesn't show a new pending.

## Implementation Steps

1. Add `expectedVersion` handling to `approveUpdate` in core — 409 on mismatch.
2. Extend F19 policy for `'user-correction'` auto-approve under the flag.
3. Build `saveNeuronEdit` helper in admin API.
4. Build `neuron-editor.tsx` with split-view + wire Save/Cancel/keyboard shortcuts.
5. Add Edit/Read toggle on the existing reader component.
6. i18n sweep for new strings.
7. Add `TRAIL_AUTO_APPROVE_USER_CORRECTIONS=1` to `scripts/trail` defaults.
8. Manual test plan above; no unit tests in v1 (covered by existing queue tests + a smoke run).

## Dependencies

- F17 Curation Queue (done — all writes route through).
- F19 auto-approve policy (done — needs one new kind in TRUSTED_KINDS gated on env).
- F87 event stream (done — Save emits candidate_resolved which event listeners already react to).

## Effort Estimate

**Small-to-medium** — 1-2 days focused. Bulk of the time is the split-view UI + keyboard/autosize polish; the server changes are a day at most (expectedVersion check + policy tweak + smoke test).

## Unlocks

- "Reconcile manually" in contradiction-alerts becomes a real path (was: dead end text).
- "Link to sources" in orphan-neuron actions becomes actionable (edit the frontmatter, save).
- A curator can fix typos without touching the terminal.
- Foundation for a future "suggest edit" flow where non-owner users propose edits that land in the queue for the owner to approve.

## Handoff notes for the cc session picking this up

- Read `packages/core/src/queue/candidates.ts` first — the `approveUpdate` path is where the server-side concurrency check lands.
- Read `apps/admin/src/panels/wiki-reader.tsx` (or the equivalent) to see how Neurons are currently loaded + rendered.
- The admin uses Preact; don't reach for React hooks libs that don't ship preact-compat.
- Follow the i18n pattern in `apps/admin/src/lib/i18n.ts` — every new string gets a key in both `en.json` and `da.json`.
- Test with `scripts/trail restart` + open the admin at `http://127.0.0.1:58031`.
- Announce the start via buddy (`mcp__buddy__announce`) so the main trail session knows not to touch the same files.
