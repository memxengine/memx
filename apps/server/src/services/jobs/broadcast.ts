/**
 * F164 — In-process pub/sub for job progress events.
 *
 * Per-job channel: each subscriber (one EventSource connection per
 * progress modal) registers for a specific jobId. The runner's
 * `report()` calls `emit(jobId, 'progress', payload)` and any active
 * EventSource pumps it to the browser.
 *
 * Single-engine assumption: in-process EventEmitter is enough. When
 * F40.2 multi-engine lands, swap for Redis pub/sub or a shared SSE
 * fan-out service.
 */

import { EventEmitter } from 'node:events';

export type JobEventType = 'progress' | 'completed' | 'aborted' | 'error';

class JobsBroadcast {
  private emitter = new EventEmitter();

  constructor() {
    // Each EventSource gets its own subscription, so a popular job with
    // 3 admin tabs open pulls 3 listeners. Cap conservatively to catch
    // leaks; raise if real usage warrants.
    this.emitter.setMaxListeners(50);
  }

  emit(jobId: string, type: JobEventType, payload: unknown): void {
    this.emitter.emit(jobId, { type, payload });
  }

  subscribe(
    jobId: string,
    listener: (event: { type: JobEventType; payload: unknown }) => void,
  ): () => void {
    this.emitter.on(jobId, listener);
    return () => this.emitter.off(jobId, listener);
  }
}

export const jobsBroadcast = new JobsBroadcast();
