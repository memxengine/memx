/**
 * F139 — Heuristic Neurons with temporal decay.
 *
 * Heuristic Neurons capture MENTAL MODELS and DECISION RULES rather than
 * factual concepts: "always clarify user intent before coding", "Luhmann
 * writes atomic notes in first person", "check contradictions weekly".
 *
 * They live at a fixed path convention (no schema change — matches
 * F101's "type is derived from path" principle) and carry a computed
 * `confidence` score that decays based on last-touched date. Pinned
 * heuristics (frontmatter `pinned: true`) never decay. Non-pinned ones
 * fade as they age: useful for distinguishing "this I actually live by"
 * from "this was a weekly-experiment I forgot about."
 *
 * The confidence is NEVER stored in the DB — it's always computed from
 * documents.updatedAt + the pinned flag, so there's no staleness risk
 * and no migration when the decay curve gets tuned.
 */

/** Path prefix a Neuron must live under to be treated as a heuristic. */
export const HEURISTIC_PATH = '/neurons/heuristics/';

export function isHeuristicPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return path.startsWith(HEURISTIC_PATH);
}

/**
 * Parse the frontmatter `pinned:` flag from a Neuron's content. Cheap
 * string search — frontmatter is always at the very top between `---`
 * fences, so scanning the first 1 KB is enough. Missing/malformed
 * frontmatter → pinned=false.
 */
export function isPinned(content: string | null | undefined): boolean {
  if (!content) return false;
  const head = content.slice(0, 1024);
  if (!head.startsWith('---')) return false;
  const end = head.indexOf('\n---', 3);
  if (end === -1) return false;
  const fm = head.slice(3, end);
  // YAML subset: `pinned: true` or `pinned: yes`. Case-insensitive.
  return /^\s*pinned\s*:\s*(true|yes)\s*$/im.test(fm);
}

/**
 * Decay curve — piecewise-constant bands so the confidence number is
 * intuitive to read ("0.8" reads as "I touched it in the last quarter").
 * Tuning this never requires a migration: confidence is computed on the
 * fly from lastTouched + pinned.
 *
 *   pinned  = ∞ lifetime              → 1.0
 *   age <  30 days  = fresh            → 1.0
 *   age <  90 days  = recent           → 0.8
 *   age < 180 days  = aging            → 0.5
 *   age < 365 days  = fading           → 0.3
 *   age ≥ 365 days  = cold             → 0.1
 */
export function computeConfidence(
  lastTouched: string | Date | null | undefined,
  pinned: boolean,
): number {
  if (pinned) return 1.0;
  if (!lastTouched) return 0.1;
  const t = typeof lastTouched === 'string' ? new Date(lastTouched) : lastTouched;
  const ms = Date.now() - t.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 1.0;
  const days = ms / 86_400_000;
  if (days < 30) return 1.0;
  if (days < 90) return 0.8;
  if (days < 180) return 0.5;
  if (days < 365) return 0.3;
  return 0.1;
}

/**
 * Threshold below which a heuristic is "faded" — excluded from chat
 * context unless explicitly referenced, flagged by the lint scheduler,
 * rendered with reduced opacity in F99 graph. Keep in sync with the
 * `detectFadedHeuristics` lint-scheduler detector and F89 chat
 * context-selection filter.
 */
export const HEURISTIC_FADED_THRESHOLD = 0.3;

export function isFaded(confidence: number): boolean {
  return confidence < HEURISTIC_FADED_THRESHOLD;
}
