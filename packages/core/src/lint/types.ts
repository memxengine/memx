import type { QueueCandidateKind, CandidateAction } from '@trail/shared';

/**
 * A single finding from one of the lint detectors. The lint runner converts
 * each finding into a `queue_candidates` row — findings never mutate the
 * wiki directly. That preserves F17's invariant: the queue is the sole
 * write path.
 *
 * `fingerprint` is an idempotency key — re-running the lint against a KB
 * that already has a pending candidate with the same fingerprint skips the
 * emission, so the queue doesn't fill with duplicates on every run.
 */
export interface LintFinding {
  kind: Extract<
    QueueCandidateKind,
    'cross-ref-suggestion' | 'gap-detection' | 'contradiction-alert'
  >;
  title: string;
  content: string;
  /** Stable identifier for de-duplication across lint runs. */
  fingerprint: string;
  /** 0-1 indication of how actionable this finding is. */
  confidence: number;
  /** Free-form structured payload. Serialised into candidate.metadata. */
  details: Record<string, unknown>;
  /**
   * Resolution options offered to the curator. Optional — when omitted, the
   * queue reader stamps the default Approve/Reject pair. Producers that
   * know the finding has a richer decision space (contradiction-alert:
   * reconcile / retire-A / retire-B / dismiss) populate this directly.
   * Strings are English at creation time; the admin's translation service
   * lazy-fills other locales on first view.
   */
  actions?: CandidateAction[];
}

export interface LintReport {
  kbId: string;
  ranAt: string;
  detectors: Array<{
    name: string;
    scanned: number;
    found: number;
    emitted: number;
    skippedExisting: number;
    elapsedMs: number;
  }>;
  totalEmitted: number;
}

export interface LintOptions {
  /** Wiki pages untouched for this many days become stale. Default 90. */
  staleDays?: number;
  /**
   * Filenames that are structural hub pages and should never be reported as
   * orphans (nothing cites them by design). Default: overview.md, log.md.
   */
  hubPages?: string[];
}
