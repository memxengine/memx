import { z } from 'zod';

// ── Tenant & User ─────────────────────────────────────────────────────────────

export const TenantSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  plan: z.enum(['hobby', 'pro', 'business', 'enterprise']),
  createdAt: z.string(),
});

export const UserSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.enum(['owner', 'curator', 'reader']),
  onboarded: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ── Knowledge Base ────────────────────────────────────────────────────────────

export const KnowledgeBaseSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().min(1).max(100),
  slug: z.string(),
  description: z.string().nullable(),
  language: z.string().default('da'),
  lintPolicy: z.enum(['trusting', 'strict']).default('trusting'),
  sourceCount: z.number().int().optional(),
  wikiPageCount: z.number().int().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateKBSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  language: z.string().optional(),
});

export const LintPolicyEnum = z.enum(['trusting', 'strict']);
export type LintPolicy = z.infer<typeof LintPolicyEnum>;

export const UpdateKBSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  language: z.string().optional(),
  lintPolicy: LintPolicyEnum.optional(),
});

// ── Sources & Wiki Pages ──────────────────────────────────────────────────────

export const DocumentStatusEnum = z.enum(['pending', 'processing', 'ready', 'failed', 'archived']);
export const DocumentKindEnum = z.enum(['source', 'wiki']);

export const DocumentSchema = z.object({
  id: z.string(),
  knowledgeBaseId: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  kind: DocumentKindEnum,
  filename: z.string(),
  title: z.string().nullable(),
  path: z.string(),
  fileType: z.string(),
  fileSize: z.number().int(),
  status: DocumentStatusEnum,
  pageCount: z.number().int().nullable(),
  content: z.string().nullable(),
  tags: z.string().nullable(),
  date: z.string().nullable(),
  metadata: z.string().nullable(),
  errorMessage: z.string().nullable(),
  version: z.number().int(),
  sortOrder: z.number().int(),
  archived: z.boolean(),
  isCanonical: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateNoteSchema = z.object({
  filename: z.string().min(1),
  path: z.string().default('/'),
  content: z.string().default(''),
});

export const UpdateDocumentSchema = z.object({
  filename: z.string().min(1).optional(),
  path: z.string().optional(),
  title: z.string().nullable().optional(),
  tags: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  metadata: z.string().nullable().optional(),
});

export const UpdateContentSchema = z.object({
  content: z.string(),
});

// ── Localisation primitive ────────────────────────────────────────────────────
// LLM-generated user-facing text lives bilingually. English is canonical
// (LLM native tongue); other locales are lazy-filled on first view in that
// language and persisted back into the same struct. Adding a third locale
// = one new optional field, no migration.

export const BilingualTextSchema = z
  .object({
    en: z.string(),
    da: z.string().optional(),
  })
  .passthrough();

export type BilingualText = z.infer<typeof BilingualTextSchema>;

// ── Curation Queue ────────────────────────────────────────────────────────────

export const QueueCandidateKindEnum = z.enum([
  'chat-answer',
  'ingest-summary',
  'ingest-page-update',
  'cross-ref-suggestion',
  'contradiction-alert',
  'gap-detection',
  'user-correction',
  'reader-feedback',
  'external-feed',
  'version-conflict',
  'source-retraction',
  'scheduled-recompile',
]);

// Every curator decision maps to exactly one CandidateEffectKind. The engine
// knows how to execute each kind against the DB; the producer decides which
// ones it wants to offer per candidate.
export const CandidateEffectKindEnum = z.enum([
  // Legacy defaults — present on every candidate via `defaultActions`.
  'approve',
  'reject',
  // "I've seen this and I'll handle it outside the queue." No DB mutation —
  // candidate resolves as status='approved'. Distinct from reject because
  // the curator accepted the finding; they just chose to act manually.
  'acknowledge',
  // Rich effects — used by contradiction/stale/orphan producers.
  'retire-neuron',
  'merge-into-new',
  'flag-source',
  'refresh-from-source',
  'mark-still-relevant',
]);

export const CandidateActionSchema = z.object({
  // Stable machine id. Callers reference this via POST /resolve {actionId}.
  id: z.string().min(1),
  effect: CandidateEffectKindEnum,
  // Effect-specific args. Each effect defines its own shape; engine
  // validates at execution time.
  args: z.record(z.string(), z.unknown()).optional(),
  label: BilingualTextSchema,
  explanation: BilingualTextSchema,
});

export type CandidateAction = z.infer<typeof CandidateActionSchema>;
export type CandidateEffectKind = z.infer<typeof CandidateEffectKindEnum>;

export const QueueCandidateStatusEnum = z.enum([
  'pending',
  'approved',
  'rejected',
  'ingested',
]);

export const QueueCandidateSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  knowledgeBaseId: z.string(),
  kind: QueueCandidateKindEnum,
  title: z.string(),
  content: z.string(),
  metadata: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  impactEstimate: z.number().int().nullable(),
  status: QueueCandidateStatusEnum,
  createdBy: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  autoApprovedAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  resultingDocumentId: z.string().nullable(),
  createdAt: z.string(),
  // Resolution options offered to the curator. Null = legacy candidate
  // (UI renders the default Approve/Reject pair). Non-null = producer-
  // generated options, each already localised (at least en, da lazy-filled).
  actions: z.array(CandidateActionSchema).nullable(),
  // The actionId that was executed at resolution time. Null until resolved.
  // Distinct from status so we can distinguish "approved via 'reconcile'"
  // from "approved via default approve" in audit logs.
  resolvedAction: z.string().nullable(),
  // Per-locale cache of translated title + content.
  //   { da: { title, content }, de: ..., ... }
  // Populated lazily by the translation service on first non-EN view.
  // Null means no locales have been cached yet. `en` is canonical and
  // never stored here — readers fall back to the plain `title` + `content`
  // columns for English.
  translations: z
    .record(
      z.string(),
      z.object({
        title: z.string().optional(),
        content: z.string().optional(),
      }),
    )
    .nullable(),
});

