/**
 * F87 — Event stream catalog.
 *
 * Every state change that a consumer might want to react to is emitted as
 * a typed event over the `GET /api/v1/stream` SSE endpoint (and, in a
 * later iteration, as outgoing webhook POSTs). The catalog below is the
 * stable contract external consumers write against — adding a new event
 * kind is additive; renaming or reshaping an existing one is breaking
 * and needs a versioned stream (`/api/v2/stream`).
 *
 * Design principles:
 *   1. Events carry *what changed*, not *everything about the thing*. Big
 *      payloads belong behind follow-up HTTP fetches (`GET /queue/:id`),
 *      not in the event body — consumers can decide what they need.
 *   2. Every domain event includes `tenantId` so SSE can scope per-tenant
 *      delivery without leaking cross-tenant noise. KB-scoped events also
 *      include `kbId` so admin UIs can filter to the current Trail.
 *   3. Transport/control frames (`hello`, `ping`) live outside the domain
 *      discriminant so a consumer's union narrowing stays clean.
 */
import type { QueueCandidateKind, QueueCandidateStatus } from './types.js';

// ── Domain events ─────────────────────────────────────────────────

export interface CandidateCreatedEvent {
  type: 'candidate_created';
  tenantId: string;
  kbId: string;
  candidateId: string;
  kind: QueueCandidateKind;
  title: string;
  /** 'pending' when it lands in queue, 'approved' when policy auto-approved it. */
  status: Extract<QueueCandidateStatus, 'pending' | 'approved'>;
  autoApproved: boolean;
  confidence: number | null;
  /** User id if human-originated, null if machine. */
  createdBy: string | null;
}

export interface CandidateApprovedEvent {
  type: 'candidate_approved';
  tenantId: string;
  kbId: string;
  candidateId: string;
  /** Document created/updated by the approval. */
  documentId: string;
  autoApproved: boolean;
}

export interface CandidateRejectedEvent {
  type: 'candidate_rejected';
  tenantId: string;
  kbId: string;
  candidateId: string;
  reason: string | null;
}

export interface IngestStartedEvent {
  type: 'ingest_started';
  tenantId: string;
  kbId: string;
  docId: string;
  filename: string;
}

export interface IngestCompletedEvent {
  type: 'ingest_completed';
  tenantId: string;
  kbId: string;
  docId: string;
  filename: string;
}

export interface IngestFailedEvent {
  type: 'ingest_failed';
  tenantId: string;
  kbId: string;
  docId: string;
  filename: string;
  error: string;
}

export type DomainEvent =
  | CandidateCreatedEvent
  | CandidateApprovedEvent
  | CandidateRejectedEvent
  | IngestStartedEvent
  | IngestCompletedEvent
  | IngestFailedEvent;

// ── Control frames ────────────────────────────────────────────────

export interface HelloFrame {
  type: 'hello';
  tenantId: string;
}

export interface PingFrame {
  type: 'ping';
}

export type StreamFrame = DomainEvent | HelloFrame | PingFrame;

/**
 * Type guard for narrowing a raw `JSON.parse(event.data)` into a domain
 * event. Control frames (`hello`, `ping`) return false. Unknown `type`
 * strings — reserved for additive evolution — also return false so the
 * consumer can safely ignore what it doesn't understand.
 */
export function isDomainEvent(frame: StreamFrame): frame is DomainEvent {
  return (
    frame.type === 'candidate_created' ||
    frame.type === 'candidate_approved' ||
    frame.type === 'candidate_rejected' ||
    frame.type === 'ingest_started' ||
    frame.type === 'ingest_completed' ||
    frame.type === 'ingest_failed'
  );
}
