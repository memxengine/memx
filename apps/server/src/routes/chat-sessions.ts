/**
 * F144 — chat session + turn REST endpoints.
 *
 * POST /knowledge-bases/:kbId/chat/sessions    → create a new session
 * GET  /knowledge-bases/:kbId/chat/sessions    → list sessions (?archived=true|false|all)
 * GET  /chat/sessions/:id                       → session + all turns
 * PATCH /chat/sessions/:id                      → rename or archive
 * DELETE /chat/sessions/:id                     → hard delete
 *
 * The POST /chat endpoint (routes/chat.ts) owns turn-writing end-to-end —
 * it accepts an optional sessionId, auto-creates a session on first turn,
 * and writes both the user and assistant turns in one request.
 */
import { Hono } from 'hono';
import { chatSessions, chatTurns } from '@trail/db';
import { and, desc, eq } from 'drizzle-orm';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import { resolveKbId } from '@trail/core';

export const chatSessionRoutes = new Hono();

chatSessionRoutes.use('*', requireAuth);

// List sessions for a KB.
chatSessionRoutes.get('/knowledge-bases/:kbId/chat/sessions', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);
  const archivedParam = c.req.query('archived') ?? 'false';

  const conditions = [
    eq(chatSessions.tenantId, tenant.id),
    eq(chatSessions.knowledgeBaseId, kbId),
    eq(chatSessions.userId, user.id),
  ];
  if (archivedParam !== 'all') {
    conditions.push(eq(chatSessions.archived, archivedParam === 'true'));
  }

  const rows = await trail.db
    .select()
    .from(chatSessions)
    .where(and(...conditions))
    .orderBy(desc(chatSessions.updatedAt))
    .all();

  return c.json(rows);
});

// Create a new session (title set later from first turn).
chatSessionRoutes.post('/knowledge-bases/:kbId/chat/sessions', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const user = getUser(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

  const id = `chs_${crypto.randomUUID().slice(0, 12)}`;
  await trail.db
    .insert(chatSessions)
    .values({
      id,
      tenantId: tenant.id,
      knowledgeBaseId: kbId,
      userId: user.id,
      title: null,
    })
    .run();
  const row = await trail.db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, id))
    .get();
  return c.json(row, 201);
});

// Session detail + all turns.
chatSessionRoutes.get('/chat/sessions/:id', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const id = c.req.param('id');

  const session = await trail.db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.tenantId, tenant.id)))
    .get();
  if (!session) return c.json({ error: 'Not found' }, 404);

  const turns = await trail.db
    .select()
    .from(chatTurns)
    .where(eq(chatTurns.sessionId, id))
    .orderBy(chatTurns.createdAt)
    .all();

  return c.json({ session, turns });
});

// Rename or archive.
chatSessionRoutes.patch('/chat/sessions/:id', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    title?: string;
    archived?: boolean;
  } | null;
  if (!body) return c.json({ error: 'Body required' }, 400);

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (typeof body.title === 'string') updates.title = body.title.slice(0, 120);
  if (typeof body.archived === 'boolean') updates.archived = body.archived;

  const result = await trail.db
    .update(chatSessions)
    .set(updates)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.tenantId, tenant.id)))
    .run();
  if (result.rowsAffected === 0) return c.json({ error: 'Not found' }, 404);

  const row = await trail.db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, id))
    .get();
  return c.json(row);
});

// Hard delete (cascades turns via FK).
chatSessionRoutes.delete('/chat/sessions/:id', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const id = c.req.param('id');

  const result = await trail.db
    .delete(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.tenantId, tenant.id)))
    .run();
  if (result.rowsAffected === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ deleted: true });
});
