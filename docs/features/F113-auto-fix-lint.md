# F113 — Auto-fix in Lint

> Tier: Solo-mode default-on, Curator-mode opt-in per rule. Effort: 2-3 days. Planned.

## Problem

Vores lint flagger problemer og lægger dem i queue som candidates for kurator. For Solo-brugere er det friktion — mange findings er trivielle ("fjern dead link") som LLM'en kunne fixe uden menneskelig intervention. Karpathy's design: "The LLM flags these issues and can fix many of them automatically."

## Secondary Pain Points

- Curator queue fyldes op med trivielle findings der kunne auto-fixes
- Ingen undo-mekanisme for lint findings — brugeren skal manuelt reverse en fix
- False-positive findings har ingen feedback-loop til at forbedre detector confidence

## Solution

Hver lint-detector får en `autoFixConfidence: 0-1`-score per finding. Over en threshold (fx 0.9) og hvis brugeren er i Solo-mode (eller har opt'ed auto-fix for denne rule i Curator), udfører LLM'en en direkte fix. Alle auto-fixes registreres i wiki_events med `actorKind='llm'` + `actor.id='system:auto-fix'`. Solo-mode Audit-view viser dem i kronologisk feed.

| Lint-rule | Auto-fix når... | Handling |
|---|---|---|
| Dead `[[wiki-link]]` (target archived) | target arkiveret i 30+ dage | fjern link, log i wiki_events |
| Duplicate concepts (2 Neurons, samme topic) | similarity ≥95 % | merge til newest, archive other, log |
| Missing frontmatter `type:` | kan udledes deterministisk af path | tilføj inferred type |
| Stale date field | >365 dage siden source-opdatering | refresh date til today |
| Orphan source (no Neurons cite) | >180 dage gammel + Neurons citerer samme emne | generer source-summary |

Contradiction-findings auto-fixes IKKE — semantisk for kompleks, altid kurator-beslutning.

## Non-Goals

- Auto-fix for contradiction findings (for kompleks, altid human review)
- AI-generated fix strategies beyond the 5 predefined rules above
- Real-time undo — 30-dages angre-vindue er max
- Auto-fix i Enterprise-mode uden eksplicit opt-in per rule

## Technical Design

### Extended LintFinding Type

```typescript
// apps/server/src/services/lint-scheduler.ts
interface LintFinding {
  docId: string;
  rule: string;
  confidence: number;
  message: string;
  autoFix?: {
    confidence: number;
    action: FixAction;
    dryRunDescription: string;
  };
}

type FixAction =
  | { type: 'remove-link'; linkText: string; targetId: string }
  | { type: 'merge-neurons'; keepId: string; archiveId: string }
  | { type: 'add-frontmatter'; key: string; value: string }
  | { type: 'refresh-date'; field: string; newValue: string }
  | { type: 'generate-summary'; sourceId: string };
```

### Auto-fix Effect

```typescript
// apps/server/src/queue/approve.ts (extended)
interface CandidateEffect {
  type: 'auto-fix';
  findingId: string;
  action: FixAction;
  bypassesHumanApproval: true;
}
```

### Runner Logic

```typescript
// apps/server/src/services/lint-scheduler.ts
async function processAutoFixes(findings: LintFinding[], mode: 'solo' | 'curator') {
  for (const f of findings) {
    if (!f.autoFix) continue;
    const threshold = mode === 'solo' ? 0.9 : 0.95;
    if (f.autoFix.confidence >= threshold && isAutoFixEnabledForRule(f.rule)) {
      await executeAutoFix(f.docId, f.autoFix.action);
      logWikiEvent('auto-fix', { findingId: f.id, action: f.autoFix.action });
    }
  }
}
```

### Audit View

Solo-mode Audit-view viser auto-fixes i kronologisk feed med "Auto-fixed: {description} — Undo"-link (30 dages angre-vindue).

## Interface

```typescript
// Config: per-rule auto-fix enablement
interface AutoFixConfig {
  rules: Record<string, { enabled: boolean; threshold: number }>;
  mode: 'solo' | 'curator';
  undoWindowDays: number; // default 30
}

// GET /api/v1/settings/auto-fix → AutoFixConfig
// PUT /api/v1/settings/auto-fix → 200 { updated }

// POST /api/v1/auto-fix/:eventId/undo → 200 { reverted }
```

## Rollout

**Phased deploy:**
1. Ship `LintFinding.autoFix` field + confidence scoring (no auto-execution)
2. Enable auto-fix for dead-link rule only (lowest risk)
3. Enable remaining rules one by one with feature flags
4. Ship Solo-mode default-on, Curator-mode opt-in

## Success Criteria

- Dead-link-fix udføres uden manuel intervention i Solo-mode (<500ms per fix)
- Audit-view viser fix med begrundelse + undo-link
- False-positive rate <2 % (målt ved at kurator "Undo"-klik skal være sjældent)
- Marketing: "Your knowledge base heals itself"

## Impact Analysis

### Files created (new)
- `apps/server/src/services/auto-fix-executor.ts`
- `apps/server/src/routes/auto-fix-settings.ts`

### Files modified
- `apps/server/src/services/lint-scheduler.ts` (add autoFix field, dispatch logic)
- `apps/server/src/services/contradiction-lint.ts` (add autoFix confidence scoring)
- `packages/shared/src/types.ts` (extend LintFinding interface)
- `apps/server/src/app.ts` (mount auto-fix settings route)

### Downstream dependents
`apps/server/src/services/lint-scheduler.ts` is imported by 4 files:
- `apps/server/src/index.ts` (1 ref) — starts lint scheduler, unaffected
- `apps/server/src/services/access-tracker.ts` (1 ref) — references lint-scheduler types, unaffected
- `apps/server/src/services/access-rollup.ts` (1 ref) — references lint-scheduler types, unaffected
- `apps/server/src/services/lint-scheduler.ts` (12 self-refs) — internal, needs update

`apps/server/src/services/contradiction-lint.ts` is imported by 4 files:
- `apps/server/src/index.ts` (1 ref) — starts contradiction lint, unaffected
- `apps/server/src/services/source-inferer.ts` (2 refs) — uses contradiction types, unaffected
- `apps/server/src/services/lint-scheduler.ts` (2 refs) — subscribes to events, needs update for autoFix field
- `apps/server/src/services/contradiction-lint.ts` (7 self-refs) — internal

`packages/shared/src/types.ts` — imported by server routes and admin client. Additive change.

`apps/server/src/app.ts` is imported by 1 file:
- `apps/server/src/index.ts` (1 ref) — creates app, unaffected

### Blast radius

- `LintFinding` type extension is additive — existing consumers that don't read `autoFix` are unaffected
- Auto-fix execution modifies documents directly — must be wrapped in transaction for rollback safety
- Audit feed new event type — existing event consumers must handle `auto-fix` type gracefully
- 30-day undo window requires storing pre-fix state somewhere (wiki_events snapshot or separate table)

### Breaking changes

None — all changes are additive to existing types and behavior.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] LintFinding with autoFix confidence ≥0.9 triggers auto-fix in Solo-mode
- [ ] LintFinding with autoFix confidence <0.9 queues as normal candidate
- [ ] Dead-link auto-fix removes link, logs wiki_event, does not corrupt document
- [ ] Undo within 30 days reverts document to pre-fix state
- [ ] Undo after 30 days returns 410 Gone
- [ ] Contradiction findings NEVER auto-fix regardless of confidence
- [ ] Regression: existing lint queue flow unchanged for findings without autoFix
- [ ] Regression: curator approve/reject flow unaffected

