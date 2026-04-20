# F135 — Slug-based KB URLs

> Admin routes today carry a UUID in the path: `/kb/6aa52746-d235-464c-b038-d7e1965e3622/queue`. Onboarding already asks the user to pick a slug (`sanne-andersen`, `suparoo`) and the `knowledge_bases.slug` column has been populated since F04. Wire that slug through to the URL so the admin URL reads `/kb/sanne-andersen/queue` — and so the onboarding copy `admin.trailmem.com/kb/<slug>` is a promise we actually keep.

## Problem

1. Every shared admin link exposes a 36-char UUID. Unshareable by humans, unreadable in chat/Slack, and breaks the mental model the onboarding flow sets up ("your Trail lives at `admin.trailmem.com/kb/suparoo`").
2. Customers renaming their Trail (changing the slug) has no URL path forward — the slug is a display name, not a route key.

## Solution

Accept **either** slug or UUID in the `:kbId` route param across backend + admin. UUID lookups keep their O(1) primary-key path; slug lookups hit the existing `knowledge_bases_slug_idx` unique index (also O(1)). Clients stop caring which form the URL carries.

## Technical Design

### Backend — `resolveKbId(identifier)` helper

`packages/core/src/kb/resolve.ts`:

```ts
export async function resolveKbId(
  trail: TrailDatabase,
  tenantId: string,
  identifier: string,
): Promise<string | null> {
  // UUID shape → try primary key first. A slug that happens to look
  // like a UUID would be legitimately malformed — we don't support it.
  if (UUID_RE.test(identifier)) {
    const row = await trail.db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, identifier), eq(knowledgeBases.tenantId, tenantId)))
      .get();
    return row?.id ?? null;
  }
  // Otherwise slug lookup — index-backed, same O(1) cost.
  const row = await trail.db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.slug, identifier), eq(knowledgeBases.tenantId, tenantId)))
    .get();
  return row?.id ?? null;
}
```

Every route that currently does `eq(queueCandidates.knowledgeBaseId, kbId)` needs the incoming `kbId` param resolved first. Done as a Hono middleware:

```ts
// apps/server/src/middleware/resolve-kb.ts
export async function resolveKbMiddleware(c: Context, next: Next) {
  const raw = c.req.param('kbId');
  if (!raw) return next();
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const id = await resolveKbId(trail, tenant.id, raw);
  if (!id) return c.json({ error: 'Knowledge base not found' }, 404);
  c.set('kbId', id);
  return next();
}
```

Handlers read `c.get('kbId')` (already-resolved UUID) instead of `c.req.param('kbId')`. Single surgical touch point per route family.

### Admin — router stays as-is

The admin's `preact-iso` route patterns (`/kb/:kbId/queue` etc.) don't care what the segment contains. No client-side router change. Existing `route.params.kbId` holds whatever the URL had — slug or UUID — and every API call simply forwards that to the backend. The backend resolves it.

The admin keeps using the UUID internally (SSE subscriptions, cached state keyed by kbId) to avoid needing a second round-trip. A new utility `useResolvedKbId(slugOrId)` does the resolve-and-cache on first render, then every subsequent API call passes the canonical UUID.

Alternative considered + rejected: make the admin rewrite every URL to the canonical form on load. Adds a redirect for every deep-link, and breaks back-button semantics. Not worth it — the backend's dual-accept is cheaper.

### Onboarding → real URL

Onboarding's slug-preview currently reads `trail.webhouse.dk/kb/<slug>`. Post-F135 that becomes a promise we actually serve (once admin is at `admin.trailmem.com`). F135 does NOT ship the prod hostname — it ships the slug-routing that lets the hostname land later. Onboarding copy stays; `apps/onboarding/src/screens.tsx:220` flips to `admin.trailmem.com/kb/` when F33 + DNS ships.

### Aliases (out of scope, noted)

Suparoo as a demo-trail alias would be a second column (`aliases: text[]` JSON) on `knowledge_bases`. F135 resolves this via slug only — if Christian wants `suparoo` as an alias for `demo-brain` without renaming the slug, that's a follow-up (F135.1) that adds a second lookup path in `resolveKbId`. Keeping v1 lean.

## Impact Analysis

### Files affected

**New:**
- `packages/core/src/kb/resolve.ts` — the `resolveKbId` helper.
- `apps/server/src/middleware/resolve-kb.ts` — Hono middleware applying it.

**Modified:**
- `packages/core/src/index.ts` — re-export `resolveKbId`.
- Every route file with `:kbId` in its path gets the middleware bound:
  - `apps/server/src/routes/knowledge-bases.ts`
  - `apps/server/src/routes/documents.ts`
  - `apps/server/src/routes/search.ts`
  - `apps/server/src/routes/chat.ts`
  - `apps/server/src/routes/queue.ts`
  - `apps/server/src/routes/lint.ts`
  - `apps/server/src/routes/ingest.ts`
  - `apps/server/src/routes/uploads.ts`
- Each handler reads `c.get('kbId')` where it previously did `c.req.param('kbId')`.

**No changes:** DB schema, migrations, admin router, SSE stream, MCP server (its `kbId` args stay UUID — agents don't need human-readable slugs).

### Downstream dependents

- Existing UUID-shaped URLs keep working (dual-accept). No broken bookmarks.
- Chat widget / CMS connector: likewise. Both send UUIDs today; they'll keep working unchanged.
- MCP `guide`/`search`/`read` tools: unchanged. Agents operate on UUIDs.

### Blast radius

Zero production risk — local Phase 1, and the change is purely additive (slug lookup is a NEW code path; UUID path untouched). Failure mode: slug lookup returns null → 404 on an unknown slug, same as an unknown UUID. No crash path.

### Breaking changes

None. Every existing URL, API call, stored link continues to resolve.

### Test plan

- [ ] `GET /api/v1/queue?knowledgeBaseId=sanne-andersen&status=pending` returns the same result as `?knowledgeBaseId=<UUID>`
- [ ] `GET /api/v1/knowledge-bases/sanne-andersen/documents` = same as UUID form
- [ ] Admin: navigate to `/kb/sanne-andersen/queue` → renders Sanne's queue (no 404)
- [ ] Admin: navigate to `/kb/<UUID>/queue` → still works (backward compat)
- [ ] Unknown slug `/kb/nosuchkb/queue` → 404 with clear error
- [ ] Slug belonging to a different tenant → 404 (tenant isolation holds)

## Implementation Steps

1. `resolveKbId` helper + UUID regex detection in `packages/core/src/kb/resolve.ts`.
2. `resolveKbMiddleware` in `apps/server/src/middleware/resolve-kb.ts`.
3. Bind the middleware to each `/kb/:kbId` route group; update handlers to read `c.get('kbId')`.
4. In admin, the queue-param flows (`?knowledgeBaseId=<raw>`) forward the URL segment verbatim; nothing to change there — backend resolves.
5. Typecheck clean across all workspaces.
6. Manual smoke: navigate to `/kb/sanne-andersen/queue`, `/kb/<UUID>/queue`, `/kb/nope/queue`.

## Dependencies

- None. Standalone refactor, purely additive.

## Unlocks

- F33 admin subdomain (`admin.trailmem.com/kb/<slug>`) becomes a real URL when DNS + deploy land.
- F134 onboarding's slug-preview promise becomes a truth.
- Future F135.1 alias-column is a one-line change once this resolver exists.

## Effort Estimate

**Small** — 2-3 hours including test pass. Most of the cost is the mechanical route-handler touch-up; the resolver + middleware themselves are ~40 lines.
