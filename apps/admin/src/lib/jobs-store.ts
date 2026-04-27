/**
 * F164 Phase 4 — UI store for background-job orchestration.
 *
 * Two signals:
 *   - `visibleJobId` — the jobId whose progress modal is currently
 *     foregrounded. null = no modal open.
 *   - `backgroundedJobIds` — Set of jobIds that the user clicked
 *     "Kør i baggrunden" on. The header badge shows their count;
 *     clicking the badge re-foregrounds the most recent.
 *
 * Two flows produce a job:
 *   1. From sources panel: per-row "Run Vision" → submit → setVisible.
 *      User can click "Kør i baggrunden" to push to background.
 *   2. From sources panel: bulk "Run Vision (N)" → confirmation modal
 *      → submit → setVisible.
 *
 * Completion flow:
 *   - JobProgressModal listens via SSE. On terminal event, modal flips
 *     to completion-view. If the job was backgrounded, the badge shows
 *     a transient toast + drops the id from backgroundedJobIds.
 */
import { signal } from '@preact/signals';

export const visibleJobId = signal<string | null>(null);
export const backgroundedJobIds = signal<readonly string[]>([]);

/** Open the progress-modal for a freshly-submitted (or re-attached) job. */
export function showJob(jobId: string): void {
  visibleJobId.value = jobId;
  // If it was in the background list, take it out — modal is foreground now.
  if (backgroundedJobIds.peek().includes(jobId)) {
    backgroundedJobIds.value = backgroundedJobIds.peek().filter((id) => id !== jobId);
  }
}

/** "Kør i baggrunden" — close the modal, keep tracking via badge. */
export function backgroundJob(jobId: string): void {
  visibleJobId.value = null;
  if (!backgroundedJobIds.peek().includes(jobId)) {
    backgroundedJobIds.value = [...backgroundedJobIds.peek(), jobId];
  }
}

/** Close the modal and forget the job entirely (e.g. completion-modal "Close"). */
export function dismissJob(jobId: string): void {
  if (visibleJobId.peek() === jobId) {
    visibleJobId.value = null;
  }
  if (backgroundedJobIds.peek().includes(jobId)) {
    backgroundedJobIds.value = backgroundedJobIds.peek().filter((id) => id !== jobId);
  }
}
