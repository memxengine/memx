/**
 * F32.1 — Lint Pass MVP.
 *
 * On-demand scan over a KB's wiki + source documents. Emits queue candidates
 * the curator reviews like any other candidate. Two cheap SQL-only detectors
 * in the MVP:
 *
 *   - orphans — Neurons with no citations + Sources no Neuron cites
 *   - stale — Neurons untouched past a threshold
 *
 * Contradiction detection and cross-ref gap analysis — the LLM-driven half
 * of F32 that unblocks F19 axis 3 — land in F32.2.
 *
 * Invariant: findings become candidates via `createCandidate`. No direct
 * writes to `documents`. The queue is the sole write path.
 */
import { queueCandidates, type TrailDatabase } from '@trail/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { createCandidate, type Actor } from '../queue/candidates.js';
import { detectOrphans } from './orphans.js';
import { detectStale } from './stale.js';
import type { QueueCandidate } from '@trail/shared';
import type { LintFinding, LintOptions, LintReport } from './types.js';

/**
 * Callback fired for every candidate the lint pass writes. Used by the HTTP
 * layer to broadcast candidate_created events so badges + panels update
 * live. Core stays transport-agnostic; the caller wires whatever it needs.
 */
export type LintEmitCallback = (args: {
  candidate: QueueCandidate;
  autoApproved: boolean;
  documentId: string | null;
}) => void;

export type { LintFinding, LintOptions, LintReport } from './types.js';
export { detectOrphans } from './orphans.js';
export { detectStale } from './stale.js';
export {
  detectContradictions,
  type ContradictionCandidate,
  type ContradictionChecker,
  type LlmContradictionResult,
  type NewNeuron,
} from './contradictions.js';

const DETECTORS = [
  { name: 'orphans', run: detectOrphans },
  { name: 'stale', run: detectStale },
] as const;

/**
 * Run every detector and emit each finding as a candidate. Findings that
 * already have a matching pending candidate (same fingerprint in metadata)
 * are skipped, so the report tells you what was already in the queue and
 * what was newly-emitted.
 *
 * The lint runner is actor-agnostic: pass a service actor for scheduled
 * runs, a user actor for manually-triggered runs from the admin.
 */
export async function runLint(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  actor: Actor,
  opts: LintOptions = {},
  onEmit?: LintEmitCallback,
): Promise<LintReport> {
  const existingFingerprints = await loadExistingFingerprints(trail, kbId, tenantId);
  const ranAt = new Date().toISOString();
  const detectorsOut: LintReport['detectors'] = [];
  let totalEmitted = 0;

  for (const det of DETECTORS) {
    const t0 = Date.now();
    const { scanned, findings } = await det.run(trail, kbId, tenantId, opts);

    let emitted = 0;
    let skippedExisting = 0;
    for (const finding of findings) {
      if (existingFingerprints.has(finding.fingerprint)) {
        skippedExisting += 1;
        continue;
      }
      const result = await emitFinding(trail, kbId, tenantId, actor, finding);
      if (onEmit && result) onEmit(result);
      existingFingerprints.add(finding.fingerprint);
      emitted += 1;
    }
    totalEmitted += emitted;

    detectorsOut.push({
      name: det.name,
      scanned,
      found: findings.length,
      emitted,
      skippedExisting,
      elapsedMs: Date.now() - t0,
    });
  }

  return { kbId, ranAt, detectors: detectorsOut, totalEmitted };
}

async function emitFinding(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  actor: Actor,
  finding: LintFinding,
): Promise<{ candidate: QueueCandidate; autoApproved: boolean; documentId: string | null } | null> {
  const metadata = JSON.stringify({
    op: 'create',
    source: 'lint',
    lintFingerprint: finding.fingerprint,
    ...finding.details,
  });
  const { candidate, approval } = await createCandidate(
    trail,
    tenantId,
    {
      knowledgeBaseId: kbId,
      kind: finding.kind,
      title: finding.title,
      content: finding.content,
      metadata,
      confidence: finding.confidence,
    },
    actor,
  );
  return {
    candidate,
    autoApproved: !!approval,
    documentId: approval?.documentId ?? null,
  };
}

/**
 * Pre-load every fingerprint that already has a pending candidate in this
 * KB. Done once per lint run so we don't round-trip per finding. We scan
 * pending + approved statuses only — rejected fingerprints can re-emit
 * (the curator explicitly said no once, but the underlying issue may
 * have recurred).
 */
async function loadExistingFingerprints(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
): Promise<Set<string>> {
  const rows = await trail.db
    .select({ metadata: queueCandidates.metadata })
    .from(queueCandidates)
    .where(
      and(
        eq(queueCandidates.knowledgeBaseId, kbId),
        eq(queueCandidates.tenantId, tenantId),
        // Only pending + approved block re-emission. Rejected or ingested
        // fingerprints can re-fire — rejected means the curator said "no
        // this time" but the underlying issue may have come back, and
        // ingested means the lint candidate has already been consumed and
        // its fingerprint is no longer load-bearing.
        inArray(queueCandidates.status, ['pending', 'approved']),
        like(queueCandidates.metadata, '%"lintFingerprint":%'),
      ),
    )
    .all();

  const out = new Set<string>();
  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      const meta = JSON.parse(row.metadata) as { lintFingerprint?: unknown };
      if (typeof meta.lintFingerprint === 'string') {
        out.add(meta.lintFingerprint);
      }
    } catch {
      // Legacy malformed metadata — skip.
    }
  }
  return out;
}
