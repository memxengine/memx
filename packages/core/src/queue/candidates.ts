import { and, desc, eq, sql } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import {
  queueCandidates,
  documents,
  wikiEvents,
  knowledgeBases,
  schema,
  type TrailDatabase,
} from '@trail/db';
import type {
  CreateQueueCandidate,
  ResolveCandidatePayload,
  QueueCandidate,
  ListQueueQuery,
  CandidateAction,
  CandidateEffectKind,
} from '@trail/shared';
import { slugify } from '../slug.js';
import { shouldAutoApprove } from './policy.js';

/**
 * Queue module — the sole write path into wiki documents.
 *
 * F17 Session A + B landed the behaviour. F40.1 threads `trail`
 * (TrailDatabase) through the public API so callers resolve their
 * per-request database instance from Hono context instead of a
 * module-level global. F40.2 replaces that per-request resolution
 * with a per-tenant pool — the signature here is unchanged.
 *
 * Post-F90 refactor: every curator decision flows through the single
 * `resolveCandidate(id, actionId)` entry point. The candidate's
 * `actions: CandidateAction[]` lists the resolution options the producer
 * wanted to offer; the engine dispatches on each action's `effect` to a
 * dedicated handler. The legacy binary approve/reject split is collapsed
 * into two default actions (id='approve', id='reject') that every
 * candidate carries unless a producer overrides them.
 */

/**
 * `Db` is the shared Drizzle surface between `trail.db` and a tx inside
 * a `db.transaction(async (tx) => …)` callback. Using the abstract
 * `BaseSQLiteDatabase` here lets helpers accept either a plain database
 * handle or a transaction without type gymnastics — both expose the
 * select / insert / update / delete methods we use.
 */
type Db = BaseSQLiteDatabase<'async', unknown, typeof schema>;

// ── Types ──────────────────────────────────────────────────────────

/**
 * Per-candidate operation descriptor, serialised into `candidate.metadata` JSON.
 *
 *   op: "create"  — new wiki page (filename + path required).
 *   op: "update"  — replace full content of an existing page.
 *                   `candidate.content` IS the new content; str_replace /
 *                   append compute it client-side.
 *   op: "archive" — soft-delete an existing page.
 */
export interface CandidateOp {
  op: 'create' | 'update' | 'archive';
  targetDocumentId?: string;
  filename?: string;
  path?: string;
  tags?: string | null;
}

export interface Actor {
  /** User id for curator actions, or a synthetic id like 'mcp:ingest' for pipelines. */
  id: string;
  kind: 'user' | 'llm' | 'system';
}

/**
 * Uniform result of a resolution — whichever effect ran. `documentId` is
 * populated when the effect touched a Neuron; null for side-effect-only
 * actions (flag-source, mark-still-relevant).
 */
export interface ResolutionResult {
  candidateId: string;
  actionId: string;
  effect: CandidateEffectKind;
  documentId: string | null;
  wikiEventId: string | null;
  autoApproved: boolean;
  /** Final candidate status after the resolution. */
  status: 'approved' | 'rejected';
}

interface CommitContext {
  now: string;
  auto: boolean;
  summary: string;
  metadataJson: string | null;
}

// ── Default actions ────────────────────────────────────────────────
// Every candidate gets Approve/Reject unless its producer overrides. The
// user-facing strings live in English (LLM native tongue); the admin
// UI fills Danish via its static i18n dict because these strings are
// system-level, not content-level, so they don't need per-candidate
// translation caching.

const APPROVE_ACTION: CandidateAction = {
  id: 'approve',
  effect: 'approve',
  label: { en: 'Approve' },
  explanation: {
    en: 'Accept this candidate and apply its change to the Trail.',
  },
};

const REJECT_ACTION: CandidateAction = {
  id: 'reject',
  effect: 'reject',
  label: { en: 'Reject' },
  explanation: {
    en: "Discard this candidate. Nothing in the Trail changes.",
  },
};

