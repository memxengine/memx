# F150 — Admin Link-Report Panel

> Visuel curator-facing view i admin-UI af F148's `broken_links`-findings. Liste af åbne broken links pr. KB med source-Neuron + link-text + suggested_fix + reported_at; actions for accept/dismiss/reopen + en "Kør scan nu"-knap. Live-opdatering via eksisterende SSE-event-stream (F87) når `candidate_approved` fyrer — curator ser nye findings dukke op i real-time efter en ingest. Inkluderer manglende `POST /link-check/:id/accept`-route der anvender `suggested_fix` via str_replace på doc.content og flipper status til `auto_fixed`. Tier: alle tenants. Effort: Small — 1-1.5 dage. Status: Planned.

## Problem

F148 shippede `broken_links`-tabellen + link-checker-servicen + fire HTTP-routes (`GET /link-check`, `POST /link-check/rescan`, `POST /link-check/:id/dismiss`, `POST /link-check/:id/reopen`) — men der er ingen curator-facing UI. Curator er i dag tvunget til at bruge `curl` for at se om der er åbne broken-link-findings i sin Trail. Det er ubrugeligt i praksis: den hard rule ("0 × 404 i en hjerne") bliver kun håndhævet hvis curator **ser** findings hurtigt efter en ingest og kan handle på dem.

Derudover mangler F148's **accept-action** — dvs. "anvend `suggested_fix` på source-Neuron'ens content". F148's verifikations-probe testede kun dismiss/reopen-pathet, men ikke accept (fordi accept kræver content-rewrite + version-bump). F150 lukker det hul.

Uden panelet + accept:
- Findings hober sig op i `broken_links`-tabellen usynligt
- Curator kan ikke benytte `suggested_fix` uden manuel SQL eller Neuron-editor-roundtrip
- "Hard rule: 0 × 404" er ikke operationaliseret

## Secondary Pain Points

- **Ingen SSE-binding**: admin UI genafhenter Queue + Chat panels via SSE (`candidate_*`-events) men broken-link-findings fanges i dag ikke op før næste page-refresh.
- **Intet per-KB overview**: KB-Settings panel viser diverse KB-metadata men ikke om der er åbne link-findings. Curator der vælger mellem KB'er ved ikke hvilke der har "hot" work.
- **Ingen rescan-trigger**: efter en bulk-edit (fx rename af flere Neuroner) vil curator se konsekvenserne med det samme, ikke vente på nightly sweep.
- **F148 har `queue_candidates`-integration-hul**: plan-doc'en nævnte at broken links kunne dukke op som `'broken-link-alert'`-candidates i den primære Queue. Det skippede jeg i F148-implementering for at holde scope stramt. F150 beslutter: vi ship'er et dedikeret link-report-panel (ikke queue-integration), fordi visning + actions er tilstrækkeligt anderledes fra Queue-candidates (ingen effect-pipeline, ingen auto-approval-policy) til at det ikke er værd at klemme ind i den eksisterende queue.

## Solution

Tre delkomponenter:

1. **`apps/admin/src/panels/link-report.tsx`** — ny panel-komponent. Route: `/kb/:kbId/link-check`. Viser findings i en tabel; rækker har `[Accept]` / `[Dismiss]`-knapper (eller `[Reopen]` på dismissed). Footer-bar med "Kør scan nu"-knap der kalder `/link-check/rescan`. Live-opdatering via `CandidateApprovedEvent`-SSE-subscriber — når hvilket som helst doc committer, re-fetcher panelet findings-listen.

2. **Server-route `POST /link-check/:id/accept`** — manglende fra F148. Løser `suggested_fix` på source-Neuron'en:
   - Læs doc.content
   - str_replace `[[<linkText>]]` → `<suggested_fix>` (som allerede er i `[[...]]`-form)
   - Version-bump via eksisterende `saveNeuronEdit`-path (eller et dedikeret helper)
   - Flip `broken_links.status='auto_fixed'`, sæt `fixed_at=now()`
   - Returner nye document-version + fixed-count

3. **Nav-integration**: lille badge på siden-nav's Trail-link der viser count af åbne findings for den aktive KB (ala Queue-panelet's nye-candidate-badge). Klik → panel.