// ── Document References (bidirectional wiki ↔ source) ─────────────────────────

export const DocumentReferenceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  knowledgeBaseId: z.string(),
  wikiDocumentId: z.string(),
  sourceDocumentId: z.string(),
  claimAnchor: z.string().nullable(),
  createdAt: z.string(),
});

export const CreateQueueCandidateSchema = z.object({
  knowledgeBaseId: z.string(),
  kind: QueueCandidateKindEnum,
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  metadata: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  impactEstimate: z.number().int().nullable().optional(),
  // Optional target slug — when present, approve updates this wiki page;
  // otherwise approve creates a new page at `path/filename`.
  targetDocumentId: z.string().optional(),
  // Producer-specified resolution options. Omit for legacy candidates —
  // the engine stamps defaultActions (Approve/Reject) on those at read
  // time so every candidate has actions from the API's POV.
  actions: z.array(CandidateActionSchema).optional(),
});

export const ListQueueQuerySchema = z.object({
  knowledgeBaseId: z.string().optional(),
  kind: QueueCandidateKindEnum.optional(),
  status: QueueCandidateStatusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

// POST /queue/:id/resolve — the canonical curator-decision endpoint.
// `actionId` references one of the candidate's actions (or 'approve'/
// 'reject' on legacy candidates). Effect-specific fields live in args so
// the engine can pass them to the right executor; top-level fields
// (filename/path/editedContent/reason/notes) are the legacy approve/reject
// fields kept as siblings so migrating is a straight rename.
export const ResolveCandidateSchema = z.object({
  actionId: z.string().min(1),
  // Effect-specific overrides. Shape validated per-effect in core.
  args: z.record(z.string(), z.unknown()).optional(),
  // Legacy approve fields — still recognised when actionId === 'approve'.
  filename: z.string().optional(),
  path: z.string().optional(),
  editedContent: z.string().optional(),
  // Legacy reject field.
  reason: z.string().max(500).optional(),
  // Reviewer note, stored for audit regardless of actionId.
  notes: z.string().max(1000).optional(),
});

// ── Chat ──────────────────────────────────────────────────────────────────────

export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  knowledgeBaseId: z.string().optional(),
});

export const ChatResponseSchema = z.object({
  answer: z.string(),
  citations: z.array(z.object({
    documentId: z.string(),
    path: z.string(),
    filename: z.string(),
  })).optional(),
});

// ── Bulk Operations ───────────────────────────────────────────────────────────

export const BulkDeleteSchema = z.object({
  ids: z.array(z.string()).min(1),
});
