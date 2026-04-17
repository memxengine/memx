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
import type { CandidateEffectKind } from './schemas.js';

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

/**
 * Narrow event for the common case: a curator accepted a candidate via
 * the default `approve` action AND a document was created/updated as a
 * result. Doc-indexing subscribers (reference-extractor, contradiction-
 * lint, backlink-extractor) listen to this one because they only care
 * about new Neuron content.
 *
 * Richer effects (`retire-neuron`, `flag-source`, etc.) do NOT emit
 * candidate_approved — they only emit `candidate_resolved`. Consumers that
 * want to react to any resolution (e.g. the pending-count badge) listen
 * to the universal event instead.
 */
export interface CandidateApprovedEvent {
  type: 'candidate_approved';
  tenantId: string;
  kbId: string;
  candidateId: string;
  /** Document created/updated by the approval. */
  documentId: string;
  autoApproved: boolean;
}

/**
 * Universal resolution event — fires on EVERY curator decision regardless
 * of which action was taken. Carries the effect + resolvedActionId so
 * consumers that want to react action-by-action can.
 *
 * The pending-count badge subscribes to this one. Emitted in addition to
 * `candidate_approved` for approve-effect resolutions; emitted alone for
 * richer effects (retire-neuron, flag-source, merge-into-new, etc.).
 */
export interface CandidateResolvedEvent {
  type: 'candidate_resolved';
  tenantId: string;
  kbId: string;
  candidateId: string;
  actionId: string;
  effect: CandidateEffectKind;
  /**
   * Document affected by the resolution — non-null when the effect
   * commits or modifies a Neuron (approve, retire-neuron,
   * refresh-from-source). Null for effects that mutate non-document
   * state (flag-source on a Source, mark-still-relevant just bumps
   * updated_at).
   */
  documentId: string | null;
  /** True iff the F19 policy resolved this, not a human. */
  autoApproved: boolean;
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

export interface KbCreatedEvent {
  type: 'kb_created';
  tenantId: string;
  kbId: string;
  slug: string;
  name: string;
}

export type DomainEvent =
  | CandidateCreatedEvent
  | CandidateApprovedEvent
  | CandidateResolvedEvent
  | IngestStartedEvent
  | IngestCompletedEvent
  | IngestFailedEvent
  | KbCreatedEvent;

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
    frame.type === 'candidate_resolved' ||
    frame.type === 'ingest_started' ||
    frame.type === 'ingest_completed' ||
    frame.type === 'ingest_failed' ||
    frame.type === 'kb_created'
  );
}
