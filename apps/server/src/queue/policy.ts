import type { QueueCandidate } from '@trail/shared';

/**
 * Auto-approval policy stub (F17 part A).
 *
 * F19 replaces this with real logic: trusted pipeline + confidence ≥ threshold +
 * no contradictions with canonical sources. For now every candidate flows through
 * the curator queue so the approve handler exercises the single-write-path
 * invariant from the first commit onwards.
 */
export function shouldAutoApprove(_candidate: QueueCandidate): boolean {
  return false;
}
