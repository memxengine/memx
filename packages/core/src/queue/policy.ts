import type { QueueCandidate, QueueCandidateKind } from '@trail/shared';

/**
 * Auto-approval policy.
 *
 * F19 will tighten this further (confidence thresholds, contradiction checks,
 * canonical-source rules). For now the rule is: trusted pipelines auto-approve,
 * human-originated candidates require a curator.
 *
 * Heuristic for "trusted pipeline": the candidate has no user in `createdBy`
 * (i.e. it came from the MCP server during ingest or another background job)
 * AND the kind is one of the ingest-originated kinds.
 */
const TRUSTED_KINDS: QueueCandidateKind[] = [
  'ingest-summary',
  'ingest-page-update',
  'source-retraction',
  'scheduled-recompile',
];

export function shouldAutoApprove(candidate: QueueCandidate): boolean {
  if (candidate.createdBy) return false;
  return TRUSTED_KINDS.includes(candidate.kind);
}
