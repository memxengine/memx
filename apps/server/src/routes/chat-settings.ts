/**
 * F159 Phase 3 — Per-KB chat backend settings.
 *
 * GET /api/v1/knowledge-bases/:kbId/chat-settings  — current effective
 *   resolution: per-KB columns + env-derived fallback. Useful for the
 *   admin UI panel that visualises the chain.
 *
 * PATCH /api/v1/knowledge-bases/:kbId/chat-settings  — curator-set
 *   override. Body fields:
 *     chatBackend?: 'claude-cli' | 'openrouter' | 'claude-api' | null
 *     chatModel?: string | null
 *     chatFallbackChain?: ChainStep[] | null
 *   Setting any field to null clears that override (chain resolution
 *   falls back to env / hardcoded default).
 *
 * Mirrors F149's per-KB ingest_backend/ingest_model/ingest_fallback_chain
 * pattern. PATCH route lives in its own file (not bundled into chat.ts)
 * because the chat handler should stay focused on the conversation
 * path; settings management is a separate admin surface.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { knowledgeBases } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { resolveKbId } from '@trail/core';
import { requireAuth, getTenant, getTrail } from '../middleware/auth.js';
import { resolveChatChain, type ChainStep } from '../services/chat/index.js';

export const chatSettingsRoutes = new Hono();

chatSettingsRoutes.use('*', requireAuth);

const ChainStepSchema = z.object({
  backend: z.enum(['claude-cli', 'openrouter', 'claude-api']),
  model: z.string().min(1),
});

const PatchBodySchema = z
  .object({
    chatBackend: z.enum(['claude-cli', 'openrouter', 'claude-api']).nullable().optional(),
    chatModel: z.string().min(1).nullable().optional(),
    chatFallbackChain: z.array(ChainStepSchema).min(1).nullable().optional(),
  })
  .strict();

chatSettingsRoutes.get('/knowledge-bases/:kbId/chat-settings', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

  const kb = await trail.db
    .select({
      chatBackend: knowledgeBases.chatBackend,
      chatModel: knowledgeBases.chatModel,
      chatFallbackChain: knowledgeBases.chatFallbackChain,
    })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .get();
  if (!kb) return c.json({ error: 'Knowledge base not found' }, 404);

  const effectiveChain = resolveChatChain({ kb });
  return c.json({
    overrides: {
      chatBackend: kb.chatBackend,
      chatModel: kb.chatModel,
      chatFallbackChain: kb.chatFallbackChain ? safeParse(kb.chatFallbackChain) : null,
    },
    effectiveChain,
  });
});

chatSettingsRoutes.patch('/knowledge-bases/:kbId/chat-settings', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      400,
    );
  }

  const update: Record<string, string | null> = {};
  if ('chatBackend' in parsed.data) {
    update.chatBackend = parsed.data.chatBackend ?? null;
  }
  if ('chatModel' in parsed.data) {
    update.chatModel = parsed.data.chatModel ?? null;
  }
  if ('chatFallbackChain' in parsed.data) {
    update.chatFallbackChain = parsed.data.chatFallbackChain
      ? JSON.stringify(parsed.data.chatFallbackChain)
      : null;
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: 'no_fields_to_update' }, 400);
  }

  await trail.db
    .update(knowledgeBases)
    .set(update)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .run();

  // Return the new effective chain so the UI can render the result
  // without a second GET round-trip.
  const kb = await trail.db
    .select({
      chatBackend: knowledgeBases.chatBackend,
      chatModel: knowledgeBases.chatModel,
      chatFallbackChain: knowledgeBases.chatFallbackChain,
    })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, tenant.id)))
    .get();
  return c.json({
    overrides: {
      chatBackend: kb?.chatBackend ?? null,
      chatModel: kb?.chatModel ?? null,
      chatFallbackChain: kb?.chatFallbackChain ? safeParse(kb.chatFallbackChain) : null,
    },
    effectiveChain: resolveChatChain({ kb: kb ?? undefined }),
  });
});

function safeParse(s: string): ChainStep[] | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
