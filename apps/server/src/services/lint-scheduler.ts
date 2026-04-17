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
 *   2. Re-scan every ready Neuron for contradictions against its top-K
 *      peers. Sequential — the checker's SerialRunner already rate-limits
 *      via its internal queue, but we call it serially per-doc to avoid
 *      holding a huge task list in memory.
 *
 * The full pass is idempotent: lintFingerprint dedupes re-emissions against
 * any pending/approved candidate with the same fingerprint.
 *
 * Controls via env:
 *   - TRAIL_LINT_SCHEDULE_HOURS (default 24; 0 disables)
 *   - TRAIL_LINT_INITIAL_DELAY_SECONDS (default 60; delay before first run)
 *   - TRAIL_LINT_SKIP_CONTRADICTIONS (default off; set to 1 to skip the
 *     LLM pass and run only orphans+stale — useful when API/CLI unavailable)
 */
import { documents, knowledgeBases, type TrailDatabase } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { runLint, type LintReport } from '@trail/core';
import { broadcaster } from './broadcast.js';
import {
  makeContradictionChecker,
  scanDocForContradictions,
} from './contradiction-lint.js';

const SCHEDULE_HOURS = Number(process.env.TRAIL_LINT_SCHEDULE_HOURS ?? 24);
const INITIAL_DELAY_MS =
  Number(process.env.TRAIL_LINT_INITIAL_DELAY_SECONDS ?? 60) * 1000;
const SKIP_CONTRADICTIONS = process.env.TRAIL_LINT_SKIP_CONTRADICTIONS === '1';

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
  // List every ready, non-archived Neuron in the KB. We scan them
  // sequentially — each scan spawns a claude -p subprocess that takes
  // 1-3s per top-K pair, so parallelising would swamp the CLI token
  // budget and the LLM host.
  const neurons = await trail.db
    .select({ id: documents.id })
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
    .all();

  if (neurons.length === 0) return 0;

  const checker = makeContradictionChecker();
  for (const n of neurons) {
    try {
      await scanDocForContradictions(trail, n.id, checker);
    } catch (err) {
      console.error(`[lint-scheduler] contradiction scan failed for ${n.id}:`, err);
    }
  }
  return neurons.length;
}
