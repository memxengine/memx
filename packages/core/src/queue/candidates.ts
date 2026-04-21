import { and, desc, eq, or, like, sql, type SQL } from 'drizzle-orm';
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
  /** F91: new title for an `update` op. Absent = keep existing. */
  title?: string;
  /**
   * F91: optimistic-concurrency token. When present on an `update`, the
   * approve path rejects with `VersionConflictError` if the target doc's
   * current version has moved past this value since the editor loaded.
   */
  expectedVersion?: number;
  /**
   * F138 — target document kind. Defaults to 'wiki' for every
   * pre-F138 candidate + any candidate that doesn't explicitly opt into
   * the Work layer. When set to 'work', `approveCreate` writes
   * `kind='work'` and copies the work_* fields from the op into the
   * documents row so the Work panel can render status / assignee / due
   * date without a separate table. `approveUpdate` and `approveArchive`
   * match on kind IN ('wiki', 'work') so Work items can flow through the
   * same edit + archive paths as Neurons.
   */
  docKind?: 'wiki' | 'work';
  workStatus?: 'open' | 'in-progress' | 'done' | 'blocked';
  workAssignee?: string | null;
  workDueAt?: string | null;
  workKind?: 'task' | 'bug' | 'milestone' | 'decision';
}

/**
 * Thrown by `approveUpdate` when the `expectedVersion` guard fails.
 * The route layer catches this and returns HTTP 409 so the client can
 * prompt the curator to reload. Keeping a distinct class lets callers
 * discriminate without string-matching on message text.
 */
export class VersionConflictError extends Error {
  readonly code = 'version_conflict' as const;
  readonly currentVersion: number;
  readonly expectedVersion: number;
  constructor(currentVersion: number, expectedVersion: number) {
    super(
      `Version conflict: expected ${expectedVersion}, got ${currentVersion}. ` +
        `The Neuron was edited since you opened it.`,
    );
    this.name = 'VersionConflictError';
    this.currentVersion = currentVersion;
    this.expectedVersion = expectedVersion;
  }
}

/**
 * Thrown when an `external-feed` producer fires `op:"create"` against a
 * (path, filename) that already has a live Neuron. Defense against
 * misbehaving upstreams (e.g. a hook that fires session-end on every
 * turn-end). HTTP layer maps this to 409 Conflict so the caller can
 * learn to either send op:"update" or drop the idempotent write.
 */
export class DuplicateExternalFeedError extends Error {
  readonly code = 'duplicate_external_feed' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateExternalFeedError';
  }
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

/**
 * Lift just the fields needed for the external-feed dedup guard out of
 * the stringified metadata blob. Tolerates missing / malformed JSON —
 * returns null and lets the caller fall through to the normal create
 * path (defensive: don't block legit writes on metadata shape quirks).
 */
