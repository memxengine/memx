export interface BroadcastEvent {
  type: string;
  tenantId?: string;
  [key: string]: unknown;
}

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
