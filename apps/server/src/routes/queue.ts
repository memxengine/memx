import { Hono, type Context } from 'hono';
import {
  CreateQueueCandidateSchema,
  ResolveCandidateSchema,
  ListQueueQuerySchema,
  canonicaliseTagString,
} from '@trail/shared';
import { requireAuth, getTenant, getUser, getTrail } from '../middleware/auth.js';
import {
  createCandidate,
  resolveCandidate,
  reopenCandidate,
  resolveActions,
  listCandidates,
  countCandidates,
  getCandidate,
  resolveKbId,
  type Actor,
  type ResolutionResult,
} from '@trail/core';
import { INGEST_USER_ID } from '../bootstrap/ingest-user.js';
import { broadcaster } from '../services/broadcast.js';
import { ensureCandidateInLocale } from '../services/translation.js';
import { proposeSourcesForOrphan } from '../services/source-inferer.js';
import { suggestTagsForNeuron, isAutoTagEnabled } from '../services/tag-suggester.js';
import { documents } from '@trail/db';
import { and, eq } from 'drizzle-orm';

export const queueRoutes = new Hono();

queueRoutes.use('*', requireAuth);

/**
 * F92 — check whether an incoming candidate's metadata JSON already
 * carries a non-empty `tags` field. Curator-supplied tags win over
 * the auto-tagger's suggestion so we never overwrite intent.
 */
function metadataHasTags(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { tags?: unknown };
    return typeof parsed.tags === 'string' && parsed.tags.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * F92 — inject a tags string into the candidate's metadata JSON,
 * preserving all other fields (op, filename, path, connector, ...).
 * The value is canonicalised one more time at the boundary so a
 * stray bad suggestion can't bypass the rules enforced elsewhere.
 */
function mergeTagsIntoMetadata(raw: string | null, tags: string): string {
  const canonical = canonicaliseTagString(tags);
  if (!canonical) return raw ?? JSON.stringify({});
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      const candidate = JSON.parse(raw) as unknown;
      if (candidate && typeof candidate === 'object') {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // fall through — replace malformed metadata with a fresh object
    }
  }
  parsed.tags = canonical;
  return JSON.stringify(parsed);
}

/**
 * F92 — normalise a pre-existing metadata.tags value in-place. Leaves
 * all other metadata fields untouched; drops the `tags` field entirely
 * if none of the raw entries canonicalise to something valid (so a
 * purely-invalid tag list doesn't persist garbage).
 */
