import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireAuth, getTenant } from '../middleware/auth.js';
import { broadcaster, type BroadcastEvent } from '../services/broadcast.js';

export const streamRoutes = new Hono();

streamRoutes.use('*', requireAuth);

streamRoutes.get('/stream', (c) => {
  const tenant = getTenant(c);

  return streamSSE(c, async (stream) => {
    let id = 0;
    const queue: BroadcastEvent[] = [];
    let resolveWait: (() => void) | null = null;

    const push = (event: BroadcastEvent): void => {
      // Only deliver events scoped to this tenant (or global events with no tenantId).
      if (event.tenantId && event.tenantId !== tenant.id) return;
      queue.push(event);
      resolveWait?.();
    };

    const unsubscribe = broadcaster.subscribe(push);
    stream.onAbort(() => {
      unsubscribe();
      resolveWait?.();
    });

    const pinger = setInterval(() => push({ type: 'ping' }), 30_000);

    try {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'hello', tenantId: tenant.id }),
        event: 'hello',
        id: String(id++),
      });

      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
          resolveWait = null;
          continue;
        }
        const event = queue.shift()!;
        await stream.writeSSE({
          data: JSON.stringify(event),
          event: event.type,
          id: String(id++),
        });
      }
    } finally {
      clearInterval(pinger);
      unsubscribe();
    }
  });
});
