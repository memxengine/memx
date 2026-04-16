import { and, desc, eq } from 'drizzle-orm';
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
  ApproveCandidatePayload,
  RejectCandidatePayload,
  QueueCandidate,
  ListQueueQuery,
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
 * Every wiki mutation goes through `approveCandidate`, which runs the
 * create / update / archive branch inside a single Drizzle transaction
 * and emits a `wiki_events` row with a full content snapshot. Auto-
 * approval (see `shouldAutoApprove`) flips trusted-pipeline candidates
 * through the same path instead of bypassing the queue.
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

export interface ApprovalResult {
  candidateId: string;
  documentId: string;
  wikiEventId: string;
  autoApproved: boolean;
}

export interface RejectionResult {
  candidateId: string;
  reason: string | null;
}

interface CommitContext {
  now: string;
  auto: boolean;
  summary: string;
  metadataJson: string | null;
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

// ── Public API ─────────────────────────────────────────────────────

/** Enqueue a candidate. Runs the auto-approval policy inline; stays pending otherwise. */
export async function createCandidate(
  trail: TrailDatabase,
  tenantId: string,
  input: CreateQueueCandidate,
  actor: Actor,
): Promise<{ candidate: QueueCandidate; approval?: ApprovalResult }> {
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
    })
    .run();

  const candidate = (await db
    .select()
    .from(queueCandidates)
    .where(eq(queueCandidates.id, id))
    .get()) as QueueCandidate;

  if (shouldAutoApprove(candidate)) {
    const approval = await approveCandidate(
      trail,
      tenantId,
      id,
      actor,
      { path: '/neurons/auto/' },
      { auto: true },
    );
    return { candidate, approval };
  }

  return { candidate };
}

/**
 * Approve a candidate and commit its change to the wiki.
 *
 * Dispatches on `candidate.metadata.op`:
 *   - create   → insert a new wiki page
 *   - update   → replace content, bump version
 *   - archive  → soft-delete
 *
 * Every branch runs inside the same Drizzle transaction and emits a
 * replay-able `wiki_events` row with a full content snapshot and a
 * `source_candidate_id` back-pointer.
 */
export async function approveCandidate(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
  actor: Actor,
  payload: ApproveCandidatePayload,
  opts: { auto?: boolean } = {},
): Promise<ApprovalResult> {
  const { db } = trail;

  const candidate = await db
    .select()
    .from(queueCandidates)
    .where(
      and(
        eq(queueCandidates.id, candidateId),
        eq(queueCandidates.tenantId, tenantId),
      ),
    )
    .get();
  if (!candidate) throw new Error(`Candidate not found: ${candidateId}`);
  if (candidate.status !== 'pending') {
    throw new Error(
      `Candidate is not pending (current status=${candidate.status})`,
    );
  }

  const op = parseOp(candidate);
  const ctx: CommitContext = {
    now: new Date().toISOString(),
    auto: !!opts.auto,
    summary: opts.auto ? 'auto-approved' : payload.notes ?? 'approved by curator',
    metadataJson: payload.notes ? JSON.stringify({ notes: payload.notes }) : null,
  };

  return db.transaction(async (tx) => {
    if (op.op === 'update') return approveUpdate(tx, candidate, op, payload, actor, ctx);
    if (op.op === 'archive') return approveArchive(tx, candidate, op, actor, ctx);
    return approveCreate(tx, candidate, op, payload, actor, ctx);
  });
}

async function approveCreate(
  tx: Db,
  candidate: QueueCandidate,
  op: CandidateOp,
  payload: ApproveCandidatePayload,
  actor: Actor,
  ctx: CommitContext,
): Promise<ApprovalResult> {
  const content = payload.editedContent ?? candidate.content;
  const rawName =
    payload.filename ?? op.filename ?? slugify(candidate.title) ?? 'untitled';
  const filename = rawName.endsWith('.md') ? rawName : `${rawName}.md`;
  const pathIn = payload.filename ? payload.path : op.path ?? payload.path;
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

  await finaliseCandidate(tx, candidate.id, actor, docId, ctx);
  return { candidateId: candidate.id, documentId: docId, wikiEventId: eventId, autoApproved: ctx.auto };
}

async function approveUpdate(
  tx: Db,
  candidate: QueueCandidate,
  op: CandidateOp,
  payload: ApproveCandidatePayload,
  actor: Actor,
  ctx: CommitContext,
): Promise<ApprovalResult> {
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

  await finaliseCandidate(tx, candidate.id, actor, doc.id, ctx);
  return { candidateId: candidate.id, documentId: doc.id, wikiEventId: eventId, autoApproved: ctx.auto };
}

async function approveArchive(
  tx: Db,
  candidate: QueueCandidate,
  op: CandidateOp,
  actor: Actor,
  ctx: CommitContext,
): Promise<ApprovalResult> {
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

  await finaliseCandidate(tx, candidate.id, actor, doc.id, ctx);
  return { candidateId: candidate.id, documentId: doc.id, wikiEventId: eventId, autoApproved: ctx.auto };
}

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

async function finaliseCandidate(
  tx: Db,
  candidateId: string,
  actor: Actor,
  resultingDocumentId: string,
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
    })
    .where(eq(queueCandidates.id, candidateId))
    .run();
}

export async function rejectCandidate(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
  actor: Actor,
  payload: RejectCandidatePayload,
): Promise<RejectionResult> {
  const { db } = trail;

  const candidate = await db
    .select()
    .from(queueCandidates)
    .where(
      and(
        eq(queueCandidates.id, candidateId),
        eq(queueCandidates.tenantId, tenantId),
      ),
    )
    .get();
  if (!candidate) throw new Error(`Candidate not found: ${candidateId}`);
  if (candidate.status !== 'pending') {
    throw new Error(
      `Candidate is not pending (current status=${candidate.status})`,
    );
  }

  const reason = payload.reason ?? null;
  await db
    .update(queueCandidates)
    .set({
      status: 'rejected',
      reviewedBy: actor.id,
      reviewedAt: new Date().toISOString(),
      rejectionReason: reason,
    })
    .where(eq(queueCandidates.id, candidateId))
    .run();

  return { candidateId, reason };
}

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

  return (await trail.db
    .select()
    .from(queueCandidates)
    .where(and(...filters))
    .orderBy(desc(queueCandidates.createdAt))
    .limit(query.limit)
    .all()) as QueueCandidate[];
}

export async function getCandidate(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
): Promise<QueueCandidate | null> {
  return (
    ((await trail.db
      .select()
      .from(queueCandidates)
      .where(
        and(
          eq(queueCandidates.id, candidateId),
          eq(queueCandidates.tenantId, tenantId),
        ),
      )
      .get()) as QueueCandidate | undefined) ?? null
  );
}
