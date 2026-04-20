/**
 * F32.2 — scheduled "dreaming pass" over every KB.
 *
 * The reactive lint + contradiction subscriber only scans what changes
 * (candidate_approved events). Neurons that were approved BEFORE we turned
 * contradiction-lint on — or approved while the reactive runner was off —
 * never get re-scanned. A Neuron that *became* stale or orphaned after a
 * source was archived is invisible to the reactive path.
 *
 * The dreaming pass fills that gap. On a schedule (default: every 24h, run
 * once 60s after boot) we iterate every non-archived KB and:
 *
 *   1. Run orphans + stale detectors (F32.1) via `runLint`. Cheap SQL; any
 *      new findings emit as queue candidates and reach admin via broadcaster.
 *   2. Re-scan a sample of ready Neurons for contradictions against their
 *      top-K peers (F32 sampling — see runContradictions). Sequential — the
 *      checker's SerialRunner already rate-limits via its internal queue,
 *      but we call it serially per-doc to avoid holding a huge task list
 *      in memory.
 *
 * The full pass is idempotent: lintFingerprint dedupes re-emissions against
 * any pending/approved candidate with the same fingerprint.
 *
 * Controls via env:
 *   - TRAIL_LINT_SCHEDULE_HOURS (default 24; 0 disables)
 *   - TRAIL_LINT_INITIAL_DELAY_SECONDS (default 14400 = 4h; delay before first run.
 *     Was 60s but every engine restart then triggered a full dreaming pass
 *     that competed with queue-backfill for the single CLI lane. Four hours
 *     means a "normal" restart doesn't kick off a fresh LLM scan; the
 *     nightly 24h schedule carries the load as intended.)
 *   - TRAIL_LINT_SKIP_CONTRADICTIONS (default off; set to 1 to skip the
 *     LLM pass and run only orphans+stale — useful when API/CLI unavailable)
 *   - TRAIL_CONTRADICTION_SAMPLE_SIZE (default 500; cap on Neurons scanned
 *     per KB per 24h pass. At N≈8k a full pass exceeds 24h wall-clock —
 *     sampling keeps the scheduler sustainable. 0 disables the cap.)
 *   - TRAIL_CONTRADICTION_RECENT_FRACTION (default 0.6; share of the sample
 *     drawn from most-recently-updated Neurons. Remainder is uniform random
 *     over the rest of the KB so long-tail Neurons still get revisited.)
 */
import { documents, knowledgeBases, type TrailDatabase } from '@trail/db';
import { and, desc, eq } from 'drizzle-orm';
import { runLint, type LintReport } from '@trail/core';
import { broadcaster } from './broadcast.js';
import {
  makeContradictionChecker,
  scanDocForContradictions,
} from './contradiction-lint.js';
import { rebuildAccessRollup, pruneOldAccessRows } from './access-rollup.js';

const SCHEDULE_HOURS = Number(process.env.TRAIL_LINT_SCHEDULE_HOURS ?? 24);
const INITIAL_DELAY_MS =
  Number(process.env.TRAIL_LINT_INITIAL_DELAY_SECONDS ?? 14_400) * 1000;
const SKIP_CONTRADICTIONS = process.env.TRAIL_LINT_SKIP_CONTRADICTIONS === '1';
const SAMPLE_SIZE = Number(process.env.TRAIL_CONTRADICTION_SAMPLE_SIZE ?? 500);
const RECENT_FRACTION = clamp01(
  Number(process.env.TRAIL_CONTRADICTION_RECENT_FRACTION ?? 0.6),
);

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.6;
  return Math.max(0, Math.min(1, n));
}

type ScannedKB = {
  id: string;
  tenantId: string;
  name: string;
};

export function startLintScheduler(trail: TrailDatabase): () => void {
  if (SCHEDULE_HOURS <= 0) {
    console.log('  lint-scheduler: disabled (TRAIL_LINT_SCHEDULE_HOURS=0)');
    return () => {};
  }

  const intervalMs = SCHEDULE_HOURS * 3600 * 1000;
  let stopped = false;

  const first = setTimeout(() => {
    if (stopped) return;
    void runFullPass(trail);
  }, INITIAL_DELAY_MS);

  const interval = setInterval(() => {
    if (stopped) return;
    void runFullPass(trail);
  }, intervalMs);

  console.log(
    `  lint-scheduler: every ${SCHEDULE_HOURS}h (first run in ${Math.round(
      INITIAL_DELAY_MS / 1000,
    )}s, skip_contradictions=${SKIP_CONTRADICTIONS})`,
  );

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(interval);
  };
}

async function runFullPass(trail: TrailDatabase): Promise<void> {
  const t0 = Date.now();
  let totalFindings = 0;
  let kbCount = 0;
  let contradictionsScanned = 0;

  try {
    const kbs = await listKBs(trail);
    kbCount = kbs.length;
    if (kbs.length === 0) {
      console.log('[lint-scheduler] no KBs to scan');
      return;
    }

    console.log(`[lint-scheduler] starting pass across ${kbs.length} KB(s)`);

    for (const kb of kbs) {
      // Orphans + stale — cheap, always runs
      const report = await runOrphansStale(trail, kb);
      totalFindings += report.totalEmitted;

      // Contradictions — expensive, optional
      if (!SKIP_CONTRADICTIONS) {
        contradictionsScanned += await runContradictions(trail, kb);
      }
    }

    // F141 — rebuild the access-rollup aggregate once per pass. Cheap
    // SQL-only work (no LLM), runs after the expensive passes so the
    // rollup reflects all reads captured up to this moment. Prune old
    // raw rows afterwards so document_access doesn't grow unbounded.
    try {
      const rollup = await rebuildAccessRollup(trail);
      if (rollup.documentsRolledUp > 0) {
        console.log(
          `[lint-scheduler] access rollup: ${rollup.documentsRolledUp} docs across ${rollup.kbsProcessed} KB(s), ${rollup.elapsedMs}ms`,
        );
      }
      const pruned = await pruneOldAccessRows(trail);
      if (pruned > 0) {
        console.log(`[lint-scheduler] access rollup: pruned ${pruned} row(s) older than 180d`);
      }
    } catch (err) {
      console.error('[lint-scheduler] access-rollup failed:', err instanceof Error ? err.message : err);
    }

    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(
      `[lint-scheduler] pass complete: ${kbCount} KB(s), ${totalFindings} new findings, ${contradictionsScanned} Neurons scanned for contradictions, ${elapsed}s`,
    );
  } catch (err) {
    console.error('[lint-scheduler] pass failed:', err);
  }
}