function canonicaliseTagsInMetadata(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return raw;
    if (typeof parsed.tags !== 'string') return raw;
    const canonical = canonicaliseTagString(parsed.tags);
    if (canonical === null) {
      delete parsed.tags;
    } else {
      parsed.tags = canonical;
    }
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

/**
 * Build the Actor for a candidate write. A curator clicking a resolution
 * button in the admin is `kind: 'user'` — that pins `createdBy`, which the
 * F19 policy reads as "human-originated, never auto-approve". The pre-seeded
 * service user (bearer-authenticated ingest calls, e.g. buddy's F39 POSTs)
 * is machine-originated: `kind: 'system'` leaves createdBy null so axes 1
 * and 2 (trusted pipeline, confidence threshold) can evaluate the candidate
 * on its own merits.
 */
function userActor(c: Context): Actor {
  const user = getUser(c);
  if (user.id === INGEST_USER_ID) {
    return { id: user.id, kind: 'system' };
  }
  return { id: user.id, kind: 'user' };
}

/**
 * Emit the universal resolved event + the narrow approved event when the
 * effect produced a Neuron. Doc-indexers (reference-extractor, contradiction-
 * lint, backlink-extractor) subscribe to `candidate_approved` and only need
 * to wake up when a new/edited Neuron exists. The pending-count badge + the
 * admin panels subscribe to `candidate_resolved` so they react to every
 * curator decision regardless of effect.
 */
function emitResolution(
  result: ResolutionResult,
  candidate: { tenantId: string; knowledgeBaseId: string },
): void {
  broadcaster.emit({
    type: 'candidate_resolved',
    tenantId: candidate.tenantId,
    kbId: candidate.knowledgeBaseId,
    candidateId: result.candidateId,
    actionId: result.actionId,
    effect: result.effect,
    documentId: result.documentId,
    autoApproved: result.autoApproved,
  });
  if (result.effect === 'approve' && result.documentId) {
    broadcaster.emit({
      type: 'candidate_approved',
      tenantId: candidate.tenantId,
      kbId: candidate.knowledgeBaseId,
      candidateId: result.candidateId,
      documentId: result.documentId,
      autoApproved: result.autoApproved,
    });
  }
}

queueRoutes.post('/queue/candidates', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateQueueCandidateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const tenant = getTenant(c);
  // F92 — auto-tag chat-saved candidates. The save flow in the admin
  // drafts a title + body from a chat turn; the LLM proposes 0-5 tags
  // drawn from the KB's existing vocabulary before the candidate is
  // enqueued. Toggleable via TRAIL_AUTO_TAG_CHAT_SAVES. Existing tags
  // on the incoming metadata (if any) win — we never overwrite the
  // curator's intent.
  let payload = parsed.data;

  // F135 — accept slug or UUID in payload.knowledgeBaseId. Resolve to
  // canonical UUID so createCandidate's FK reference resolves.
  const kbId = await resolveKbId(getTrail(c), tenant.id, payload.knowledgeBaseId);
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);
  payload = { ...payload, knowledgeBaseId: kbId };
  // F92 — canonicalise any incoming metadata.tags string at the HTTP
  // boundary so external POSTs (scripts, webhooks, the chat-save
  // flow, buddy's trail_save) all store the same normalised shape.
  // Ingest-path candidates that write tags via the compile prompt
  // also flow through here.
  if (payload.metadata && metadataHasTags(payload.metadata)) {
    payload = {
      ...payload,
      metadata: canonicaliseTagsInMetadata(payload.metadata),
    };
  }
  if (
    isAutoTagEnabled() &&
    payload.kind === 'chat-answer' &&
    !metadataHasTags(payload.metadata)
  ) {
    try {
      const suggested = await suggestTagsForNeuron(
        getTrail(c),
        tenant.id,
        payload.knowledgeBaseId,
        { title: payload.title, content: payload.content },
      );
      if (suggested) {
        payload = {
          ...payload,
          metadata: mergeTagsIntoMetadata(payload.metadata ?? null, suggested),
        };
      }
    } catch (err) {
      // LLM hiccup shouldn't block the save — log-and-continue so the
      // candidate still lands in the queue, just without auto-tags.
      console.error('[queue] auto-tag suggestion failed:', err instanceof Error ? err.message : err);
    }
  }
  try {
    const result = await createCandidate(getTrail(c), tenant.id, payload, userActor(c));
    broadcaster.emit({
      type: 'candidate_created',
      tenantId: tenant.id,
      kbId: result.candidate.knowledgeBaseId,
      candidateId: result.candidate.id,
      kind: result.candidate.kind,
      title: result.candidate.title,
      status: result.approval ? 'approved' : 'pending',
      autoApproved: !!result.approval,
      confidence: result.candidate.confidence,
      createdBy: result.candidate.createdBy,
    });
    if (result.approval) {
      emitResolution(result.approval, {
        tenantId: tenant.id,
        knowledgeBaseId: result.candidate.knowledgeBaseId,
      });
    }
    return c.json(result, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Knowledge base not found')) return c.json({ error: msg }, 404);
    return c.json({ error: msg }, 500);
  }
});