export const DEFAULT_ACTIONS: CandidateAction[] = [APPROVE_ACTION, REJECT_ACTION];

/**
 * Return the candidate's actions, filling in defaults when the producer
 * didn't specify any. Reads the JSON column and validates shape loosely —
 * malformed data degrades to DEFAULT_ACTIONS rather than throwing, so one
 * bad row doesn't brick the queue.
 */
export function resolveActions(candidate: QueueCandidate): CandidateAction[] {
  const raw = (candidate as { actions?: unknown }).actions;
  if (!raw) return DEFAULT_ACTIONS;
  if (Array.isArray(raw)) return raw as CandidateAction[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as CandidateAction[];
    } catch {
      // fall through
    }
  }
  return DEFAULT_ACTIONS;
}

// ── Helpers (pure) ─────────────────────────────────────────────────

function parseOp(candidate: QueueCandidate): CandidateOp {
  if (!candidate.metadata) return { op: 'create' };
  try {
    const parsed = JSON.parse(candidate.metadata) as Partial<CandidateOp>;
    if (parsed && typeof parsed === 'object' && parsed.op) {
      return parsed as CandidateOp;
    }
  } catch {
    // fall through to default
  }
  return { op: 'create' };
}

async function lastEventIdFor(
  db: Db,
  tenantId: string,
  documentId: string,
): Promise<string | null> {
  const row = await db
    .select({ id: wikiEvents.id })
    .from(wikiEvents)
    .where(
      and(
        eq(wikiEvents.tenantId, tenantId),
        eq(wikiEvents.documentId, documentId),
      ),
    )
    .orderBy(desc(wikiEvents.createdAt))
    .limit(1)
    .get();
  return row?.id ?? null;
}

/**
 * Attach the stamped-default actions to a QueueCandidate shape returned
 * from a raw SELECT. The stored `actions` and `translations` columns are
 * text (nullable JSON); the typed schema unpacks them into arrays/maps.
 * Doing the conversion here means every list/get response is uniform.
 */
function hydrate(row: unknown): QueueCandidate {
  const r = row as QueueCandidate & { actions?: unknown; translations?: unknown };
  const actions = r.actions
    ? typeof r.actions === 'string'
      ? safeParseActions(r.actions)
      : (r.actions as CandidateAction[])
    : null;
  const translations = r.translations
    ? typeof r.translations === 'string'
      ? safeParseTranslations(r.translations)
      : (r.translations as QueueCandidate['translations'])
    : null;
  return { ...r, actions, translations };
}

function safeParseActions(raw: string): CandidateAction[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as CandidateAction[];
  } catch {
    // fall through
  }
  return null;
}

function safeParseTranslations(raw: string): QueueCandidate['translations'] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as QueueCandidate['translations'];
    }
  } catch {
    // fall through
  }
  return null;
}

// ── Public API ─────────────────────────────────────────────────────

/** Enqueue a candidate. Runs the auto-approval policy inline; stays pending otherwise. */
export async function createCandidate(
  trail: TrailDatabase,
  tenantId: string,
  input: CreateQueueCandidate,
  actor: Actor,
): Promise<{ candidate: QueueCandidate; approval?: ResolutionResult }> {
  const { db } = trail;

  const kb = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(
      and(
        eq(knowledgeBases.id, input.knowledgeBaseId),
        eq(knowledgeBases.tenantId, tenantId),
      ),
    )
    .get();
  if (!kb) throw new Error(`Knowledge base not found: ${input.knowledgeBaseId}`);

  const id = `cnd_${crypto.randomUUID().slice(0, 12)}`;
  await db
    .insert(queueCandidates)
    .values({
      id,
      tenantId,
      knowledgeBaseId: input.knowledgeBaseId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      metadata: input.metadata ?? null,
      confidence: input.confidence ?? null,
      impactEstimate: input.impactEstimate ?? null,
      status: 'pending',
      createdBy: actor.kind === 'user' ? actor.id : null,
      actions: input.actions ? JSON.stringify(input.actions) : null,
    })
    .run();

  const candidate = hydrate(
    await db.select().from(queueCandidates).where(eq(queueCandidates.id, id)).get(),
  );

  if (shouldAutoApprove(candidate)) {
    const approval = await resolveCandidate(
      trail,
      tenantId,
      id,
      actor,
      { actionId: 'approve', path: '/neurons/auto/' },
      { auto: true },
    );
    return { candidate, approval };
  }

  return { candidate };
}

