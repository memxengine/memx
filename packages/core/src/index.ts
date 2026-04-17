// Curation queue — the sole write path into wiki documents.
export {
  createCandidate,
  resolveCandidate,
  reopenCandidate,
  listCandidates,
  countCandidates,
  getCandidate,
  resolveActions,
  persistActionTranslation,
  persistCandidateTranslation,
  submitCuratorEdit,
  VersionConflictError,
  DEFAULT_ACTIONS,
} from './queue/candidates.js';
export type {
  Actor,
  ResolutionResult,
  CandidateOp,
} from './queue/candidates.js';
export { shouldAutoApprove } from './queue/policy.js';

// Lint pass (F32) — orphans, stale, contradictions.
export {
  runLint,
  detectOrphans,
  detectStale,
  detectContradictions,
} from './lint/index.js';
export type {
  LintFinding,
  LintOptions,
  LintReport,
  LintEmitCallback,
  ContradictionCandidate,
  ContradictionChecker,
  LlmContradictionResult,
  NewNeuron,
} from './lint/index.js';

// Utilities
export { slugify, uniqueSlug } from './slug.js';
