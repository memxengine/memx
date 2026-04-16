import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { TrailDatabase } from '@trail/db';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { kbRoutes } from './routes/knowledge-bases.js';
import { documentRoutes } from './routes/documents.js';
import { uploadRoutes } from './routes/uploads.js';
import { searchRoutes } from './routes/search.js';
import { userRoutes } from './routes/user.js';
import { imageRoutes } from './routes/images.js';
import { chatRoutes } from './routes/chat.js';
import { ingestRoutes } from './routes/ingest.js';
import { streamRoutes } from './routes/stream.js';
import { queueRoutes } from './routes/queue.js';
import { lintRoutes } from './routes/lint.js';

/**
 * Hono context variables visible to every handler.
 *
 * `trail` is injected at the app root (F40.1) by the bootstrap in
 * index.ts. F40.2 replaces this with per-request tenant-context
 * middleware that resolves the caller's tenant and fetches its
 * TrailDatabase from a pool — handlers keep reading `c.get('trail')`
 * unchanged.
 *
 * `user` and `tenant` are set by requireAuth middleware (see
 * middleware/auth.ts).
 */
export interface AppBindings {
  Variables: {
    trail: TrailDatabase;
    user?: import('./middleware/auth.js').AuthUser;
    tenant?: import('./middleware/auth.js').AuthTenant;
  };
}

export function createApp(trail: TrailDatabase): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use('*', logger());
  app.use(
    '/api/*',
    cors({
      origin: process.env.APP_URL ?? 'http://localhost:3030',
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization', 'Cookie'],
      exposeHeaders: ['Set-Cookie', 'X-Document-Id'],
    }),
  );

  // Inject the TrailDatabase into every request. F40.2 swaps this for
  // tenant-aware resolution; the signature seen by handlers is the same.
  app.use('*', async (c, next) => {
    c.set('trail', trail);
    await next();
  });

  app.route('/api', healthRoutes);
  app.route('/api/auth', authRoutes);
  app.route('/api/v1', kbRoutes);
  app.route('/api/v1', documentRoutes);
  app.route('/api/v1', uploadRoutes);
  app.route('/api/v1', searchRoutes);
  app.route('/api/v1', userRoutes);
  app.route('/api/v1', imageRoutes);
  app.route('/api/v1', chatRoutes);
  app.route('/api/v1', ingestRoutes);
  app.route('/api/v1', streamRoutes);
  app.route('/api/v1', queueRoutes);
  app.route('/api/v1', lintRoutes);

  return app;
}
