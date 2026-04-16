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

// Utilities
export { slugify, uniqueSlug } from './slug.js';
