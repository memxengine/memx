import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppBindings } from '../app.js';

/**
 * Health endpoint for Fly.io's HTTP checks + human-readable smoke test.
 * Pings the DB with a cheap `SELECT 1` so a volume-mount glitch or
 * libsql open failure actually surfaces as an unhealthy response
 * instead of a green check on a broken engine.
 *
 * `version` is pulled from env at boot (Fly sets FLY_MACHINE_VERSION on
 * release; TRAIL_VERSION is the escape hatch for non-Fly deploys).
 * Falls back to "dev" locally.
 */
export const healthRoutes = new Hono<AppBindings>();

const VERSION = process.env.FLY_MACHINE_VERSION ?? process.env.TRAIL_VERSION ?? 'dev';

healthRoutes.get('/health', async (c) => {
  const trail = c.get('trail');
  let dbStatus: 'ok' | 'error' = 'ok';
  try {
    await trail.db.run(sql`SELECT 1`);
  } catch {
    dbStatus = 'error';
  }
  const body = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    service: 'trail-server',
    db: dbStatus,
    version: VERSION,
  };
  return c.json(body, dbStatus === 'ok' ? 200 : 503);
});