function parseMetadataForDedup(raw: string | null | undefined): {
  op?: string;
  path?: string;
  filename?: string;
  docKind?: string;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      op?: unknown;
      path?: unknown;
      filename?: unknown;
      docKind?: unknown;
    };
    return {
      op: typeof parsed.op === 'string' ? parsed.op : undefined,
      path: typeof parsed.path === 'string' ? parsed.path : undefined,
      filename: typeof parsed.filename === 'string' ? parsed.filename : undefined,
      docKind: typeof parsed.docKind === 'string' ? parsed.docKind : undefined,
    };
  } catch {
    return null;
  }
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

  // Dedup guard for external-feed create spam. A misbehaving external
  // producer (e.g. buddy firing session-end on every turn-end) would
  // otherwise blindly stack 1000s of Neurons with identical (path,
  // filename) because nothing in the wiki write path enforces
  // uniqueness. Reject up-front with a typed error so the HTTP layer
  // can respond 409 and the producer can learn to stop (or switch to
  // op:"update"). Scoped to external-feed + op:"create" — other kinds
  // are either auto-deduped (lint fingerprint) or user-driven.
  if (input.kind === 'external-feed') {
    const meta = parseMetadataForDedup(input.metadata);
    if (meta && meta.op === 'create' && meta.filename) {
      const targetKind = meta.docKind === 'work' ? 'work' : 'wiki';
      const existing = await db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.knowledgeBaseId, input.knowledgeBaseId),
            eq(documents.tenantId, tenantId),
            eq(documents.kind, targetKind),
            eq(documents.archived, false),
            eq(documents.path, meta.path ?? '/'),
            eq(documents.filename, meta.filename),
          ),
        )
        .get();
      if (existing) {
        throw new DuplicateExternalFeedError(
          `Neuron already exists at ${meta.path ?? '/'}${meta.filename} — send op:"update" to modify, or drop this write if it's idempotent`,
        );
      }
    }
  }

  const id = `cnd_${crypto.randomUUID().slice(0, 12)}`;
  // Every candidate carries `metadata.connector` so the Queue filter
  // and Neuron attribution panel know which ingestion pathway emitted
  // it. Callers that know the connector set it explicitly in
  // input.metadata; those that don't get a best-effort inference from
  // kind + existing metadata hints.
  const stampedMetadata = stampConnector(input.metadata, input.kind);
  await db
    .insert(queueCandidates)
    .values({
      id,
      tenantId,
      knowledgeBaseId: input.knowledgeBaseId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      metadata: stampedMetadata,
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
 * F91 — curator-initiated Neuron edit.
 *
 * The Neuron editor needs a "save" operation that writes immediately but
 * still flows through the queue so F17's "sole write path" invariant
 * holds. The naive fix — making `'user-correction'` a TRUSTED_KIND in
 * F19 — doesn't work: `shouldAutoApprove` short-circuits on
 * `candidate.createdBy`, deliberately, to keep the `createdBy` /
 * `autoApprovedAt` audit semantics clean.
 *
 * So instead we sit *beside* the policy: one tx inserts a
 * `'user-correction'` candidate with `createdBy = actor.id`, then
 * dispatches straight to `approveUpdate`. That's exactly what a human
 * queue click does — just without the UI round-trip. `autoApprovedAt`
 * stays `null` (this wasn't auto), `reviewedBy = actor.id` (the curator
 * *did* approve their own submission).
 *
 * Concurrency: the `expectedVersion` the caller supplies flows through
 * `op.expectedVersion` into `approveUpdate`, which throws
 * `VersionConflictError` if the target doc has moved on. The route
 * layer maps that to HTTP 409.
 */
export async function submitCuratorEdit(
  trail: TrailDatabase,
  tenantId: string,
  docId: string,
  input: {
    title?: string;
    content: string;
    tags?: string | null;
    expectedVersion: number;
  },
  actor: Actor,
): Promise<ResolutionResult> {
  if (actor.kind !== 'user') {
    throw new Error('submitCuratorEdit requires a user actor');
  }

  const doc = await trail.db
    .select({
      id: documents.id,
      knowledgeBaseId: documents.knowledgeBaseId,
      title: documents.title,
    })
    .from(documents)
    .where(
      and(
        eq(documents.id, docId),
        eq(documents.tenantId, tenantId),
        or(eq(documents.kind, 'wiki'), eq(documents.kind, 'work')),
      ),
    )
    .get();
  if (!doc) throw new Error(`Target wiki document not found: ${docId}`);

  const candidateId = `cnd_${crypto.randomUUID().slice(0, 12)}`;
  const op: CandidateOp = {
    op: 'update',
    targetDocumentId: docId,
    expectedVersion: input.expectedVersion,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
  };
  // Curator-edit path bypasses createCandidate (writes straight to the
  // queue inside a transaction) so stampConnector isn't applied — set
  // connector explicitly in the metadata JSON.
  const metadata = JSON.stringify({ ...op, connector: 'curator' });
  const candidateTitle = input.title ?? doc.title ?? docId;
  const now = new Date().toISOString();

  return trail.db.transaction(async (tx) => {
    await tx
      .insert(queueCandidates)
      .values({
        id: candidateId,
        tenantId,
        knowledgeBaseId: doc.knowledgeBaseId,
        kind: 'user-correction',
        title: candidateTitle,
        content: input.content,
        metadata,
        confidence: 1,
        impactEstimate: null,
        status: 'pending',
        createdBy: actor.id,
        actions: null,
      })
      .run();

    const candidate = hydrate(
      await tx
        .select()
        .from(queueCandidates)
        .where(eq(queueCandidates.id, candidateId))
        .get(),
    );

    const ctx: CommitContext = {
      now,
      auto: false,
      summary: `curator edit by ${actor.id}`,
      metadataJson: null,
    };

    const approveAction: CandidateAction = {
      id: 'approve',
      effect: 'approve',
      label: { en: 'Approve' },
      explanation: { en: 'Curator-approved edit via Neuron editor.' },
    };

    return approveUpdate(
      tx,
      candidate,
      op,
      { actionId: 'approve' },
      approveAction,
      actor,
      ctx,
    );
  });
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
    case 'auto-link-sources':
      return executeAutoLinkSources(trail, candidate, action, payload, actor, ctx);
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
  const docKind = op.docKind ?? 'wiki';
  await tx
    .insert(documents)
    .values({
      id: docId,
      tenantId: candidate.tenantId,
      knowledgeBaseId: candidate.knowledgeBaseId,
      userId: actor.kind === 'user' ? actor.id : candidate.createdBy ?? actor.id,
      kind: docKind,
      filename,
      title: candidate.title,
      path,
      fileType: 'md',
      fileSize: content.length,
      content,
      tags: op.tags ?? null,
      status: 'ready',
      version: 1,
      // F145 — atomic per-KB seq assignment. Computed inline so two
      // concurrent inserts in the same KB can't read the same MAX and
      // then race past the UNIQUE constraint. SQLite serialises writes,
      // so this subquery sees the latest committed seq for the KB.
      seq: sql<number>`COALESCE((SELECT MAX(${documents.seq}) FROM ${documents} WHERE ${documents.knowledgeBaseId} = ${candidate.knowledgeBaseId}), 0) + 1`,
      ...(docKind === 'work'
        ? {
            workStatus: op.workStatus ?? 'open',
            workAssignee: op.workAssignee ?? null,
            workDueAt: op.workDueAt ?? null,
            workKind: op.workKind ?? 'task',
          }
        : {}),
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
        or(eq(documents.kind, 'wiki'), eq(documents.kind, 'work')),
      ),
    )
    .get();
  if (!doc) {
    throw new Error(`Target wiki document not found: ${op.targetDocumentId}`);
  }

  // F91 — optimistic concurrency. When a curator-initiated edit carries
  // the doc.version it was loaded at, reject if the row has moved on.
  // Inside the tx so the check and the subsequent UPDATE are atomic under
  // SQLite's write lock.
  if (op.expectedVersion !== undefined && doc.version !== op.expectedVersion) {
    throw new VersionConflictError(doc.version, op.expectedVersion);
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
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.tags !== undefined ? { tags: op.tags } : {}),
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
        or(eq(documents.kind, 'wiki'), eq(documents.kind, 'work')),
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
    // Despite the action name, the `retire-neuron` effect is reused by
    // orphan-lint's `archive-source` action (see lint/orphans.ts:282) — so
    // we can't filter on kind='wiki' or bulk-accept on orphan Sources
    // blows up with "target Neuron not found" even though the Source
    // exists. Archive is a reversible, kind-agnostic op, so accepting any
    // document kind is safe.
    const doc = await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, targetId),
          eq(documents.tenantId, candidate.tenantId),
        ),
      )
      .get();
    if (!doc) throw new Error(`retire-neuron: target document not found: ${targetId}`);

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

