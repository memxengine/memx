import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
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

export function createApp(): Hono {
  const app = new Hono();

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

  return app;
}
