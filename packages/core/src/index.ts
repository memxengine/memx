// Curation queue — the sole write path into wiki documents.
export {
  createCandidate,
  approveCandidate,
  rejectCandidate,
  listCandidates,
  getCandidate,
} from './queue/candidates.js';
export type {
  Actor,
  ApprovalResult,
  RejectionResult,
  CandidateOp,
} from './queue/candidates.js';
export { shouldAutoApprove } from './queue/policy.js';

// Lint pass (F32) — orphans, stale, contradictions.
export { runLint, detectOrphans, detectStale } from './lint/index.js';
export type { LintFinding, LintOptions, LintReport } from './lint/index.js';

// Utilities
export { slugify, uniqueSlug } from './slug.js';