## Non-Goals

- **Auto-accept uden curator-indblanding.** F148 Lag 2's URL-fallback håndterer allerede de deterministiske tilfælde (fold-resolver uden rewrite). Alt der kommer som broken_link-finding kræver per-definition curator-skøn; auto-accept ville reintroducere den "LLM-slop"-risiko F148 netop adresserer.
- **Fuzzy search i findings.** Liste per KB er bounded (typisk ~dusin åbne findings selv i 500-Neuron-KB); grov filtrering via sort + status-filter er nok. Hvis det vokser, er F32-queue-filter-patternet standard.
- **Cross-KB link-report.** Findings er scopet pr. KB; cross-Trail search og findings-aggregation er en Phase 2/3-feature.
- **Bulk-accept.** En `[Accept all with unambiguous suggested_fix]`-knap er fristende men farlig — én fejl-suggestion rewriter N neuroner forkert. Curator accepterer én-ad-gangen i v1; bulk overvejes når vi har data på false-positive-rate.
- **Historisk graf af link-integrity over tid.** F141 access-rollup-mønsteret kunne bruges til at vise "broken_links over 30 dage" — nice men ikke v1.
- **Editable `suggested_fix`**: curator kan ikke i v1 ændre `suggested_fix`-teksten før accept. Hvis den forslåede fix er forkert, curator dismisser + manuelt retter i Neuron-editoren. v2 kunne tillade in-place-edit af suggestion.

## Technical Design

### Panel-komponent

Fil: `apps/admin/src/panels/link-report.tsx`.

```typescript
import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { useKb } from '../lib/kb-cache';
import { useSse } from '../lib/sse';
import { getLinkCheckFindings, acceptLinkFix, dismissLinkFinding, reopenLinkFinding, rescanLinkCheck, ApiError } from '../api';
import { t } from '../lib/i18n';

export function LinkReportPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const kb = useKb(kbId);
  const [findings, setFindings] = useState<LinkFinding[] | null>(null);
  const [rescanning, setRescanning] = useState(false);

  // SSE: re-fetch on candidate_approved (any doc in this KB committed).
  useSse((evt) => {
    if (evt.type === 'candidate_approved' && evt.kbId === kbId) {
      void fetchFindings();
    }
  }, [kbId]);

  // Rows: title | link-text | suggested_fix | reportedAt | actions
  // Actions: Accept (if suggested_fix) | Dismiss | (Reopen if dismissed)
  // Footer: [Kør scan nu] calls /link-check/rescan
}
```

Styling: genbrug tabel-mønster fra `apps/admin/src/panels/work.tsx` (samme Shadcn/tailwind-palette). Empty-state: stort grønt tjek-ikon + "Ingen broken links — din brain er intakt." (Lucide).

### Route: POST /link-check/:id/accept

Tilføj i `apps/server/src/routes/lint.ts` (samme fil som de øvrige F148-link-check-routes):

```typescript
lintRoutes.post('/link-check/:id/accept', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const id = c.req.param('id');

  const finding = await trail.db
    .select({
      id: brokenLinks.id,
      fromDocumentId: brokenLinks.fromDocumentId,
      linkText: brokenLinks.linkText,
      suggestedFix: brokenLinks.suggestedFix,
      status: brokenLinks.status,
    })
    .from(brokenLinks)
    .where(and(eq(brokenLinks.id, id), eq(brokenLinks.tenantId, tenant.id)))
    .get();
  if (!finding) return c.json({ error: 'Finding not found' }, 404);
  if (!finding.suggestedFix) return c.json({ error: 'No suggested fix available' }, 400);
  if (finding.status !== 'open') return c.json({ error: `Finding is ${finding.status}` }, 400);

  // Load current content + version for optimistic-lock.
  const doc = await trail.db
    .select({ id: documents.id, content: documents.content, version: documents.version })
    .from(documents)
    .where(eq(documents.id, finding.fromDocumentId))
    .get();
  if (!doc || !doc.content) return c.json({ error: 'Source doc not found or empty' }, 404);

  const oldLink = `[[${finding.linkText}]]`;
  if (!doc.content.includes(oldLink)) {
    // Link was already rewritten or doc changed since finding — flip
    // status to dismissed with a note rather than silently fail.
    await trail.db
      .update(brokenLinks)
      .set({ status: 'dismissed', fixedAt: new Date().toISOString() })
      .where(eq(brokenLinks.id, id))
      .run();
    return c.json({ error: 'Link no longer present; dismissed', dismissed: true }, 409);
  }

  const newContent = doc.content.replaceAll(oldLink, finding.suggestedFix);
  // Use existing Neuron-edit path so version-bump + wiki-events + backlink
  // re-extraction fire identically to a curator edit in the editor.
  await saveNeuronEdit(trail, {
    docId: doc.id,
    content: newContent,
    baseVersion: doc.version,
    tenantId: tenant.id,
    userId: user.id,
  });

  await trail.db
    .update(brokenLinks)
    .set({ status: 'auto_fixed', fixedAt: new Date().toISOString() })
    .where(eq(brokenLinks.id, id))
    .run();

  return c.json({ accepted: true, newVersion: doc.version + 1 });
});
```

