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
import { slugify } from '../lib/slug.js';
import { shouldAutoApprove } from './policy.js';

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
 * Approve a candidate and commit its content to the wiki.
 *
 * This function is the ONLY allowed write path into `documents` where
 * `kind='wiki'`. Session B wires the MCP write tool to flow through here
 * (via createCandidate + auto-approval) so no code path bypasses the queue.
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

  const content = payload.editedContent ?? candidate.content;
  const rawName = payload.filename ?? slugify(candidate.title) ?? 'untitled';
  const filename = rawName.endsWith('.md') ? rawName : `${rawName}.md`;
  const path = payload.path.endsWith('/') ? payload.path : `${payload.path}/`;
  const now = new Date().toISOString();

  return db.transaction(() => {
    // Create the wiki document. Session B adds the update-in-place branch for
    // `ingest-page-update` and similar kinds that target an existing page.
    const docId = `doc_${crypto.randomUUID().slice(0, 12)}`;
    db.insert(documents)
      .values({
        id: docId,
        tenantId,
        knowledgeBaseId: candidate.knowledgeBaseId,
        userId: actor.kind === 'user' ? actor.id : candidate.createdBy ?? actor.id,
        kind: 'wiki',
        filename,
        title: candidate.title,
        path,
        fileType: 'text/markdown',
        fileSize: content.length,
        content,
        status: 'ready',
        version: 1,
      })
      .run();

    // Emit a replay-able event with the full content snapshot.
    const eventId = `evt_${crypto.randomUUID().slice(0, 12)}`;
    db.insert(wikiEvents)
      .values({
        id: eventId,
        tenantId,
        documentId: docId,
        eventType: 'created',
        actorId: actor.kind === 'user' ? actor.id : null,
        actorKind: actor.kind,
        previousVersion: null,
        newVersion: 1,
        summary: opts.auto
          ? 'auto-approved'
          : payload.notes ?? 'approved by curator',
        metadata: payload.notes
          ? JSON.stringify({ notes: payload.notes })
          : null,
        prevEventId: null,
        sourceCandidateId: candidateId,
        contentSnapshot: content,
      })
      .run();

    db.update(queueCandidates)
      .set({
        status: 'approved',
        reviewedBy: actor.id,
        reviewedAt: now,
        autoApprovedAt: opts.auto ? now : null,
        resultingDocumentId: docId,
      })
      .where(eq(queueCandidates.id, candidateId))
      .run();

    return {
      candidateId,
      documentId: docId,
      wikiEventId: eventId,
      autoApproved: !!opts.auto,
    };
  });
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
