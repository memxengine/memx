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

interface EventBus {
  source: EventSource | null;
  handlers: Set<Handler>;
  refCount: number;
}

// Module singleton — every call to subscribe() shares the same SSE
// connection. Opening N tabs = N connections across the process still,
// which is fine.
const bus: EventBus = { source: null, handlers: new Set(), refCount: 0 };

function openConnection(): void {
  if (bus.source) return;
  const es = new EventSource('/api/v1/stream', { withCredentials: true });
  bus.source = es;
  es.onmessage = (e) => deliver(e.data);
  // `writeSSE({ event: '<type>' })` sets the event name — we listen on
  // both the default 'message' and the typed channels so consumers don't
  // care how the server names them.
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
    // EventSource auto-reconnects on its own; a transient disconnection
    // would trigger onerror repeatedly. We don't tear down on first error.
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
    let cancelled = false;
    const qs = new URLSearchParams({ knowledgeBaseId: kbId, status: 'pending', limit: '1' });
    fetch(`/api/v1/queue?${qs.toString()}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: { count: number }) => {
        if (!cancelled) setCount(data.count);
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [kbId]);

  useEvents((e) => {
    if (!kbId || e.kbId !== kbId) return;
    if (e.type === 'candidate_created' && e.status === 'pending') {
      setCount((c) => (c === null ? 1 : c + 1));
    } else if (e.type === 'candidate_approved') {
      // Auto-approved candidates never transitioned through pending — we
      // never incremented for them, so don't decrement either.
      if (e.autoApproved) return;
      setCount((c) => (c === null ? null : Math.max(0, c - 1)));
    } else if (e.type === 'candidate_rejected') {
      setCount((c) => (c === null ? null : Math.max(0, c - 1)));
    }
  });

  return count;
}
