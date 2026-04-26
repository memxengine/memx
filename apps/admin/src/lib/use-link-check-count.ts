/**
 * F150 — open broken-link count for a given KB. Mirror of
 * `usePendingCount` (event-stream.ts) — fetches on mount, then stays
 * live via SSE: any `candidate_approved` for the same KB triggers a
 * refetch (curator just edited a Neuron, link-checker may have
 * re-resolved or recorded findings). Returns `null` while initial
 * fetch is pending so the badge can hide rather than flicker zero.
 */
import { useEffect, useState } from 'preact/hooks';
import { useKb } from './kb-cache';
import { onStreamOpen, onFocusRefresh, subscribe, debounce } from './event-stream';

export function useLinkCheckCount(kbId: string | undefined): number | null {
  const [count, setCount] = useState<number | null>(null);
  const kb = useKb(kbId ?? '');
  const canonicalKbId = kb?.id;

  useEffect(() => {
    if (!kbId) {
      setCount(null);
      return;
    }

    let latestSeq = 0;
    let cancelled = false;
    const refetch = (): void => {
      const seq = ++latestSeq;
      fetch(`/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/link-check`, {
        credentials: 'include',
        cache: 'no-store',
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data: { findings: unknown[] }) => {
          if (cancelled || seq !== latestSeq) return;
          setCount(Array.isArray(data.findings) ? data.findings.length : 0);
        })
        .catch(() => {
          if (cancelled || seq !== latestSeq) return;
          setCount(null);
        });
    };
    const refetchDebounced = debounce(refetch, 100);
    refetch();
    const offOpen = onStreamOpen(refetch);
    const offFocus = onFocusRefresh(refetch);
    const offEvents = subscribe((e) => {
      if (e.kbId !== kbId && e.kbId !== canonicalKbId) return;
      if (e.type === 'candidate_approved') refetchDebounced();
    });
    return () => {
      cancelled = true;
      offOpen();
      offFocus();
      offEvents();
    };
  }, [kbId, canonicalKbId]);

  return count;
}