`saveNeuronEdit` er enten et eksisterende helper i `@trail/core` (via queue) eller en ny tynd wrapper — at tjekke ved implementation-start. Hvis ikke eksisterer: brug direkte `documents`-UPDATE + `wiki_events`-insert-pattern der allerede bruges i `apps/server/src/routes/documents.ts`.

### API client

Tilføj i `apps/admin/src/api.ts`:

```typescript
export interface LinkFinding {
  id: string;
  fromDocumentId: string;
  fromFilename: string;
  fromTitle: string | null;
  linkText: string;
  suggestedFix: string | null;
  status: 'open' | 'auto_fixed' | 'dismissed';
  reportedAt: string;
}

export function getLinkCheckFindings(kbId: string): Promise<{ findings: LinkFinding[] }> {
  return api(`/knowledge-bases/${kbId}/link-check`);
}

export function acceptLinkFix(id: string): Promise<{ accepted: true; newVersion: number }> {
  return api(`/link-check/${id}/accept`, { method: 'POST' });
}

export function dismissLinkFinding(id: string): Promise<{ dismissed: true }> {
  return api(`/link-check/${id}/dismiss`, { method: 'POST' });
}

export function reopenLinkFinding(id: string): Promise<{ reopened: true }> {
  return api(`/link-check/${id}/reopen`, { method: 'POST' });
}

export function rescanLinkCheck(kbId: string): Promise<{ docsScanned: number; openRecorded: number; resolved: number }> {
  return api(`/knowledge-bases/${kbId}/link-check/rescan`, { method: 'POST' });
}
```

### Router + nav

`apps/admin/src/main.tsx`: tilføj `<Route path="/kb/:kbId/link-check" component={LinkReportPanel} />` (mellem `/graph` og `/work`).

`apps/admin/src/app.tsx` (sidebar): tilføj nav-item "Link Check" med badge-count fra ny `useLinkCheckCount(kbId)`-hook der abonnerer på `candidate_approved`-SSE og re-fetcher.

## Interface

**HTTP (ny):**
- `POST /api/v1/link-check/:id/accept` → `{ accepted: true, newVersion: number }` | 400/404/409

**HTTP (genbrugt fra F148):**
- `GET  /api/v1/knowledge-bases/:kbId/link-check`
- `POST /api/v1/knowledge-bases/:kbId/link-check/rescan`
- `POST /api/v1/link-check/:id/dismiss`
- `POST /api/v1/link-check/:id/reopen`

**Admin route (ny):**
- `/kb/:kbId/link-check` → `LinkReportPanel`

**Shared module (ny):**
- `LinkFinding`-type eksporteret fra `apps/admin/src/api.ts` (UI-only, ikke `@trail/shared` — den er server-specific shape).

## Rollout

**Enkelt-fase deploy**, ingen migration eller DB-ændring (tabellen er fra F148). Panel aktiveres idet deployment går live; eksisterende `broken_links`-data rendrer med det samme. Intet feature-flag nødvendigt.

