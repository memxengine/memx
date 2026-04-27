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
import { retrieveRoutes } from './routes/retrieve.js';
import { userRoutes } from './routes/user.js';
import { imageRoutes } from './routes/images.js';
import { imagesSearchRoutes } from './routes/images-search.js';
import { chatRoutes } from './routes/chat.js';
import { chatSessionRoutes } from './routes/chat-sessions.js';
import { ingestRoutes } from './routes/ingest.js';
import { streamRoutes } from './routes/stream.js';
import { queueRoutes } from './routes/queue.js';
import { lintRoutes } from './routes/lint.js';
import { glossaryRoutes } from './routes/glossary.js';
import { graphRoutes } from './routes/graph.js';
import { workRoutes } from './routes/work.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { backupRoutes } from './routes/backups.js';
import { costRoutes } from './routes/cost.js';
import { fxRoutes } from './routes/fx.js';
import { chatSettingsRoutes } from './routes/chat-settings.js';
import { creditsRoutes } from './routes/credits.js';
import { jobRoutes } from './routes/jobs.js';

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
    /**
     * F160 — how the request was authenticated. Lets routes pick
     * sane defaults for audience-aware behaviour: external Bearer
     * callers default to `tool` audience (no admin-only docs, no
     * curator-style prose), session-cookie admin-UI defaults to
     * `curator`.
     */
    authType?: 'bearer' | 'session';
  };
}

export function createApp(trail: TrailDatabase): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use('*', logger());
  const adminOrigin = process.env.APP_URL ?? 'http://localhost:3030';
  // F111.2 — `TRAIL_ALLOWED_ORIGINS` (CSV) lets operators whitelist
  // additional origins (e.g. an integration site on localhost:3001
  // during dev, or a customer subdomain in prod) without editing
  // code. Each entry is validated at boot: must parse as a URL with
  // scheme + host (+ optional port), no path/query. Invalid entries
  // log a warning and are dropped — boot continues with the rest, so
  // a typo in one entry doesn't take the engine down.
  const configuredExtraOrigins = (process.env.TRAIL_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => {
      try {
        const u = new URL(s);
        if (u.pathname && u.pathname !== '/') {
          console.warn(`[cors] dropping TRAIL_ALLOWED_ORIGINS entry with path: ${s}`);
          return false;
        }
        return true;
      } catch {
        console.warn(`[cors] dropping invalid TRAIL_ALLOWED_ORIGINS entry: ${s}`);
        return false;
      }
    })
    .map((s) => s.replace(/\/$/, ''));
  if (configuredExtraOrigins.length > 0) {
    console.log(
      `[cors] extra origins from TRAIL_ALLOWED_ORIGINS: ${configuredExtraOrigins.join(', ')}`,
    );
  }
  app.use(
    '/api/*',
    cors({
      origin: (origin) => {
        // Allow configured APP_URL, localhost variants, browser extensions,
        // and any origins from TRAIL_ALLOWED_ORIGINS env (F111.2).
        const allowed = [
          process.env.APP_URL ?? 'http://localhost:3030',
          'http://localhost:3030',
          'http://127.0.0.1:3030',
          ...configuredExtraOrigins,
        ];
        if (allowed.includes(origin)) return origin;
        if (origin.startsWith('chrome-extension://')) return origin;
        if (origin.startsWith('moz-extension://')) return origin;
        if (origin.startsWith('safari-web-extension://')) return origin;
        return allowed[0];
      },
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
  app.route('/api/v1', retrieveRoutes);
  app.route('/api/v1', userRoutes);
  app.route('/api/v1', imageRoutes);
  app.route('/api/v1', imagesSearchRoutes);
  app.route('/api/v1', chatRoutes);
  app.route('/api/v1', chatSessionRoutes);
  app.route('/api/v1', ingestRoutes);
  app.route('/api/v1', streamRoutes);
  app.route('/api/v1', queueRoutes);
  app.route('/api/v1', lintRoutes);
  app.route('/api/v1', glossaryRoutes);
  app.route('/api/v1', graphRoutes);
  app.route('/api/v1', workRoutes);
  app.route('/api/v1', apiKeyRoutes);
  // F153 — admin-only backup endpoints. Route prefix is `/api/v1/admin/...`.
  app.route('/api/v1', backupRoutes);
  // F151 — Cost & Quality Dashboard endpoints.
  app.route('/api/v1', costRoutes);
  // F151 — USD→DKK rate proxy for currency-localised cost display.
  app.route('/api/v1', fxRoutes);
  // F159 — per-KB chat backend overrides (GET + PATCH /knowledge-bases/:kbId/chat-settings).
  app.route('/api/v1', chatSettingsRoutes);
  // F156 Phase 0 — credits balance + recent transactions for the cost panel card.
  app.route('/api/v1', creditsRoutes);
  // F164 — generic background-jobs API (submit, list, get, abort, SSE stream).
  app.route('/api/v1', jobRoutes);

  return app;
}
