import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import glossary from '../data/glossary.json' with { type: 'json' };

/**
 * Central Trail glossary — hand-curated bilingual definitions of every
 * system-level term (Neuron, Trail, Lint, Orphan Neuron, False Positive,
 * etc.). Read-only in v1: the source of truth is the JSON file in the
 * repo so every engine instance ships the same definitions and updates
 * ship via normal deploys. If editable-from-UI becomes a need, migrate
 * the JSON into a `glossary_terms` table + admin editor.
 *
 * Public per-tenant (requireAuth) because terms describe the product
 * surface — no tenant-scoped content here. Cached by the client; the
 * Vary: Accept-Language header isn't needed because BOTH locales ship
 * in every response.
 */
export const glossaryRoutes = new Hono();

glossaryRoutes.use('*', requireAuth);

glossaryRoutes.get('/glossary', (c) => {
  return c.json(glossary);
});

glossaryRoutes.get('/glossary/:id', (c) => {
  const id = c.req.param('id');
  const term = glossary.terms.find((t) => t.id === id);
  if (!term) return c.json({ error: 'Unknown term' }, 404);
  return c.json(term);
});