/**
 * Execute a curator decision. Dispatches on the resolved action's effect.
 *
 * `actionId` references one of `candidate.actions[]` when the producer
 * populated them, or 'approve'/'reject' on legacy (null-actions) candidates.
 * Unknown actionIds throw so the caller's UI can't silently drop a click.
 */
export async function resolveCandidate(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
  actor: Actor,
  payload: ResolveCandidatePayload,
  opts: { auto?: boolean } = {},
): Promise<ResolutionResult> {
  const { db } = trail;

  const candidate = hydrate(
    await db
      .select()
      .from(queueCandidates)
      .where(
        and(
          eq(queueCandidates.id, candidateId),
          eq(queueCandidates.tenantId, tenantId),
        ),
      )
      .get(),
  );
  if (!candidate.id) throw new Error(`Candidate not found: ${candidateId}`);
  if (candidate.status !== 'pending') {
    throw new Error(`Candidate is not pending (current status=${candidate.status})`);
  }

  const actions = resolveActions(candidate);
  const action = actions.find((a) => a.id === payload.actionId);
  if (!action) {
    throw new Error(
      `Unknown action "${payload.actionId}" for candidate ${candidateId}. Available: ${actions.map((a) => a.id).join(', ')}`,
    );
  }

  const ctx: CommitContext = {
    now: new Date().toISOString(),
    auto: !!opts.auto,
    summary: opts.auto
      ? `auto: ${action.id}`
      : payload.notes ?? `${action.id} by curator`,
    metadataJson: payload.notes ? JSON.stringify({ notes: payload.notes }) : null,
  };

  switch (action.effect) {
    case 'approve':
      return executeApprove(trail, candidate, action, payload, actor, ctx);
    case 'reject':
      return executeReject(trail, candidate, action, payload, actor, ctx);
    case 'acknowledge':
      return executeAcknowledge(trail, candidate, action, actor, ctx);
    case 'retire-neuron':
      return executeRetireNeuron(trail, candidate, action, actor, ctx);
    case 'flag-source':
      return executeFlagSource(trail, candidate, action, actor, ctx);
    case 'mark-still-relevant':
      return executeMarkStillRelevant(trail, candidate, action, actor, ctx);
    case 'merge-into-new':
    case 'refresh-from-source':
      throw new Error(`Effect "${action.effect}" is planned for a later iteration.`);
  }
}

// ── Effect: acknowledge ────────────────────────────────────────────
// "I've seen this, I'll handle it outside the queue." Marks the candidate
// resolved with status='approved' — the curator accepted the finding was
// real — without mutating any document. Used for contradictions the
// curator wants to reconcile by hand in the Neuron editor.

async function executeAcknowledge(
  trail: TrailDatabase,
  candidate: QueueCandidate,
  action: CandidateAction,
  actor: Actor,
  ctx: CommitContext,
): Promise<ResolutionResult> {
  await trail.db
    .update(queueCandidates)
    .set({
      status: 'approved',
      reviewedBy: actor.id,
      reviewedAt: ctx.now,
      autoApprovedAt: ctx.auto ? ctx.now : null,
      resolvedAction: action.id,
    })
    .where(eq(queueCandidates.id, candidate.id))
    .run();

  return {
    candidateId: candidate.id,
    actionId: action.id,
    effect: action.effect,
    documentId: null,
    wikiEventId: null,
    autoApproved: ctx.auto,
    status: 'approved',
  };
}