queueRoutes.get('/queue', async (c) => {
  const query = ListQueueQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!query.success) return c.json({ error: query.error.flatten() }, 400);

  const tenant = getTenant(c);
  const trail = getTrail(c);

  // F135 — accept slug or UUID in ?knowledgeBaseId=. Resolve to canonical
  // UUID so listCandidates' FK-scoped filter matches.
  let resolved = query.data;
  if (query.data.knowledgeBaseId) {
    const kbId = await resolveKbId(trail, tenant.id, query.data.knowledgeBaseId);
    if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);
    resolved = { ...query.data, knowledgeBaseId: kbId };
  }

  // `count` is the TOTAL matching filter — independent of `limit`. Callers
  // that want the length of the paginated page just use items.length.
  const [items, count] = await Promise.all([
    listCandidates(trail, tenant.id, resolved),
    countCandidates(trail, tenant.id, resolved),
  ]);
  return c.json({ items, count });
});

queueRoutes.get('/queue/:id', async (c) => {
  const tenant = getTenant(c);
  const candidate = await getCandidate(getTrail(c), tenant.id, c.req.param('id'));
  if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
  return c.json(candidate);
});

/**
 * GET /queue/:id/translate?locale=da — ensure every translatable piece of
 * the candidate (title, content, action labels + explanations) has a
 * value in the requested locale. Calls the LLM once on first view,
 * caches all fields back into the candidate row so subsequent reads are
 * instant.
 *
 * Primary consumer: the admin, which calls this right after loading a
 * candidate in a non-EN locale. EN is free — returns directly from the
 * primary columns. The response shape is always the same
 * ({ locale, title, content, actions }) so callers don't branch per locale.
 */
queueRoutes.get('/queue/:id/translate', async (c) => {
  const tenant = getTenant(c);
  const url = new URL(c.req.url);
  const rawLocale = url.searchParams.get('locale') ?? 'en';
  // Only 'en' and 'da' are currently supported — other codes fall back to
  // 'en' so a mistyped locale doesn't burn tokens trying to translate to
  // something like '', '*', or 'xx-YY'. Adding a locale = one entry in
  // LOCALE_NAMES in translation service + one in shared's Locale union.
  const locale: 'en' | 'da' = rawLocale === 'da' ? 'da' : 'en';

  const bundle = await ensureCandidateInLocale(
    getTrail(c),
    tenant.id,
    c.req.param('id'),
    locale,
  );
  if (!bundle) return c.json({ error: 'Candidate not found' }, 404);
  return c.json({ locale, ...bundle });
});

/**
 * POST /queue/:id/reopen — flip a rejected candidate back to pending so
 * the curator gets another chance. Use-case: "I accidentally clicked
 * Dismiss" or "on reflection this IS a real problem". Clears rejection
 * reason + resolvedAction; preserves reviewedBy/reviewedAt in the row
 * for audit.
 *
 * Fires a candidate_created event so admin badges + the queue panel
 * reflect the newly-pending state live. The event carries `status:
 * pending` and a synthetic title prefix so consumers can tell a reopen
 * from a brand-new emission if they care; the simple case (just update
 * the count) doesn't need to.
 */
queueRoutes.post('/queue/:id/reopen', async (c) => {
  const tenant = getTenant(c);
  const existing = await getCandidate(getTrail(c), tenant.id, c.req.param('id'));
  if (!existing) return c.json({ error: 'Candidate not found' }, 404);
  try {
    const result = await reopenCandidate(
      getTrail(c),
      tenant.id,
      c.req.param('id'),
      userActor(c),
    );
    broadcaster.emit({
      type: 'candidate_created',
      tenantId: tenant.id,
      kbId: existing.knowledgeBaseId,
      candidateId: result.candidateId,
      kind: existing.kind,
      title: existing.title,
      status: 'pending',
      autoApproved: false,
      confidence: existing.confidence,
      createdBy: existing.createdBy,
    });
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Candidate not found')) return c.json({ error: msg }, 404);
    if (msg.startsWith('Can only reopen')) return c.json({ error: msg }, 409);
    return c.json({ error: msg }, 500);
  }
});