// ── Effect: auto-link-sources ──────────────────────────────────────
// Orphan-Neuron recovery. The server route pre-computes which Source
// filenames the Neuron's claims most likely came from (via an LLM pass
// over the Neuron content + the KB's Source list) and injects them into
// `action.args.sources`. This handler's job is pure DB: patch the
// Neuron's frontmatter to add `sources: [...]`, bump version, emit a
// wiki_event, and mark the candidate approved. The reference-extractor
// subscribes to candidate_approved and writes the document_references
// rows on the fly, so the next lint pass no longer sees the Neuron as
// an orphan.
//
// Guards:
//   - args.documentId must resolve to a wiki Neuron in the same tenant.
//   - args.sources must be a non-empty string array. Empty means the
//     inferer couldn't find any plausible Sources — throwing here is
//     deliberate so the UI can surface "couldn't auto-link" and the
//     candidate stays pending for manual handling.

async function executeAutoLinkSources(
  trail: TrailDatabase,
  candidate: QueueCandidate,
  action: CandidateAction,
  payload: ResolveCandidatePayload,
  actor: Actor,
  ctx: CommitContext,
): Promise<ResolutionResult> {
  // documentId is design-time — stamped on the candidate's action when
  // the lint finding was emitted — so we read it from the stored action.
  // sources is runtime — the server route runs the LLM inferer and
  // injects the proposed filenames into payload.args before calling
  // resolveCandidate. Reading from payload keeps the stored action
  // immutable while still letting the effect mutate the target doc.
  const targetId = asString(action.args?.documentId);
  if (!targetId) {
    throw new Error(`auto-link-sources action missing args.documentId on ${candidate.id}`);
  }
  const sources = asStringArray(payload.args?.sources);
  if (!sources || sources.length === 0) {
    throw new Error(
      `auto-link-sources action on ${candidate.id} has no payload.args.sources — server must populate this via the inferer before calling resolveCandidate`,
    );
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
    if (!doc) throw new Error(`auto-link-sources: target Neuron not found: ${targetId}`);

    const patched = addSourcesToFrontmatter(doc.content ?? '', sources);
    if (patched === doc.content) {
      // Every inferred source already present — nothing to write. Still
      // resolve the candidate so the orphan-finding doesn't nag on next
      // lint pass; the reference-extractor's next pass will pick up the
      // existing frontmatter.
      await finaliseApproved(tx, candidate.id, actor, doc.id, action.id, ctx);
      return {
        candidateId: candidate.id,
        actionId: action.id,
        effect: action.effect,
        documentId: doc.id,
        wikiEventId: null,
        autoApproved: ctx.auto,
        status: 'approved',
      };
    }

    const newVersion = doc.version + 1;
    const prevEventId = await lastEventIdFor(tx, candidate.tenantId, doc.id);

    await tx
      .update(documents)
      .set({
        content: patched,
        fileSize: patched.length,
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
      contentSnapshot: patched,
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

/**
 * Add a `sources: [...]` line to a Neuron's YAML frontmatter. Merges
 * with an existing `sources` field if present (dedup, preserve order).
 * Creates a frontmatter block if the Neuron has none at all. Exported
 * for tests.
 */
export function addSourcesToFrontmatter(content: string, newSources: string[]): string {
  const cleaned = newSources.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return content;

  const fmMatch = content.match(/^(---\s*\n)([\s\S]*?)(\n---\s*(?:\r?\n|$))/);
  if (!fmMatch) {
    const yaml = `sources: [${cleaned.map((s) => JSON.stringify(s)).join(', ')}]`;
    return `---\n${yaml}\n---\n\n${content}`;
  }

  const [whole, openRaw, bodyRaw, closeRaw] = fmMatch;
  const open = openRaw!;
  const body = bodyRaw!;
  const close = closeRaw!;
  const rest = content.slice(whole.length);

  // Existing single-line sources: sources: ["A.pdf", "B.pdf"]
  const oneLine = body.match(/^sources:\s*\[(.*?)\]\s*$/m);
  if (oneLine) {
    const existing = oneLine[1]!
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    const merged = dedupStable([...existing, ...cleaned]);
    const newLine = `sources: [${merged.map((s) => JSON.stringify(s)).join(', ')}]`;
    const newBody = body.replace(oneLine[0], newLine);
    return open + newBody + close + rest;
  }

  // Existing multi-line block:
  //   sources:
  //     - "A.pdf"
  //     - B.pdf
  const block = body.match(/^sources:\s*\n((?:\s+-\s+.+(?:\r?\n|$))+)/m);
  if (block) {
    const existing = block[1]!
      .split('\n')
      .map((line) => line.match(/^\s+-\s+(.+)$/)?.[1])
      .filter((s): s is string => !!s)
      .map((s) => s.trim().replace(/^["']|["']$/g, ''));
    const merged = dedupStable([...existing, ...cleaned]);
    const newLine = `sources: [${merged.map((s) => JSON.stringify(s)).join(', ')}]`;
    const newBody = body.replace(block[0].replace(/\n$/, ''), newLine);
    return open + newBody + close + rest;
  }

  // No sources field — append one to the frontmatter.
  const yaml = `sources: [${cleaned.map((s) => JSON.stringify(s)).join(', ')}]`;
  const newBody = body.replace(/\s*$/, '') + '\n' + yaml;
  return open + newBody + close + rest;
}

function dedupStable(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out.length > 0 ? out : null;
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

/**
 * Ensure `metadata.connector` is populated on every candidate. When the
 * caller already supplied one we respect it — that's the explicit-is-
 * better-than-implicit path (Chat, buddy, MCP, lint). When missing we
 * infer from `kind` so legacy callers + old clients still flow into a
 * sensible bucket rather than showing up unattributed.
 *
 * Returns the metadata serialised back as JSON (or null if input was
 * null and we couldn't infer anything, which is rare since every kind
 * has a fallback).
 */
function stampConnector(
  rawMetadata: string | null | undefined,
  kind: CreateQueueCandidate['kind'],
): string | null {
  const parsed = rawMetadata ? safeParseJson(rawMetadata) : {};
  if (typeof parsed.connector === 'string' && parsed.connector.length > 0) {
    // Already set by caller — keep it (covers explicit chat/buddy/curator/MCP).
    return rawMetadata ?? null;
  }
  parsed.connector = inferConnectorFromKind(kind, parsed);
  return JSON.stringify(parsed);
}

function inferConnectorFromKind(
  kind: CreateQueueCandidate['kind'],
  hints: Record<string, unknown>,
): string {
  // `external-feed` carries a legacy `source` hint from F39's buddy path.
  if (kind === 'external-feed') {
    const src = typeof hints.source === 'string' ? hints.source : null;
    if (src === 'buddy') return 'buddy';
    return 'api';
  }
  if (kind === 'chat-answer') return 'chat';
  if (kind === 'user-correction') return 'curator';
  if (kind === 'ingest-summary' || kind === 'ingest-page-update') return 'upload';
  if (kind === 'cross-ref-suggestion' || kind === 'contradiction-alert' || kind === 'gap-detection' || kind === 'reader-feedback') return 'lint';
  if (kind === 'source-retraction' || kind === 'scheduled-recompile' || kind === 'version-conflict') return 'pipeline';
  return 'api';
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
  const connectorFilter = connectorFilterClause(query.connector);
  if (connectorFilter) filters.push(connectorFilter);

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
 * Build a WHERE clause matching connectors inside the metadata JSON
 * blob. Accepts a comma-separated string (`"upload,buddy"`) and OR's
 * them. No-op (returns null) when the filter is missing or empty so
 * callers can push-if-present without branching.
 *
 * Uses `metadata LIKE '%"connector":"X"%'` — cheap, no JSON1 extension
 * dependency. Each value is shape-checked in the shared layer before
 * reaching SQL, so injection via the connector field is not possible:
 * we explicitly strip quotes and backslashes before interpolating.
 */
function connectorFilterClause(raw: string | undefined): SQL | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/["'\\]/g, ''));
  if (ids.length === 0) return null;
  const clauses = ids.map((id) =>
    like(queueCandidates.metadata, `%"connector":"${id}"%`),
  );
  if (clauses.length === 1) return clauses[0]!;
  return or(...clauses) ?? null;
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
  const connectorFilter = connectorFilterClause(query.connector);
  if (connectorFilter) filters.push(connectorFilter);

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
  // Status guard inside the UPDATE WHERE so two concurrent reopens can't
  // both "succeed" — whichever request lands first flips rejected→pending,
  // the second finds zero matching rows and throws. The read-then-write
  // pattern above is racy on its own; this is the atomic check-and-set.
  const result = await trail.db
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
        eq(queueCandidates.status, 'rejected'),
      ),
    )
    .run();

  // libSQL driver returns rowsAffected on the run() result. Zero means
  // another request beat us here — treat that the same as the up-front
  // "not rejected" check.
  if ((result as { rowsAffected?: number }).rowsAffected === 0) {
    throw new Error(
      `Candidate ${candidateId} was no longer rejected when reopen reached the database`,
    );
  }

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
  // Wrapped in a transaction so the read-modify-write sequence is
  // isolated: two parallel translate-views for different locales on
  // the same candidate can't clobber each other's cache entry. The
  // per-process inFlight cache in translation.ts prevents most
  // parallel duplicates inside a single engine process, but multi-
  // process setups (future horizontal scaling) would race without
  // this. Acquire the row inside the tx so SQLite's write-lock
  // serializes concurrent persisters on the same candidate id.
  await trail.db.transaction(async (tx) => {
    const row = await tx
      .select({ translations: queueCandidates.translations })
      .from(queueCandidates)
      .where(
        and(
          eq(queueCandidates.id, candidateId),
          eq(queueCandidates.tenantId, tenantId),
        ),
      )
      .get();
    if (!row) return;
    const prev =
      (typeof row.translations === 'string'
        ? safeParseTranslations(row.translations)
        : (row.translations as QueueCandidate['translations'])) ?? {};
    const existingForLocale = prev[locale] ?? {};
    const next = {
      ...prev,
      [locale]: {
        ...existingForLocale,
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.content !== undefined ? { content: fields.content } : {}),
      },
    };
    await tx
      .update(queueCandidates)
      .set({ translations: JSON.stringify(next) })
      .where(
        and(
          eq(queueCandidates.id, candidateId),
          eq(queueCandidates.tenantId, tenantId),
        ),
      )
      .run();
  });
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
  // Same rationale as persistCandidateTranslation: wrap the read-
  // modify-write in a transaction so parallel persisters on the same
  // candidate+action can't lose each other's updates. The candidate
  // actions array is stored as a single JSON blob; without isolation
  // two concurrent writers would both read, both compute, second
  // wins silently.
  await trail.db.transaction(async (tx) => {
    const row = await tx
      .select({ actions: queueCandidates.actions })
      .from(queueCandidates)
      .where(
        and(
          eq(queueCandidates.id, candidateId),
          eq(queueCandidates.tenantId, tenantId),
        ),
      )
      .get();
    if (!row) return;
    const parsed =
      typeof row.actions === 'string'
        ? safeParseActions(row.actions)
        : (row.actions as CandidateAction[] | null);
    if (!parsed) return;
    const next = parsed.map((a) => {
      if (a.id !== actionId) return a;
      return {
        ...a,
        label: translated.label ? { ...a.label, [locale]: translated.label } : a.label,
        explanation: translated.explanation
          ? { ...a.explanation, [locale]: translated.explanation }
          : a.explanation,
      };
    });
    await tx
      .update(queueCandidates)
      .set({ actions: JSON.stringify(next) })
      .where(
        and(
          eq(queueCandidates.id, candidateId),
          eq(queueCandidates.tenantId, tenantId),
        ),
      )
      .run();
  });
}