// ── Effect: approve (existing create/update/archive dispatch) ───────

async function executeApprove(
  trail: TrailDatabase,
  candidate: QueueCandidate,
  action: CandidateAction,
  payload: ResolveCandidatePayload,
  actor: Actor,
  ctx: CommitContext,
): Promise<ResolutionResult> {
  const op = parseOp(candidate);
  return trail.db.transaction(async (tx) => {
    if (op.op === 'update') return approveUpdate(tx, candidate, op, payload, action, actor, ctx);
    if (op.op === 'archive') return approveArchive(tx, candidate, op, action, actor, ctx);
    return approveCreate(tx, candidate, op, payload, action, actor, ctx);
  });
}

async function approveCreate(
  tx: Db,
  candidate: QueueCandidate,
  op: CandidateOp,
  payload: ResolveCandidatePayload,
  action: CandidateAction,
  actor: Actor,
  ctx: CommitContext,
): Promise<ResolutionResult> {
  const content = payload.editedContent ?? candidate.content;
  const rawName =
    payload.filename ?? op.filename ?? slugify(candidate.title) ?? 'untitled';
  const filename = rawName.endsWith('.md') ? rawName : `${rawName}.md`;
  const pathIn = payload.filename
    ? payload.path ?? '/neurons/queries/'
    : op.path ?? payload.path ?? '/neurons/queries/';
  const path = pathIn.endsWith('/') ? pathIn : `${pathIn}/`;

  const docId = `doc_${crypto.randomUUID().slice(0, 12)}`;
  await tx
    .insert(documents)
    .values({
      id: docId,
      tenantId: candidate.tenantId,
      knowledgeBaseId: candidate.knowledgeBaseId,
      userId: actor.kind === 'user' ? actor.id : candidate.createdBy ?? actor.id,
      kind: 'wiki',
      filename,
      title: candidate.title,
      path,
      fileType: 'md',
      fileSize: content.length,
      content,
      tags: op.tags ?? null,
      status: 'ready',
      version: 1,
    })
    .run();

  const eventId = await emitEvent(tx, {
    tenantId: candidate.tenantId,
    documentId: docId,
    eventType: 'created',
    previousVersion: null,
    newVersion: 1,
    prevEventId: null,
    contentSnapshot: content,
    candidateId: candidate.id,
    actor,
    ctx,
  });

  await finaliseApproved(tx, candidate.id, actor, docId, action.id, ctx);
  return {
    candidateId: candidate.id,
    actionId: action.id,
    effect: action.effect,
    documentId: docId,
    wikiEventId: eventId,
    autoApproved: ctx.auto,
    status: 'approved',
  };
}

async function approveUpdate(
  tx: Db,
  candidate: QueueCandidate,
  op: CandidateOp,
  payload: ResolveCandidatePayload,
  action: CandidateAction,
  actor: Actor,
  ctx: CommitContext,
): Promise<ResolutionResult> {
  if (!op.targetDocumentId) {
    throw new Error('update candidate missing metadata.targetDocumentId');
  }
  const doc = await tx
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, op.targetDocumentId),
        eq(documents.tenantId, candidate.tenantId),
        eq(documents.kind, 'wiki'),
      ),
    )
    .get();
  if (!doc) {
    throw new Error(`Target wiki document not found: ${op.targetDocumentId}`);
  }

  const content = payload.editedContent ?? candidate.content;
  const newVersion = doc.version + 1;
  const prevEventId = await lastEventIdFor(tx, candidate.tenantId, doc.id);

  await tx
    .update(documents)
    .set({
      content,
      fileSize: content.length,
      version: newVersion,
      updatedAt: ctx.now,
    })
    .where(eq(documents.id, doc.id))
    .run();

  const eventId = await emitEvent(tx, {
    tenantId: candidate.tenantId,
    documentId: doc.id,
    eventType: 'edited',
    previousVersion: doc.version,
    newVersion,
    prevEventId,
    contentSnapshot: content,
    candidateId: candidate.id,
    actor,
    ctx,
  });

  await finaliseApproved(tx, candidate.id, actor, doc.id, action.id, ctx);
  return {
    candidateId: candidate.id,
    actionId: action.id,
    effect: action.effect,
    documentId: doc.id,
    wikiEventId: eventId,
    autoApproved: ctx.auto,
    status: 'approved',
  };
}

