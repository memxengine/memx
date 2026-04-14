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

export const UpdateKBSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  language: z.string().optional(),
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

export const ApproveCandidateSchema = z.object({
  filename: z.string().optional(),
  path: z.string().default('/wiki/queries/'),
  editedContent: z.string().optional(),
});

export const RejectCandidateSchema = z.object({
  reason: z.string().max(500).optional(),
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
