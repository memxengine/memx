/**
 * F164 Phase 4 — useJobProgress hook.
 *
 * Subscribes to /api/v1/jobs/:id/stream via EventSource and exposes
 * the job's live state to a component:
 *   - `snapshot` — initial Job row replay (server emits an SSE 'snapshot'
 *     event on connect so re-attaching after a tab refresh shows the
 *     current state immediately, not "loading…")
 *   - `progress` — latest JobProgress payload from 'progress' events
 *   - `terminal` — 'completed' | 'aborted' | 'error' | null
 *   - `result` — final result JSON when terminal === 'completed'
 *   - `errorMessage` — only set when terminal === 'error' or 'aborted'
 *
 * Cleanup is automatic: closing the EventSource on unmount AND on
 * receiving a terminal event. EventSource auto-reconnects on transient
 * network drops; we treat that as transparent.
 *
 * Deliberately omits a polling fallback for now — every browser we
 * support ships EventSource. If we find a customer with proxy-strip
 * issues, swap to a poll mode here. SSE-cookie auth: EventSource sends
 * the session cookie automatically same-origin.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Job, JobProgress, VisionRerunResult } from '../api';

export interface JobProgressState {
  snapshot: Job | null;
  progress: JobProgress | null;
  terminal: 'completed' | 'aborted' | 'error' | null;
  result: VisionRerunResult | null;
  errorMessage: string | null;
}

export function useJobProgress(jobId: string | null): JobProgressState {
  const [state, setState] = useState<JobProgressState>({
    snapshot: null,
    progress: null,
    terminal: null,
    result: null,
    errorMessage: null,
  });

  useEffect(() => {
    if (!jobId) {
      setState({ snapshot: null, progress: null, terminal: null, result: null, errorMessage: null });
      return;
    }

    const url = `/api/v1/jobs/${encodeURIComponent(jobId)}/stream`;
    const es = new EventSource(url);

    const onSnapshot = (e: MessageEvent) => {
      try {
        const job = JSON.parse(e.data) as Job;
        setState((prev) => ({
          ...prev,
          snapshot: job,
          progress: job.progress ?? prev.progress,
          terminal:
            job.status === 'completed' || job.status === 'aborted' || job.status === 'failed'
              ? job.status === 'failed' ? 'error' : job.status
              : null,
          result: (job.result as VisionRerunResult | null) ?? prev.result,
          errorMessage: job.errorMessage,
        }));
      } catch {
        // ignore — snapshot will be re-emitted on reconnect
      }
    };

    const onProgress = (e: MessageEvent) => {
      try {
        const p = JSON.parse(e.data) as JobProgress;
        setState((prev) => ({ ...prev, progress: p }));
      } catch {}
    };

    const onCompleted = (e: MessageEvent) => {
      try {
        const result = JSON.parse(e.data) as VisionRerunResult;
        setState((prev) => ({ ...prev, terminal: 'completed', result }));
      } catch {
        setState((prev) => ({ ...prev, terminal: 'completed' }));
      }
      es.close();
    };

    const onAborted = () => {
      setState((prev) => ({ ...prev, terminal: 'aborted' }));
      es.close();
    };

    const onErrorEvent = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { message?: string };
        setState((prev) => ({ ...prev, terminal: 'error', errorMessage: data.message ?? 'Unknown error' }));
      } catch {
        setState((prev) => ({ ...prev, terminal: 'error', errorMessage: 'Unknown error' }));
      }
      es.close();
    };

    es.addEventListener('snapshot', onSnapshot);
    es.addEventListener('progress', onProgress);
    es.addEventListener('completed', onCompleted);
    es.addEventListener('aborted', onAborted);
    es.addEventListener('error', onErrorEvent as EventListener);

    return () => {
      es.removeEventListener('snapshot', onSnapshot);
      es.removeEventListener('progress', onProgress);
      es.removeEventListener('completed', onCompleted);
      es.removeEventListener('aborted', onAborted);
      es.removeEventListener('error', onErrorEvent as EventListener);
      es.close();
    };
  }, [jobId]);

  return state;
}