async function approveArchive(
  tx: Db,
  candidate: QueueCandidate,
  op: CandidateOp,
  action: CandidateAction,
  actor: Actor,
  ctx: CommitContext,
): Promise<ResolutionResult> {
  if (!op.targetDocumentId) {
    throw new Error('archive candidate missing metadata.targetDocumentId');
  }
  const doc = await tx
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, op.targetDocumentId),
        eq(documents.tenantId, candidate.tenantId),
        eq(documents.kind, 'wiki'),
      ),
    )
    .get();
  if (!doc) {
    throw new Error(`Target wiki document not found: ${op.targetDocumentId}`);
  }

  const prevEventId = await lastEventIdFor(tx, candidate.tenantId, doc.id);
  await tx
    .update(documents)
    .set({ archived: true, status: 'archived', updatedAt: ctx.now })
    .where(eq(documents.id, doc.id))
    .run();

  const eventId = await emitEvent(tx, {
    tenantId: candidate.tenantId,
    documentId: doc.id,
    eventType: 'archived',
    previousVersion: doc.version,
    newVersion: doc.version,
    prevEventId,
    contentSnapshot: doc.content ?? '',
    candidateId: candidate.id,
    actor,
    ctx,
  });

  await finaliseApproved(tx, candidate.id, actor, doc.id, action.id, ctx);
  return {
    candidateId: candidate.id,
    actionId: action.id,
    effect: action.effect,
    documentId: doc.id,
    wikiEventId: eventId,
    autoApproved: ctx.auto,
    status: 'approved',
  };
}

// ── Effect: reject ─────────────────────────────────────────────────

async function executeReject(
  trail: TrailDatabase,
  candidate: QueueCandidate,
  action: CandidateAction,
  payload: ResolveCandidatePayload,
  actor: Actor,
  ctx: CommitContext,
): Promise<ResolutionResult> {
  const reason = payload.reason ?? null;
  await trail.db
    .update(queueCandidates)
    .set({
      status: 'rejected',
      reviewedBy: actor.id,
      reviewedAt: ctx.now,
      rejectionReason: reason,
      resolvedAction: action.id,
    })
    .where(eq(queueCandidates.id, candidate.id))
    .run();

  return {
    candidateId: candidate.id,
    actionId: action.id,
    effect: action.effect,
    documentId: null,
    wikiEventId: null,
    autoApproved: ctx.auto,
    status: 'rejected',
  };
}

// ── Effect: retire-neuron ───────────────────────────────────────────
// Archives a specific Neuron (args.documentId) in response to a
// contradiction alert. The candidate resolves as "approved" — the curator
// accepted the finding — but the downstream state is the target Neuron
// becoming archived, not a new Neuron being created.

async function executeRetireNeuron(
  trail: TrailDatabase,
  candidate: QueueCandidate,
  action: CandidateAction,
  actor: Actor,
  ctx: CommitContext,
): Promise<ResolutionResult> {
  const targetId = asString(action.args?.documentId);
  if (!targetId) {
    throw new Error(`retire-neuron action missing args.documentId on ${candidate.id}`);
  }

  return trail.db.transaction(async (tx) => {
    const doc = await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, targetId),
          eq(documents.tenantId, candidate.tenantId),
          eq(documents.kind, 'wiki'),
        ),
      )
      .get();
    if (!doc) throw new Error(`retire-neuron: target Neuron not found: ${targetId}`);

    const prevEventId = await lastEventIdFor(tx, candidate.tenantId, doc.id);
    await tx
      .update(documents)
      .set({ archived: true, status: 'archived', updatedAt: ctx.now })
      .where(eq(documents.id, doc.id))
      .run();

    const eventId = await emitEvent(tx, {
      tenantId: candidate.tenantId,
      documentId: doc.id,
      eventType: 'archived',
      previousVersion: doc.version,
      newVersion: doc.version,
      prevEventId,
      contentSnapshot: doc.content ?? '',
      candidateId: candidate.id,
      actor,
      ctx,
    });

    await finaliseApproved(tx, candidate.id, actor, doc.id, action.id, ctx);
    return {
      candidateId: candidate.id,
      actionId: action.id,
      effect: action.effect,
      documentId: doc.id,
      wikiEventId: eventId,
      autoApproved: ctx.auto,
      status: 'approved',
    };
  });
}