## Success Criteria

1. **Panel renderer åbne findings pr. KB inden for 300ms efter mount** på en KB med op til 100 åbne findings. Målt via Chrome DevTools Performance.
2. **Accept-knap resulterer i korrekt content-rewrite.** Verifikations-script indsætter et doc med `[[wrong-text]]`, en broken_links-row med `suggested_fix='[[right-text]]'`, kalder `POST accept`. Assert: doc.content har byttet `[[wrong-text]]` til `[[right-text]]`, version bumpet med +1, broken_links.status='auto_fixed', wiki_events-række oprettet.
3. **SSE live-update funklar**: Chrome DevTools MCP observerer panel'et; trigger ingest af en ny source; panel re-fetcher findings uden page-reload. Verificér via network-tab at GET /link-check fires efter candidate_approved-SSE-event.
4. **Empty-state rendrer når 0 åbne findings**: tjek-ikon + "Ingen broken links" streng. Ingen spinner låst fast.
5. **Accept på allerede-rewrittet indhold gracefully dismisses**: finding hvor linkText ikke længere er i content returnerer 409 + status='dismissed'. Panel viser "(dismissed — no longer present)" badge i stedet for at crashe.
6. **Rescan-knap viser loading-state + resultat-toast**: "Scanned 27 Neurons, 3 open / 24 resolved".

## Impact Analysis

### Files created (new)

- `docs/features/F150-admin-link-report-panel.md` — dette plan-dokument.
- `apps/admin/src/panels/link-report.tsx` — panel-komponent.
- `apps/admin/src/lib/use-link-check-count.ts` — lille hook til nav-badge.
- `apps/server/scripts/verify-link-accept.ts` — end-to-end probe for accept-routen.

### Files modified

- `apps/server/src/routes/lint.ts` — tilføj `POST /link-check/:id/accept`-route.
- `apps/admin/src/api.ts` — tilføj 5 nye klient-funktioner + `LinkFinding`-type.
- `apps/admin/src/main.tsx` — tilføj `Route path="/kb/:kbId/link-check"`.
- `apps/admin/src/app.tsx` — tilføj "Link Check"-nav-item med badge.

### Downstream dependents

**`apps/server/src/routes/lint.ts`** er monteret i `apps/server/src/app.ts` (1 ref, leaf) — ingen downstream consumers udover mount.

**`apps/admin/src/api.ts`** importeret af ~15 admin-panels. Nye eksporter er additive; eksisterende signaturer uændrede.

**`apps/admin/src/main.tsx`** — root-komponent, ingen downstream.

**`apps/admin/src/app.tsx`** — app shell, ingen downstream.

### Blast radius

- **Accept-routen bruger `document_references`/`wiki_backlinks`/`wiki_events`-chain.** Content-rewrite trigger backlink-extractor via candidate_approved-event. Hvis rewrite flytter et link væk fra den gamle target, kan backlinks-graph-kanter forsvinde — hvilket er ønsket adfærd, men curator skal kunne se konsekvensen. Accept-toast bør vise "Rewrote link; X backlinks now point elsewhere."
- **Version-conflict**: hvis curator redigerer Neuron'en i editor parallelt med et accept, får accept 409 via optimistic-lock. Håndteres med klar toast; curator retry'er.
- **Accept-loop**: content-rewrite trigger ny link-check-rescan via candidate_approved-subscriber. Rescannet kan finde NYE broken links (hvis suggested_fix havde typo). Det er fint — ny finding lander, curator afgør.
- **SSE stream allerede etableret** (F87). Panel abonnerer uden at åbne ny forbindelse. Zero incremental network-cost.

### Breaking changes

