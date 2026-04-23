# F117 — Git-Versioning Export

> Tier: Pro+. Effort: 3 days. Planned.

## Problem

Trail har fuld version-historik via `wiki_events` + `contentSnapshot`, men den er DB-bundet. Avancerede brugere (udviklere, forskere) vil have git-native history for at kunne:
- `git log <neuron>.md` — se hele edit-historien
- `git blame` — hvilken source/candidate skabte hvilken linje
- `git diff main..feature` — eksperimentér med alternative compile-passes
- Push til egen GitHub for collab

## Secondary Pain Points

- Ingen måde at backup'e KB med fuld version history uden at clone DB
- Forskere kan ikke reproducere wiki-evolution over tid
- Manglende "git-native" differentiator vs. andre wiki-systemer

## Solution

Ny endpoint `POST /api/v1/knowledge-bases/:kbId/export/git` (længe-løbende job):

1. Initialisér tom git-repo i tmp-dir
2. Iterate `wiki_events` kronologisk; for hvert event:
   - Checkout files til state efter event (via `contentSnapshot`)
   - `git add`, `git commit` med commit-besked genereret fra event-type + candidate-title
3. ZIP-pack repo med `.git`-mappe
4. Return til bruger

For store KBs: job-based (async), notification når klar.

## Non-Goals

- Two-way sync (git → Trail) — export only
- Branching/merging within the exported repo (linear history only)
- Real-time git mirror (batch export on demand)
- Git LFS support for large assets

## Technical Design

### Git Exporter Service

```typescript
// apps/server/src/services/git-exporter.ts
interface GitExportJob {
  id: string;
  kbId: string;
  tenantId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  outputUrl?: string;
  commitCount?: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export async function exportToGitRepo(
  db: TrailDatabase,
  kbId: string,
  tmpDir: string,
  onProgress: (commitCount: number) => void
): Promise<string> {
  // Initialize git repo
  // Iterate wiki_events chronologically
  // For each event: checkout files, git add, git commit
  // Return path to ZIP file
}
```

### Commit Message Format

```
{event-type}: {candidate-title}

Actor: {actor-kind}:{actor-id}
Candidate: {candidate-id}
Auto-approved: {yes|no}

Co-Authored-By: Trail Ingest <trail@broberg.dk>
```

### Authorship Mapping

| actor_kind | Git Author |
|---|---|
| `user` | user.email (from tenants) |
| `llm` | `Trail LLM <trail-llm@broberg.dk>` |
| `system` | `Trail System <trail-system@broberg.dk>` |

### Implementation Choice

Brug `isomorphic-git` (ren JS, ingen shell-exec) eller spawn system-git. `isomorphic-git` preferred for portability.

## Interface

```typescript
// POST /api/v1/knowledge-bases/:kbId/export/git
→ 202 { jobId, estimatedCompletionTime }

// GET /api/v1/knowledge-bases/:kbId/export/git/:jobId
→ 200 { status, outputUrl?, commitCount? }
```

## Rollout

**Phased deploy:**
1. Ship git exporter service with isomorphic-git
2. Add job management endpoints
3. Add ZIP packaging + download
4. Test with 10k event KB for performance (target: 2-5 min)

## Success Criteria

- Eksport producerer fuld git-repo cloneable lokalt
- `git log` viser kronologisk wiki-history
- `git blame` afslører hvilken candidate der skabte hvilken linje
- Upload af eksporteret repo til GitHub lader brugeren dele Neurons som normal software-repo
- Performance: 10k events ≈ 2-5 min processeringstid

## Impact Analysis

### Files created (new)
- `apps/server/src/services/git-exporter.ts`
- `apps/server/src/routes/git-export.ts`

### Files modified
- `apps/server/src/app.ts` (mount git export route)
- `packages/db/src/schema.ts` (add git_export_jobs table)

### Downstream dependents
`apps/server/src/app.ts` is imported by 1 file:
- `apps/server/src/index.ts` (1 ref) — creates app, unaffected

`packages/db/src/schema.ts` is imported by 1 file:
- `packages/core/src/kb/resolve.ts` (1 ref) — reads document schema, unaffected by additive table

### Blast radius

- New table `git_export_jobs` — additive, no impact on existing queries
- Temp directory usage during export — must clean up after completion/failure
- Large KBs: ZIP file can be 100MB+ — streaming download required
- Git commit authorship mapping: user.email must exist in tenants table

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Export with 10 wiki_events → ZIP contains valid git repo with 10 commits
- [ ] `git log` in extracted repo shows chronological history
- [ ] `git blame` on a Neuron file shows correct candidate attribution
- [ ] Commit messages follow specified format
- [ ] Export with 10k events completes within 5 minutes
- [ ] Failed export cleans up temp directory
- [ ] Regression: existing export (F100) unaffected
- [ ] Regression: wiki_events table unaffected

## Implementation Steps

1. Add `git_export_jobs` table to schema with migration.
2. Create `apps/server/src/services/git-exporter.ts` with `exportToGitRepo()` function.
3. Implement wiki_events iteration + git commit logic using `isomorphic-git`.
4. Implement ZIP packaging of the repo directory.
5. Create `apps/server/src/routes/git-export.ts` with job management endpoints.
6. Mount route in `app.ts`.
7. Add cleanup logic for failed/abandoned exports.

## Dependencies

- F100 (eksport-endpoint infrastruktur delvist genbrug)

## Open Questions

None — all decisions made.

## Related Features

- **F100** (Export) — shares export job infrastructure
- **F116** (Synthetic Training Data Export) — similar job-based export pattern

## Effort Estimate

**Medium** — 3 days.
- Day 1: Schema + git exporter service with isomorphic-git
- Day 2: Job management + ZIP packaging
- Day 3: Performance testing + cleanup logic