// ── Effect: flag-source ────────────────────────────────────────────
// Marks a Source document as untrustworthy. Doesn't touch any Neuron;
// the curator has simply told us "this source is the one in the wrong,
// don't trust it for future compiles". Encoded as a metadata flag on the
// Source document.

async function executeFlagSource(
  trail: TrailDatabase,
  candidate: QueueCandidate,
  action: CandidateAction,
  actor: Actor,
  ctx: CommitContext,
): Promise<ResolutionResult> {
  const sourceId = asString(action.args?.sourceDocumentId);
  if (!sourceId) {
    throw new Error(`flag-source action missing args.sourceDocumentId on ${candidate.id}`);
  }
  const note = asString(action.args?.note) ?? '';

  const doc = await trail.db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, sourceId),
        eq(documents.tenantId, candidate.tenantId),
        eq(documents.kind, 'source'),
      ),
    )
    .get();
  if (!doc) throw new Error(`flag-source: source not found: ${sourceId}`);

  // Preserve existing metadata; merge the untrusted flag on top.
  const prev = doc.metadata ? safeParseJson(doc.metadata) : {};
  const merged = {
    ...prev,
    flagged: true,
    flaggedNote: note,
    flaggedBy: actor.id,
    flaggedAt: ctx.now,
  };
  await trail.db
    .update(documents)
    .set({ metadata: JSON.stringify(merged), updatedAt: ctx.now })
    .where(eq(documents.id, doc.id))
    .run();

  await trail.db
    .update(queueCandidates)
    .set({
      status: 'approved',
      reviewedBy: actor.id,
      reviewedAt: ctx.now,
      autoApprovedAt: ctx.auto ? ctx.now : null,
      resolvedAction: action.id,
    })
    .where(eq(queueCandidates.id, candidate.id))
    .run();

  return {
    candidateId: candidate.id,
    actionId: action.id,
    effect: action.effect,
    documentId: null,
    wikiEventId: null,
    autoApproved: ctx.auto,
    status: 'approved',
  };
}

// ── Effect: mark-still-relevant ────────────────────────────────────
// Silences a stale/contradiction warning. Bumps updatedAt on the target
// doc so the stale detector sees it as fresh. The candidate resolves as
// "approved" — the curator accepted the finding — but nothing else
// changes about the Neuron's content.

async function executeMarkStillRelevant(
  trail: TrailDatabase,
  candidate: QueueCandidate,
  action: CandidateAction,
  actor: Actor,
  ctx: CommitContext,
): Promise<ResolutionResult> {
  const targetId = asString(action.args?.documentId);
  if (!targetId) {
    throw new Error(
      `mark-still-relevant action missing args.documentId on ${candidate.id}`,
    );
  }

  await trail.db
    .update(documents)
    .set({ updatedAt: ctx.now })
    .where(
      and(
        eq(documents.id, targetId),
        eq(documents.tenantId, candidate.tenantId),
      ),
    )
    .run();

  await trail.db
    .update(queueCandidates)
    .set({
      status: 'approved',
      reviewedBy: actor.id,
      reviewedAt: ctx.now,
      autoApprovedAt: ctx.auto ? ctx.now : null,
      resolvedAction: action.id,
    })
    .where(eq(queueCandidates.id, candidate.id))
    .run();

  return {
    candidateId: candidate.id,
    actionId: action.id,
    effect: action.effect,
    documentId: targetId,
    wikiEventId: null,
    autoApproved: ctx.auto,
    status: 'approved',
  };
}

