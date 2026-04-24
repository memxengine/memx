/**
 * F151 — FX rate endpoint.
 *
 *   GET /api/v1/fx/rate?from=USD&to=DKK → FxRate JSON
 *
 * Tenant-scoped auth (same as Cost). Rate is public info but keeping
 * behind auth prevents random scrapers from using our proxy of
 * Frankfurter's service.
 */
import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { getFxRate } from '../services/fx.js';

export const fxRoutes = new Hono();

fxRoutes.use('*', requireAuth);

fxRoutes.get('/fx/rate', async (c) => {
  const from = (c.req.query('from') ?? 'USD').toUpperCase();
  const to = (c.req.query('to') ?? 'DKK').toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return c.json({ error: 'from/to must be 3-letter currency codes' }, 400);
  }
  try {
    const rate = await getFxRate(from, to);
    return c.json(rate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 502);
  }
});