async function listKBs(trail: TrailDatabase): Promise<ScannedKB[]> {
  return trail.db
    .select({
      id: knowledgeBases.id,
      tenantId: knowledgeBases.tenantId,
      name: knowledgeBases.name,
    })
    .from(knowledgeBases)
    .all();
}

async function runOrphansStale(trail: TrailDatabase, kb: ScannedKB): Promise<LintReport> {
  // The scheduler is a 'system' actor — same as bearer-auth ingest writes.
  // Lint candidates with system actor can auto-approve through policy if
  // their kind is trusted (orphans/stale are NOT trusted, so they'll land
  // pending for curator review — exactly what we want for a dreaming pass).
  const actor = { id: 'system:lint-scheduler', kind: 'system' as const };
  return runLint(
    trail,
    kb.id,
    kb.tenantId,
    actor,
    {},
    ({ candidate, autoApproved, documentId }) => {
      broadcaster.emit({
        type: 'candidate_created',
        tenantId: candidate.tenantId,
        kbId: candidate.knowledgeBaseId,
        candidateId: candidate.id,
        kind: candidate.kind,
        title: candidate.title,
        status: autoApproved ? 'approved' : 'pending',
        autoApproved,
        confidence: candidate.confidence,
        createdBy: candidate.createdBy,
      });
      if (autoApproved) {
        broadcaster.emit({
          type: 'candidate_resolved',
          tenantId: candidate.tenantId,
          kbId: candidate.knowledgeBaseId,
          candidateId: candidate.id,
          actionId: 'approve',
          effect: 'approve',
          documentId,
          autoApproved: true,
        });
      }
      if (autoApproved && documentId) {
        broadcaster.emit({
          type: 'candidate_approved',
          tenantId: candidate.tenantId,
          kbId: candidate.knowledgeBaseId,
          candidateId: candidate.id,
          documentId,
          autoApproved: true,
        });
      }
    },
  );
}

async function runContradictions(trail: TrailDatabase, kb: ScannedKB): Promise<number> {
  // At N≈8k a full sequential pass exceeds 24h wall-clock (each doc =
  // top-K × 1-3s Haiku call × K=5 → ~7.5s per doc → ~16h at 8k). Past that
  // the scheduler can't keep up and backs up indefinitely. SAMPLE_SIZE
  // caps the per-pass workload; the sample is biased toward recent edits
  // (highest contradiction yield) with a random tail so long-idle Neurons
  // still get revisited occasionally.
  const neurons = await trail.db
    .select({ id: documents.id, updatedAt: documents.updatedAt })
    .from(documents)
    .where(
      and(
        eq(documents.knowledgeBaseId, kb.id),
        eq(documents.tenantId, kb.tenantId),
        eq(documents.kind, 'wiki'),
        eq(documents.archived, false),
        eq(documents.status, 'ready'),
      ),
    )
    .orderBy(desc(documents.updatedAt))
    .all();

  if (neurons.length === 0) return 0;

  const sample = sampleNeurons(neurons.map((n) => n.id), SAMPLE_SIZE, RECENT_FRACTION);
  if (sample.length < neurons.length) {
    console.log(
      `[lint-scheduler] KB "${kb.name}" — sampling ${sample.length}/${neurons.length} Neurons (recent=${RECENT_FRACTION})`,
    );
  }

  const checker = makeContradictionChecker();
  for (const id of sample) {
    try {
      await scanDocForContradictions(trail, id, checker);
    } catch (err) {
      console.error(`[lint-scheduler] contradiction scan failed for ${id}:`, err);
    }
  }
  return sample.length;
}

/**
 * Pick up to `cap` Neurons from the ordered-by-updatedAt-desc list.
 * Strategy:
 *   1. Take the top `cap * recentFraction` most-recently-updated.
 *   2. Fill the rest with a uniform random sample from the remainder.
 *
 * This mirrors the SCALING-ANALYSIS §5 recommendation: recent edits have
 * the highest contradiction yield (they were just merged against a growing
 * corpus), while the random tail guarantees every Neuron is eventually
 * re-scanned even if it hasn't been touched in years. cap=0 disables.
 *
 * Exported for testability.
 */
export function sampleNeurons(
  ids: string[],
  cap: number,
  recentFraction: number,
): string[] {
  if (cap <= 0 || ids.length <= cap) return ids;
  const recentCount = Math.min(ids.length, Math.floor(cap * recentFraction));
  const randomCount = cap - recentCount;
  const recent = ids.slice(0, recentCount);
  const tail = ids.slice(recentCount);
  if (randomCount <= 0 || tail.length === 0) return recent;
  // Fisher-Yates partial shuffle — only pick the first `randomCount`.
  const pool = tail.slice();
  const picked: string[] = [];
  const take = Math.min(randomCount, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
    picked.push(pool[i]!);
  }
  return [...recent, ...picked];
}
