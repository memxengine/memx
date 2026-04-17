import type { z } from 'zod';
import type {
  TenantSchema,
  UserSchema,
  KnowledgeBaseSchema,
  DocumentSchema,
  QueueCandidateSchema,
  CreateQueueCandidateSchema,
  ListQueueQuerySchema,
  ResolveCandidateSchema,
  QueueCandidateKindEnum,
  QueueCandidateStatusEnum,
} from './schemas.js';

export type Tenant = z.infer<typeof TenantSchema>;
export type User = z.infer<typeof UserSchema>;
export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;
export type Document = z.infer<typeof DocumentSchema>;
export type QueueCandidate = z.infer<typeof QueueCandidateSchema>;
export type CreateQueueCandidate = z.infer<typeof CreateQueueCandidateSchema>;
export type ListQueueQuery = z.infer<typeof ListQueueQuerySchema>;
export type ResolveCandidatePayload = z.infer<typeof ResolveCandidateSchema>;
export type QueueCandidateKind = z.infer<typeof QueueCandidateKindEnum>;
export type QueueCandidateStatus = z.infer<typeof QueueCandidateStatusEnum>;
export type Locale = 'en' | 'da';

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'archived';
export type DocumentKind = 'source' | 'wiki';
export type UserRole = 'owner' | 'curator' | 'reader';
export type TenantPlan = 'hobby' | 'pro' | 'business' | 'enterprise';
