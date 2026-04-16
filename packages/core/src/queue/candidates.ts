import { and, desc, eq } from 'drizzle-orm';
import {
  db,
  queueCandidates,
  documents,
  wikiEvents,
  knowledgeBases,
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
 * Per-candidate operation descriptor, serialised into `candidate.metadata` JSON.
 *
 * `op: "create"`  — create a new wiki page (filename + path required).
 * `op: "update"`  — replace the full content of an existing wiki page
 *                   (targetDocumentId required, candidate.content IS the new
 *                   content). str_replace / append compute the full content
 *                   client-side and hand it to the queue as an update candidate.
 * `op: "archive"` — soft-delete an existing wiki page (targetDocumentId only).
 */
export interface CandidateOp {
  op: 'create' | 'update' | 'archive';
  targetDocumentId?: string;
  filename?: string;
  path?: string;
  tags?: string | null;
}

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

function lastEventIdFor(tenantId: string, documentId: string): string | null {
  const row = db
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
 * F17 Curation Queue — the sole write path to wiki documents.
 *
 * Session A scope (this file): schemas, approveCandidate (create-new-page path),
 * rejectCandidate, and list/get helpers. HTTP routes live in routes/queue.ts.
 *
 * Session B (next): refactor apps/mcp/src/index.ts's four wiki-write call sites
 * to emit candidates instead of mutating documents directly. That's what
 * enforces the "sole write path" invariant across the whole engine.
 */

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

/** Enqueue a candidate. Runs auto-approval policy inline; pending otherwise. */
export function createCandidate(
  tenantId: string,
  input: CreateQueueCandidate,
  actor: Actor,
): { candidate: QueueCandidate; approval?: ApprovalResult } {
  const kb = db
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
  db.insert(queueCandidates)
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

  const candidate = db
    .select()
    .from(queueCandidates)
    .where(eq(queueCandidates.id, id))
    .get() as QueueCandidate;

  if (shouldAutoApprove(candidate)) {
    const approval = approveCandidate(
      tenantId,
      id,
      actor,
      { path: '/wiki/auto/' },
      { auto: true },
    );
    return { candidate, approval };
  }

  return { candidate };
}

/**
 * Approve a candidate and commit its change to the wiki.
 *
 * This function is the ONLY allowed write path into `documents` where
 * `kind='wiki'`. Dispatches on `candidate.metadata.op`:
 *   - create   → insert a new wiki page
 *   - update   → replace the content of an existing page, bump version
 *   - archive  → soft-delete an existing page
 *
 * Every branch emits a replay-able `wiki_events` row with a full content
 * snapshot and a `source_candidate_id` back-pointer. The candidate flips to
 * `approved` inside the same transaction.
 */
export function approveCandidate(
  tenantId: string,
  candidateId: string,
  actor: Actor,
  payload: ApproveCandidatePayload,
  opts: { auto?: boolean } = {},
): ApprovalResult {
  const candidate = db
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
  const now = new Date().toISOString();
  const summary = opts.auto
    ? 'auto-approved'
    : payload.notes ?? 'approved by curator';
  const metadataJson = payload.notes
    ? JSON.stringify({ notes: payload.notes })
    : null;

  return db.transaction(() => {
    if (op.op === 'update') {
      return approveUpdate(candidate, op, payload, actor, {
        now,
        auto: !!opts.auto,
        summary,
        metadataJson,
      });
    }
    if (op.op === 'archive') {
      return approveArchive(candidate, op, actor, {
        now,
        auto: !!opts.auto,
        summary,
        metadataJson,
      });
    }
    return approveCreate(candidate, op, payload, actor, {
      now,
      auto: !!opts.auto,
      summary,
      metadataJson,
    });
  });
}

interface CommitContext {
  now: string;
  auto: boolean;
  summary: string;
  metadataJson: string | null;
}

function approveCreate(
  candidate: QueueCandidate,
  op: CandidateOp,
  payload: ApproveCandidatePayload,
  actor: Actor,
  ctx: CommitContext,
): ApprovalResult {
  const content = payload.editedContent ?? candidate.content;
  const rawName =
    payload.filename ??
    op.filename ??
    slugify(candidate.title) ??
    'untitled';
  const filename = rawName.endsWith('.md') ? rawName : `${rawName}.md`;
  const pathIn = payload.filename ? payload.path : op.path ?? payload.path;
  const path = pathIn.endsWith('/') ? pathIn : `${pathIn}/`;

  const docId = `doc_${crypto.randomUUID().slice(0, 12)}`;
  db.insert(documents)
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

  const eventId = emitEvent({
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

  finaliseCandidate(candidate.id, actor, docId, ctx);
  return { candidateId: candidate.id, documentId: docId, wikiEventId: eventId, autoApproved: ctx.auto };
}

function approveUpdate(
  candidate: QueueCandidate,
  op: CandidateOp,
  payload: ApproveCandidatePayload,
  actor: Actor,
  ctx: CommitContext,
): ApprovalResult {
  if (!op.targetDocumentId) {
    throw new Error('update candidate missing metadata.targetDocumentId');
  }
  const doc = db
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
    throw new Error(
      `Target wiki document not found: ${op.targetDocumentId}`,
    );
  }

  const content = payload.editedContent ?? candidate.content;
  const newVersion = doc.version + 1;
  const prevEventId = lastEventIdFor(candidate.tenantId, doc.id);

  db.update(documents)
    .set({
      content,
      fileSize: content.length,
      version: newVersion,
      updatedAt: ctx.now,
    })
    .where(eq(documents.id, doc.id))
    .run();

  const eventId = emitEvent({
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

  finaliseCandidate(candidate.id, actor, doc.id, ctx);
  return { candidateId: candidate.id, documentId: doc.id, wikiEventId: eventId, autoApproved: ctx.auto };
}

function approveArchive(
  candidate: QueueCandidate,
  op: CandidateOp,
  actor: Actor,
  ctx: CommitContext,
): ApprovalResult {
  if (!op.targetDocumentId) {
    throw new Error('archive candidate missing metadata.targetDocumentId');
  }
  const doc = db
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
    throw new Error(
      `Target wiki document not found: ${op.targetDocumentId}`,
    );
  }

  const prevEventId = lastEventIdFor(candidate.tenantId, doc.id);
  db.update(documents)
    .set({ archived: true, status: 'archived', updatedAt: ctx.now })
    .where(eq(documents.id, doc.id))
    .run();

  const eventId = emitEvent({
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

  finaliseCandidate(candidate.id, actor, doc.id, ctx);
  return { candidateId: candidate.id, documentId: doc.id, wikiEventId: eventId, autoApproved: ctx.auto };
}

function emitEvent(args: {
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
}): string {
  const eventId = `evt_${crypto.randomUUID().slice(0, 12)}`;
  db.insert(wikiEvents)
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

function finaliseCandidate(
  candidateId: string,
  actor: Actor,
  resultingDocumentId: string,
  ctx: CommitContext,
): void {
  db.update(queueCandidates)
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

export function rejectCandidate(
  tenantId: string,
  candidateId: string,
  actor: Actor,
  payload: RejectCandidatePayload,
): RejectionResult {
  const candidate = db
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
  db.update(queueCandidates)
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

export function listCandidates(
  tenantId: string,
  query: ListQueueQuery,
): QueueCandidate[] {
  const filters = [eq(queueCandidates.tenantId, tenantId)];
  if (query.knowledgeBaseId)
    filters.push(eq(queueCandidates.knowledgeBaseId, query.knowledgeBaseId));
  if (query.kind) filters.push(eq(queueCandidates.kind, query.kind));
  if (query.status) filters.push(eq(queueCandidates.status, query.status));
  return db
    .select()
    .from(queueCandidates)
    .where(and(...filters))
    .orderBy(desc(queueCandidates.createdAt))
    .limit(query.limit)
    .all() as QueueCandidate[];
}

export function getCandidate(
  tenantId: string,
  candidateId: string,
): QueueCandidate | null {
  return (db
    .select()
    .from(queueCandidates)
    .where(
      and(
        eq(queueCandidates.id, candidateId),
        eq(queueCandidates.tenantId, tenantId),
      ),
    )
    .get() ?? null) as QueueCandidate | null;
}