// ── Shared helpers ─────────────────────────────────────────────────

async function emitEvent(
  tx: Db,
  args: {
    tenantId: string;
    documentId: string;
    eventType: 'created' | 'edited' | 'archived' | 'renamed' | 'moved' | 'restored';
    previousVersion: number | null;
    newVersion: number;
    prevEventId: string | null;
    contentSnapshot: string;
    candidateId: string;
    actor: Actor;
    ctx: CommitContext;
  },
): Promise<string> {
  const eventId = `evt_${crypto.randomUUID().slice(0, 12)}`;
  await tx
    .insert(wikiEvents)
    .values({
      id: eventId,
      tenantId: args.tenantId,
      documentId: args.documentId,
      eventType: args.eventType,
      actorId: args.actor.kind === 'user' ? args.actor.id : null,
      actorKind: args.actor.kind,
      previousVersion: args.previousVersion,
      newVersion: args.newVersion,
      summary: args.ctx.summary,
      metadata: args.ctx.metadataJson,
      prevEventId: args.prevEventId,
      sourceCandidateId: args.candidateId,
      contentSnapshot: args.contentSnapshot,
    })
    .run();
  return eventId;
}

async function finaliseApproved(
  tx: Db,
  candidateId: string,
  actor: Actor,
  resultingDocumentId: string,
  actionId: string,
  ctx: CommitContext,
): Promise<void> {
  await tx
    .update(queueCandidates)
    .set({
      status: 'approved',
      reviewedBy: actor.id,
      reviewedAt: ctx.now,
      autoApprovedAt: ctx.auto ? ctx.now : null,
      resultingDocumentId,
      resolvedAction: actionId,
    })
    .where(eq(queueCandidates.id, candidateId))
    .run();
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

// ── Read-side API ──────────────────────────────────────────────────

export async function listCandidates(
  trail: TrailDatabase,
  tenantId: string,
  query: ListQueueQuery,
): Promise<QueueCandidate[]> {
  const filters = [eq(queueCandidates.tenantId, tenantId)];
  if (query.knowledgeBaseId) {
    filters.push(eq(queueCandidates.knowledgeBaseId, query.knowledgeBaseId));
  }
  if (query.kind) filters.push(eq(queueCandidates.kind, query.kind));
  if (query.status) filters.push(eq(queueCandidates.status, query.status));

  const rows = await trail.db
    .select()
    .from(queueCandidates)
    .where(and(...filters))
    .orderBy(desc(queueCandidates.createdAt))
    .limit(query.limit)
    .all();
  return rows.map(hydrate);
}

/**
 * Total number of candidates matching the filter, ignoring `limit`. Needed
 * for the admin's pending-count badge and any other consumer that wants the
 * true size independent of paging — using `items.length` on a limited list
 * produces a value clamped to `limit` which is silently wrong.
 */
export async function countCandidates(
  trail: TrailDatabase,
  tenantId: string,
  query: Omit<ListQueueQuery, 'limit' | 'cursor'>,
): Promise<number> {
  const filters = [eq(queueCandidates.tenantId, tenantId)];
  if (query.knowledgeBaseId) {
    filters.push(eq(queueCandidates.knowledgeBaseId, query.knowledgeBaseId));
  }
  if (query.kind) filters.push(eq(queueCandidates.kind, query.kind));
  if (query.status) filters.push(eq(queueCandidates.status, query.status));

  const row = await trail.db
    .select({ n: sql<number>`COUNT(*)`.as('n') })
    .from(queueCandidates)
    .where(and(...filters))
    .get();
  return row?.n ?? 0;
}

export async function getCandidate(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
): Promise<QueueCandidate | null> {
  const row = await trail.db
    .select()
    .from(queueCandidates)
    .where(
      and(
        eq(queueCandidates.id, candidateId),
        eq(queueCandidates.tenantId, tenantId),
      ),
    )
    .get();
  return row ? hydrate(row) : null;
}

/**
 * Flip a rejected candidate back to pending so the curator gets another
 * chance to handle it. Clears the rejection reason + resolvedAction
 * while preserving reviewedBy/reviewedAt for the audit trail (a future
 * review will overwrite them). Throws on "not rejected" to keep the
 * operation honest — callers shouldn't use reopen to un-approve.
 */
export async function reopenCandidate(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
  actor: Actor,
): Promise<{ candidateId: string; previousReason: string | null }> {
  const candidate = await getCandidate(trail, tenantId, candidateId);
  if (!candidate) throw new Error(`Candidate not found: ${candidateId}`);
  if (candidate.status !== 'rejected') {
    throw new Error(
      `Can only reopen rejected candidates (current status=${candidate.status})`,
    );
  }

  const previousReason = candidate.rejectionReason;
  await trail.db
    .update(queueCandidates)
    .set({
      status: 'pending',
      rejectionReason: null,
      resolvedAction: null,
      // Keep reviewedBy/reviewedAt for the audit trail — the next
      // resolution will overwrite them.
    })
    .where(
      and(
        eq(queueCandidates.id, candidateId),
        eq(queueCandidates.tenantId, tenantId),
      ),
    )
    .run();

  // No wiki_event emitted: nothing about the wiki changed, we just
  // walked a decision back. The audit trail lives in the candidate's
  // own columns + the next resolution's event.
  void actor; // reserved for a future audit log on the reopen itself
  return { candidateId, previousReason };
}

/**
 * Persist a title+content translation into the candidate's `translations`
 * JSON column, merged with any existing locales. Called by the
 * translation service after a non-EN view triggers an LLM translation.
 * `content` is optional so producers can translate title-only when the
 * body is mostly user content that should stay verbatim.
 */
export async function persistCandidateTranslation(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
  locale: string,
  fields: { title?: string; content?: string },
): Promise<void> {
  const candidate = await getCandidate(trail, tenantId, candidateId);
  if (!candidate) return;
  const prev = candidate.translations ?? {};
  const existingForLocale = prev[locale] ?? {};
  const next = {
    ...prev,
    [locale]: {
      ...existingForLocale,
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.content !== undefined ? { content: fields.content } : {}),
    },
  };
  await trail.db
    .update(queueCandidates)
    .set({ translations: JSON.stringify(next) })
    .where(
      and(
        eq(queueCandidates.id, candidateId),
        eq(queueCandidates.tenantId, tenantId),
      ),
    )
    .run();
}

/**
 * Persist a translation of a single action's label/explanation back into
 * the candidate's stored `actions` JSON. Used by the translation-service
 * after the first DA (or other locale) view of an EN-native action.
 * No-op if the candidate has no actions or the actionId doesn't match.
 */
export async function persistActionTranslation(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
  actionId: string,
  locale: 'en' | 'da' | (string & {}),
  translated: { label?: string; explanation?: string },
): Promise<void> {
  const candidate = await getCandidate(trail, tenantId, candidateId);
  if (!candidate?.actions) return;
  const next = candidate.actions.map((a) => {
    if (a.id !== actionId) return a;
    return {
      ...a,
      label: translated.label ? { ...a.label, [locale]: translated.label } : a.label,
      explanation: translated.explanation
        ? { ...a.explanation, [locale]: translated.explanation }
        : a.explanation,
    };
  });
  await trail.db
    .update(queueCandidates)
    .set({ actions: JSON.stringify(next) })
    .where(
      and(
        eq(queueCandidates.id, candidateId),
        eq(queueCandidates.tenantId, tenantId),
      ),
    )
    .run();
}
