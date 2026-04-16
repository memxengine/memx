import type { StreamFrame } from '@trail/shared';

/**
 * In-process pub/sub for stream events. Listeners are cheap — the SSE
 * endpoint registers one per open connection, hands each message back
 * through a tenant-scoped filter.
 *
 * `StreamFrame` keeps the event catalog typed (see @trail/shared events.ts).
 * Adding a new domain event = extend the union there, emit it from the
 * producer. The type-check propagates to every subscriber.
 */
export type BroadcastEvent = StreamFrame;

type Listener = (event: BroadcastEvent) => void;

class Broadcaster {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: BroadcastEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export const broadcaster = new Broadcaster();