/**
 * The canonical curator-decision endpoint. Replaces the old approve + reject
 * split. Body: `{ actionId, args?, filename?, path?, editedContent?, reason?,
 * notes? }`. `actionId` must match one of the candidate's actions (or
 * 'approve'/'reject' on legacy candidates).
 */
queueRoutes.post('/queue/:id/resolve', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = ResolveCandidateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const tenant = getTenant(c);
  const trail = getTrail(c);
  const existing = await getCandidate(trail, tenant.id, c.req.param('id'));
  if (!existing) return c.json({ error: 'Candidate not found' }, 404);

  // Auto-link-sources: if the caller hasn't supplied args.sources, run
  // the LLM inferer first to propose which Sources the orphan Neuron
  // most likely draws from, then pass the result through to core. The
  // core handler refuses to run with an empty args.sources, so we
  // short-circuit with a 422 when the inferer can't find anything —
  // the candidate stays pending for manual linking.
  let payload = parsed.data;
  if (payload.actionId === 'auto-link-sources') {
    const existingSources = payload.args?.sources;
    if (!Array.isArray(existingSources) || existingSources.length === 0) {
      const actions = resolveActions(existing);
      const action = actions.find((a) => a.id === 'auto-link-sources');
      const docId =
        typeof action?.args?.documentId === 'string' ? action.args.documentId : null;
      if (!docId) {
        return c.json(
          { error: 'auto-link-sources action missing documentId on candidate' },
          400,
        );
      }
      const doc = await trail.db
        .select({
          id: documents.id,
          content: documents.content,
          knowledgeBaseId: documents.knowledgeBaseId,
        })
        .from(documents)
        .where(
          and(
            eq(documents.id, docId),
            eq(documents.tenantId, tenant.id),
            eq(documents.kind, 'wiki'),
          ),
        )
        .get();
      if (!doc) {
        return c.json({ error: 'Target Neuron not found' }, 404);
      }
      const inferred = await proposeSourcesForOrphan(
        trail,
        tenant.id,
        doc.knowledgeBaseId,
        doc.content ?? '',
      );
      if (inferred.length === 0) {
        return c.json(
          {
            error: 'no_sources_inferred',
            message:
              "The LLM couldn't identify any plausible Sources for this Neuron. Link them manually via the editor.",
          },
          422,
        );
      }
      payload = {
        ...payload,
        args: { ...(payload.args ?? {}), sources: inferred },
      };
    }
  }

  try {
    const result = await resolveCandidate(
      trail,
      tenant.id,
      c.req.param('id'),
      userActor(c),
      payload,
    );
    emitResolution(result, existing);
    return c.json({
      ...result,
      ...(payload.actionId === 'auto-link-sources' && Array.isArray(payload.args?.sources)
        ? { inferredSources: payload.args.sources as string[] }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Candidate not found')) return c.json({ error: msg }, 404);
    if (msg.startsWith('Candidate is not pending')) return c.json({ error: msg }, 409);
    if (msg.startsWith('Unknown action')) return c.json({ error: msg }, 400);
    return c.json({ error: msg }, 500);
  }
});

/**
 * Bulk resolve. Applies the SAME decision to a list of candidates. The
 * decision can be specified two ways:
 *
 *   - `actionId: "approve"` — look up that action by id on each candidate.
 *     Works for legacy candidates (default Approve/Reject) and for rich
 *     candidates that happen to use the same actionId, but fails on any
 *     candidate where the actionId doesn't match — caller gets a
 *     per-row error.
 *
 *   - `effect: "reject"` — look up an action by its effect kind. Per-
 *     candidate: find an action whose effect matches and execute it. The
 *     only universal bulk operation because every candidate has at least
 *     one reject-effect action (default 'reject' on legacy, 'dismiss' on
 *     rich). Use this for "dismiss the selection" without caring which
 *     actionId each row uses internally.
 *
 * Per-candidate errors don't abort the batch — we return a summary
 * telling the caller exactly which ones succeeded, which failed, and why.
 * Runs serially — parallel would stampede the write path; at curator
 * click pace sequential is fine. Each resolution emits its own event
 * pair, same as individual /resolve.
 */
queueRoutes.post('/queue/bulk', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | {
        actionId?: string;
        effect?: string;
        ids?: unknown;
        reason?: unknown;
        filename?: unknown;
        path?: unknown;
        args?: unknown;
      }
    | null;
  const actionId = typeof body?.actionId === 'string' ? body.actionId : null;
  const effect = typeof body?.effect === 'string' ? body.effect : null;
  const ids = Array.isArray(body?.ids)
    ? body!.ids.filter((id): id is string => typeof id === 'string')
    : [];
  const reason = typeof body?.reason === 'string' ? body.reason : undefined;
  const filename = typeof body?.filename === 'string' ? body.filename : undefined;
  const path = typeof body?.path === 'string' ? body.path : undefined;
  const args =
    body?.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : undefined;

  if (!actionId && !effect) return c.json({ error: 'actionId or effect required' }, 400);
  if (ids.length === 0) return c.json({ error: 'ids array required' }, 400);
  if (ids.length > 500) return c.json({ error: 'max 500 ids per batch' }, 400);

  const tenant = getTenant(c);
  const trail = getTrail(c);
  const actor = userActor(c);

  const results = {
    actionId,
    effect,
    requested: ids.length,
    succeeded: [] as Array<{ id: string; actionId: string }>,
    failed: [] as Array<{ id: string; error: string }>,
  };

  for (const id of ids) {
    const existing = await getCandidate(trail, tenant.id, id);
    if (!existing) {
      results.failed.push({ id, error: 'not found' });
      continue;
    }

    // Resolve which actionId this candidate should receive. Direct
    // actionId: use verbatim. Effect: pick the candidate's own action
    // whose effect matches. If neither matches, bail with a helpful
    // error so the admin can tell the curator which row skipped.
    let finalActionId: string | null = actionId;
    if (!finalActionId && effect) {
      const actions = resolveActions(existing);
      const match = actions.find((a) => a.effect === effect);
      if (!match) {
        results.failed.push({
          id,
          error: `no action with effect "${effect}" (available: ${actions.map((a) => a.effect).join(', ')})`,
        });
        continue;
      }
      finalActionId = match.id;
    }
    if (!finalActionId) {
      results.failed.push({ id, error: 'no action resolved' });
      continue;
    }

    try {
      const parsed = ResolveCandidateSchema.safeParse({
        actionId: finalActionId,
        args,
        filename,
        path,
        reason,
      });
      if (!parsed.success) {
        results.failed.push({ id, error: 'invalid resolve payload' });
        continue;
      }
      const r = await resolveCandidate(trail, tenant.id, id, actor, parsed.data);
      emitResolution(r, existing);
      results.succeeded.push({ id, actionId: finalActionId });
    } catch (err) {
      results.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json(results);
});

/**
 * F96 — bulk-execute each candidate's LLM-recommended action. Unlike
 * /queue/bulk which applies the SAME action to all, this looks up
 * `metadata.recommendation.recommendedActionId` per candidate and
 * dispatches that specific action. Candidates without a recommendation
 * are skipped gracefully (reported as failed with a clear reason).
 *
 * Useful for the "Accept recommendation"-across-selection curator flow:
 * scan 40 orphans, trust the LLM's picks on the ones you agree with,
 * select all, accept. One-click batch resolution.
 */
queueRoutes.post('/queue/bulk-accept-recommendations', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids)
    ? body!.ids.filter((id): id is string => typeof id === 'string')
    : [];
  if (ids.length === 0) return c.json({ error: 'ids array required' }, 400);
  if (ids.length > 500) return c.json({ error: 'max 500 ids per batch' }, 400);

  const tenant = getTenant(c);
  const trail = getTrail(c);
  const actor = userActor(c);

  const results = {
    requested: ids.length,
    succeeded: [] as Array<{ id: string; actionId: string }>,
    failed: [] as Array<{ id: string; error: string }>,
  };

  for (const id of ids) {
    const existing = await getCandidate(trail, tenant.id, id);
    if (!existing) {
      results.failed.push({ id, error: 'not found' });
      continue;
    }
    const recActionId = extractRecommendedActionId(existing.metadata);
    if (!recActionId) {
      results.failed.push({ id, error: 'no recommendation yet — try again shortly' });
      continue;
    }
    // Reject-effect actions need a reason-prompt UX — don't auto-execute
    // these in bulk. Curator should click them one-by-one so they can
    // type a rejection reason.
    const actions = resolveActions(existing);
    const matched = actions.find((a) => a.id === recActionId);
    if (!matched) {
      results.failed.push({ id, error: `recommended action "${recActionId}" not in candidate's actions` });
      continue;
    }
    // Reject-effect in bulk: pass the LLM's reasoning as the rejection
    // reason so the candidate still records WHY it was dismissed — no
    // need to route through the reason-modal for each one.
    const reason = matched.effect === 'reject'
      ? extractRecommendationReasoning(existing.metadata) ?? 'accepted LLM recommendation'
      : undefined;

    try {
      // auto-link-sources needs runtime args.sources populated by the
      // LLM inferer — the same step the single-resolve route does.
      // Without this, core's handler throws "no payload.args.sources"
      // and only actions that don't need LLM inference (archive,
      // acknowledge, etc.) succeed in bulk. Run the inferer per
      // candidate here before dispatching.
      let argsForResolve: Record<string, unknown> | undefined = matched.args;
      if (recActionId === 'auto-link-sources') {
        const docId = typeof matched.args?.documentId === 'string' ? matched.args.documentId : null;
        if (!docId) {
          results.failed.push({ id, error: 'auto-link-sources action missing documentId' });
          continue;
        }
        const doc = await trail.db
          .select({ content: documents.content, knowledgeBaseId: documents.knowledgeBaseId })
          .from(documents)
          .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id), eq(documents.kind, 'wiki')))
          .get();
        if (!doc) {
          results.failed.push({ id, error: 'target Neuron not found' });
          continue;
        }
        const inferred = await proposeSourcesForOrphan(
          trail,
          tenant.id,
          doc.knowledgeBaseId,
          doc.content ?? '',
        );
        if (inferred.length === 0) {
          results.failed.push({
            id,
            error: 'no plausible sources inferred — link manually instead',
          });
          continue;
        }
        argsForResolve = { ...(matched.args ?? {}), sources: inferred };
      }

      const parsed = ResolveCandidateSchema.safeParse({
        actionId: recActionId,
        args: argsForResolve,
        ...(reason ? { reason } : {}),
      });
      if (!parsed.success) {
        results.failed.push({ id, error: 'invalid resolve payload' });
        continue;
      }
      const r = await resolveCandidate(trail, tenant.id, id, actor, parsed.data);
      emitResolution(r, existing);
      results.succeeded.push({ id, actionId: recActionId });
    } catch (err) {
      results.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json(results);
});

/**
 * Pull the LLM-recommended actionId out of a candidate's metadata JSON.
 * Returns null when the recommendation hasn't landed yet (still running
 * in the background) or the field is malformed.
 */
function extractRecommendedActionId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { recommendation?: { recommendedActionId?: unknown } };
    const id = parsed.recommendation?.recommendedActionId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

function extractRecommendationReasoning(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { recommendation?: { reasoning?: unknown } };
    const r = parsed.recommendation?.reasoning;
    return typeof r === 'string' ? r : null;
  } catch {
    return null;
  }
}