## Implementation Steps

1. Extend `LintFinding` type with `autoFix?: { confidence, action, dryRunDescription }` in `packages/shared/src/types.ts`.
2. Implement `apps/server/src/services/auto-fix-executor.ts` with `executeAutoFix(docId, action)` for each FixAction type.
3. Update `lint-scheduler.ts` to call auto-fix dispatcher when confidence threshold met and mode allows.
4. Add `autoFix` confidence scoring to each lint detector (contradiction-lint.ts, etc.) — contradiction always returns undefined.
5. Create `apps/server/src/routes/auto-fix-settings.ts` for GET/PUT auto-fix config.
6. Add undo endpoint `POST /auto-fix/:eventId/undo` with 30-day window check.
7. Update Solo-mode Audit-view to render auto-fix events with undo link.

## Dependencies

- F106 (Solo-mode) — primary consumer of auto-fix behavior
- F118 (sampling) — auto-fix must respect sampling budget

## Open Questions

None — all decisions made.

## Related Features

- **F106** (Solo-mode) — auto-fix is default-on in Solo
- **F118** (Contradiction-Scan Sampling) — auto-fix respects sampling budget
- **F119** (Parallel Contradiction Runner) — auto-fix can run in parallel within a pass

## Effort Estimate

**Small** — 2-3 days.
- Day 1: Type extension + auto-fix executor service
- Day 2: Lint scheduler integration + settings endpoint
- Day 3: Audit UI + undo logic + testing
