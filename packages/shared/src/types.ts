import type { z } from 'zod';
import type {
  TenantSchema,
  UserSchema,
  KnowledgeBaseSchema,
  DocumentSchema,
  QueueCandidateSchema,
} from './schemas.js';

export type Tenant = z.infer<typeof TenantSchema>;
export type User = z.infer<typeof UserSchema>;
export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;
export type Document = z.infer<typeof DocumentSchema>;
export type QueueCandidate = z.infer<typeof QueueCandidateSchema>;

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'archived';
export type DocumentKind = 'source' | 'wiki';
export type UserRole = 'owner' | 'curator' | 'reader';
export type TenantPlan = 'hobby' | 'pro' | 'business' | 'enterprise';
