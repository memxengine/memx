/**
 * F87 — Typed client for the engine's event stream.
 *
 * One persistent EventSource per admin tab. Feeds a shared pub/sub that
 * any component can subscribe to via `useEvents()`. Component-level hooks
 * (e.g. `usePendingCount`) compose on top — they register handlers for
 * specific event types + maintain their own local state.
 *
 * Cookies flow automatically because `EventSource` on a same-origin URL
 * sends them. Admin is proxied to the engine in dev + sits behind the
 * same base domain in prod, so no CORS ceremony.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DomainEvent, StreamFrame } from '@trail/shared';
import { isDomainEvent } from '@trail/shared';

type Handler = (event: DomainEvent) => void;
type OpenHandler = () => void;

interface EventBus {
  source: EventSource | null;
  handlers: Set<Handler>;
  /** Hooks that want to re-fetch state after a fresh connection/reconnect. */
  openHandlers: Set<OpenHandler>;
  refCount: number;
}

// Promote the bus to globalThis so Vite HMR reloading this module doesn't
// create a second EventSource alongside the old one — the new module picks
// up the already-open connection and its handlers instead of leaving them
// dangling on a replaced-but-still-alive EventSource instance.
const globalKey = '__trailEventBus__' as const;
const globalAny = globalThis as unknown as { [globalKey]?: EventBus };
const bus: EventBus =
  globalAny[globalKey] ??
  (globalAny[globalKey] = {
    source: null,
    handlers: new Set(),
    openHandlers: new Set(),
    refCount: 0,
  });

function openConnection(): void {
  if (bus.source && bus.source.readyState !== EventSource.CLOSED) return;
  const es = new EventSource('/api/v1/stream', { withCredentials: true });
  bus.source = es;
  es.onopen = () => {
    // Fires on the first handshake and on EventSource's native auto-
    // reconnect after a transient drop. Hooks listen to re-fetch any
    // state that might have drifted while disconnected.
    for (const fn of bus.openHandlers) fn();
  };
  es.onmessage = (e) => deliver(e.data);
  const relay = (e: MessageEvent) => deliver(e.data);
  for (const t of [
    'candidate_created',
    'candidate_approved',
    'candidate_rejected',
    'ingest_started',
    'ingest_completed',
    'ingest_failed',
    'hello',
    'ping',
  ] as const) {
    es.addEventListener(t, relay as EventListener);
  }
  es.onerror = () => {
    // EventSource auto-reconnects on its own; onopen will fire again when
    // the connection comes back. Leave it alone.
  };
}

function deliver(raw: string): void {
  let frame: StreamFrame;
  try {
    frame = JSON.parse(raw) as StreamFrame;
  } catch {
    return;
  }
  if (!isDomainEvent(frame)) return;
  for (const h of bus.handlers) h(frame);
}

function closeIfUnused(): void {
  if (bus.refCount > 0) return;
  bus.source?.close();
  bus.source = null;
}

export function subscribe(handler: Handler): () => void {
  bus.handlers.add(handler);
  bus.refCount += 1;
  openConnection();
  return () => {
    bus.handlers.delete(handler);
    bus.refCount -= 1;
    closeIfUnused();
  };
}

/** Fire a callback every time the stream (re)opens — use to refresh state. */
export function onStreamOpen(handler: OpenHandler): () => void {
  bus.openHandlers.add(handler);
  return () => {
    bus.openHandlers.delete(handler);
  };
}

/**
 * Also fire when the window regains focus. A tab that was backgrounded
 * while the engine restarted can easily miss SSE events during the gap —
 * EventSource auto-reconnects but events fired before the reconnect are
 * gone forever. Listening for `focus` catches the "I came back to the
 * tab, show me the truth" moment with one extra refetch.
 */
export function onFocusRefresh(handler: () => void): () => void {
  const onFocus = (): void => handler();
  const onVis = (): void => {
    if (document.visibilityState === 'visible') handler();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVis);
  return () => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVis);
  };
}

/**
 * Debounce wrapper — coalesces rapid-fire invocations into a single call
 * after `delayMs` of silence. Use for event-driven refetches where a bulk
 * action (reject 22, approve all) emits many events in milliseconds and
 * one final refetch is all that matters. Browsers cap concurrent fetches
 * per origin; 22 un-debounced refetches make the final state land late.
 */
export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  delayMs: number,
): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
}

/** Subscribe with a React-friendly hook. Cleans up on unmount. */
export function useEvents(handler: Handler): void {
  const saved = useRef(handler);
  saved.current = handler;
  useEffect(() => subscribe((e) => saved.current(e)), []);
}

/**
 * Count of pending candidates for a given KB. Fetches on mount, then
 * stays live via SSE: candidate_created (pending ones) increments,
 * candidate_approved and candidate_rejected decrement. Returns `null`
 * while the initial fetch is in flight — consumers can render a
 * placeholder or just hide the badge.
 */
export function usePendingCount(kbId: string | undefined): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!kbId) {
      setCount(null);
      return;
    }

    // Server is the single source of truth. Every relevant event triggers
    // a fresh fetch — but coalesced by a 100ms debounce so a bulk action
    // that emits N events in a burst does ONE refetch (same pattern as the
    // panels). Sequence counter is the second safety net: if fetches
    // overlap anyway (reconnect + bulk + focus all hitting), only the
    // newest response sets state. `cache: 'no-store'` stops the browser
    // from serving cached responses when the 3 rapid fetches have
    // identical URLs — seen while debugging a 5-second stale badge.
    let latestSeq = 0;
    let cancelled = false;
    const refetch = (): void => {
      const seq = ++latestSeq;
      const qs = new URLSearchParams({ knowledgeBaseId: kbId, status: 'pending' });
      fetch(`/api/v1/queue?${qs.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data: { count: number }) => {
          if (cancelled || seq !== latestSeq) return;
          setCount(data.count);
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
      if (e.kbId !== kbId) return;
      if (
        e.type === 'candidate_created' ||
        e.type === 'candidate_approved' ||
        e.type === 'candidate_rejected'
      ) {
        refetchDebounced();
      }
    });
    return () => {
      cancelled = true;
      offOpen();
      offFocus();
      offEvents();
    };
  }, [kbId]);

  return count;
}