**Ingen — alle ændringer er additive.**

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `replaceAll([[old]], [[new]])` kun rammer præcis `[[old]]`-forekomster, ikke substrings
- [ ] Integration: seed doc med `[[wrong-probe]]` + broken_links-row med `suggested_fix='[[right-probe]]'` → POST accept → assert content rewritten + version bumped + row auto_fixed
- [ ] Integration: POST accept når linkText ikke længere i content → 409 + row dismissed
- [ ] Integration: POST accept på row uden suggested_fix → 400
- [ ] Integration: POST accept på row status='dismissed' → 400
- [ ] Integration: panel mount → GET /link-check kaldes → rækker renderer i forventet rækkefølge
- [ ] Integration: SSE-event `candidate_approved` for samme kbId → panel re-fetcher automatisk (Playwright eller DevTools MCP)
- [ ] Manual Chrome DevTools MCP: navigér til Demo Brain's link-report; klik et finding's [Dismiss]; verificér at rækken opdaterer status uden reload
- [ ] Manual: [Accept] på et finding med suggested_fix; verificér at Neuron reader viser rewritten link efterfølgende
- [ ] Manual: [Kør scan nu] trigger + toast viser tal
- [ ] Regression: F148 verify-link-integrity.ts probe stadig grøn
- [ ] Regression: Queue-panelet (F17) uændret
- [ ] Regression: sidebar-badges fra F87 (Queue-count) uændret efter tilføjelse af Link-Check-badge

## Implementation Steps

1. **Server-side: POST /link-check/:id/accept**-route i `lint.ts` + verify-script. Commit. (grep: er `saveNeuronEdit` eller tilsvarende helper allerede i `@trail/core`? Hvis nej: brug direct UPDATE + wiki_events-pattern.)
2. **API client**: udvid `apps/admin/src/api.ts` med fem nye fns + `LinkFinding`-type. Typecheck.
3. **Panel**: ny `LinkReportPanel`-komponent. Basic table-rendering, actions, SSE-subscribe. Ingen fancy styling — kopier fra `work.tsx`.
4. **Route-registrering + nav**: `main.tsx`-route + `app.tsx`-sidebar-item. Ingen badge endnu.
5. **Badge + `useLinkCheckCount`-hook**: SSE-drevet counter. Render i sidebar.
6. **Accept-action med version-conflict + empty-state-handling**. Toast-feedback.
7. **Verifikation**: `verify-link-accept.ts` + Chrome DevTools MCP smoke-run på Demo Brain.
8. **Commit + push**.

## Dependencies

- **F148 Link Integrity** — tabellen + GET/dismiss/reopen-routes stammer fra F148.
- **F87 Typed Event Stream (SSE)** — live-update via `candidate_approved`.
- **F17 Curation Queue** — panel-styling-mønster + admin-route-pattern.
- **F18 Curator UI Shell** — Vite/Preact/shadcn-grundmønster.
- **F91 Neuron Editor** — accept-routen bruger samme version-bump-path.

## Open Questions

1. **Reuse `saveNeuronEdit` eller direct UPDATE?** Hvis `@trail/core` har en helper der trigger version-bump + wiki_events-insert + backlink-rerun, skal den genbruges. Hvis ikke, er direct UPDATE + manual emit `candidate_approved` en acceptabel simplifikation. Bekræft ved implementation-start.
2. **Skal accept skrive til Queue som "editor-edit"-candidate først eller rewrite direct?** Argumenter for queue-path: consistent med F17 sole-wiki-write-path-princip. Argumenter mod: det er en deterministisk UI-drevet accept af en allerede-reviewed-suggestion, ikke en ny candidate der kræver review. **Min recommendation: direct rewrite (som F148-accept-flow)**. Rationale: curator har allerede reviewed ved at klikke Accept; en mellemliggende queue-step er kognitiv støj.
3. **Version-conflict copy**: "Neuron blev ændret af en anden — genindlæs og prøv igen" ? Dansk vs engelsk? KB-sprog styrer alle andre toasts.

## Related Features

- **Depends on:** F148 (broken_links + routes), F87 (SSE), F17/F18 (admin shell).
- **Enables:** En fremtidig "Link-integrity-dashboard" pr. tenant (cross-KB); heatmap af broken-link-tæthed i graph-view.
- **Complements:** F99 (Graph) — åbne broken-link-findings kan render som rødt mærke på kant-kanden.

## Effort Estimate

**Small** — 1–1.5 dage.

- Server accept-route + probe: 3-4 timer.
- Panel + route + nav + badge: 4-6 timer.
- Manual smoke + polish: 1-2 timer.
