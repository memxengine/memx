import type { QueueCandidate, QueueCandidateKind } from '@trail/shared';

/**
 * F19 — Auto-approval policy.
 *
 * The Curation Queue (F17) is the sole write path into the wiki. Every
 * candidate goes through it; auto-approval is a queue *policy*, not a
 * parallel path. A candidate enters pending, `shouldAutoApprove` evaluates
 * it, and if it passes, the approval handler fires immediately — same code
 * path a human click would take, same audit trail.
 *
 * The plan (docs/FEATURES.md#F19, docs/PLAN-PATCH.md) names three axes to
 * stack, strictest bypass first:
 *
 *   Axis 1 — Trusted pipeline (kind + non-human actor)          [live]
 *   Axis 2 — Confidence ≥ threshold for anything else           [live, this file]
 *   Axis 3 — No contradictions against existing claims          [blocked on F32]
 *
 * A human-originated candidate (createdBy set) NEVER auto-approves. That's
 * by design — people click "submit"; machines emit confidences. Mixing the
 * two corrupts the audit trail.
 */

/** Pipelines whose own writes we trust unconditionally. */
const TRUSTED_KINDS: QueueCandidateKind[] = [
  'ingest-summary',
  'ingest-page-update',
  'source-retraction',
  'scheduled-recompile',
];

const DEFAULT_THRESHOLD = 0.8;

function threshold(): number {
  const raw = process.env.TRAIL_AUTO_APPROVE_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_THRESHOLD;
  return n;
}

export function shouldAutoApprove(candidate: QueueCandidate): boolean {
  // Humans never auto-approve. If a curator wants a page in, they click it.
  if (candidate.createdBy) return false;

  // Axis 1: trusted pipelines skip the threshold entirely.
  if (TRUSTED_KINDS.includes(candidate.kind)) return true;

  // Axis 2: confidence threshold for everything else. A candidate without a
  // confidence score is treated as "below threshold" — we'd rather queue it
  // for review than silently commit something the source didn't vouch for.
  if (candidate.confidence === null || candidate.confidence === undefined) return false;
  return candidate.confidence >= threshold();

  // Axis 3 (no contradictions) lives in F32. Once the lint emits a signal
  // on candidate creation (either a field or a blocking event), this
  // function will AND that signal in above the return.
}
