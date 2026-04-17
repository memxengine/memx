import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

// ── Tenants (Phase 1 has one, Phase 2 has many) ───────────────────────────────

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  plan: text('plan', { enum: ['hobby', 'pro', 'business', 'enterprise'] }).notNull().default('hobby'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ── Users ─────────────────────────────────────────────────────────────────────

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    role: text('role', { enum: ['owner', 'curator', 'reader'] }).notNull().default('owner'),
    onboarded: integer('onboarded', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('idx_users_tenant_email').on(table.tenantId, table.email),
  ],
);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ── Knowledge Bases ───────────────────────────────────────────────────────────

export const knowledgeBases = sqliteTable(
  'knowledge_bases',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull().references(() => users.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    language: text('language').notNull().default('da'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('idx_kb_tenant_slug').on(table.tenantId, table.slug),
    uniqueIndex('idx_kb_tenant_name').on(table.tenantId, table.name),
  ],
);

// ── Documents (sources + wiki pages in one table, differentiated by `kind`) ───

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id),
    kind: text('kind', { enum: ['source', 'wiki'] }).notNull(),
    filename: text('filename').notNull(),
    title: text('title'),
    path: text('path').notNull().default('/'),
    fileType: text('file_type').notNull(),
    fileSize: integer('file_size').notNull().default(0),
    status: text('status', {
      enum: ['pending', 'processing', 'ready', 'failed', 'archived'],
    }).notNull().default('pending'),
    pageCount: integer('page_count'),
    content: text('content'),
    tags: text('tags'),
    date: text('date'),
    metadata: text('metadata'),
    errorMessage: text('error_message'),
    version: integer('version').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    // Meaningful when kind='source': marks the document as authoritative for its topic.
    // Used later for trust-tier rules (e.g. reject auto-approval of contradicting sources).
    isCanonical: integer('is_canonical', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_docs_tenant').on(table.tenantId),
    index('idx_docs_kb').on(table.knowledgeBaseId),
    index('idx_docs_kb_kind').on(table.knowledgeBaseId, table.kind),
    index('idx_docs_kb_path').on(table.knowledgeBaseId, table.path),
    index('idx_docs_status').on(table.knowledgeBaseId, table.status),
    index('idx_docs_kb_canonical').on(table.knowledgeBaseId, table.isCanonical),
  ],
);

// ── Document chunks (for FTS) ─────────────────────────────────────────────────

export const documentChunks = sqliteTable(
  'document_chunks',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    page: integer('page'),
    startChar: integer('start_char'),
    tokenCount: integer('token_count').notNull(),
    headerBreadcrumb: text('header_breadcrumb'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('idx_chunks_doc_index').on(table.documentId, table.chunkIndex),
    index('idx_chunks_kb').on(table.knowledgeBaseId),
  ],
);

// ── Curation Queue ────────────────────────────────────────────────────────────

export const queueCandidates = sqliteTable(
  'queue_candidates',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: [
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
      ],
    }).notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    metadata: text('metadata'),
    confidence: integer('confidence'),
    impactEstimate: integer('impact_estimate'),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'ingested'] }).notNull().default('pending'),
    createdBy: text('created_by').references(() => users.id),
    reviewedBy: text('reviewed_by').references(() => users.id),
    reviewedAt: text('reviewed_at'),
    // Set when the approval happened via policy (not a human click). Distinct from reviewedAt,
    // which is set for both human and auto approvals.
    autoApprovedAt: text('auto_approved_at'),
    rejectionReason: text('rejection_reason'),
    resultingDocumentId: text('resulting_document_id').references(() => documents.id),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_queue_kb_status').on(table.knowledgeBaseId, table.status),
  ],
);

// ── Wiki Page Events (history) ────────────────────────────────────────────────

export const wikiEvents = sqliteTable(
  'wiki_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    eventType: text('event_type', {
      enum: ['created', 'edited', 'renamed', 'moved', 'archived', 'restored'],
    }).notNull(),
    actorId: text('actor_id').references(() => users.id),
    actorKind: text('actor_kind', { enum: ['user', 'llm', 'system'] }).notNull(),
    previousVersion: integer('previous_version'),
    newVersion: integer('new_version'),
    summary: text('summary'),
    metadata: text('metadata'),
    // Replay-chain pointer: previous event on this document. Nullable for the first event.
    prevEventId: text('prev_event_id'),
    // Which queue candidate caused this event, if any. Null for user-initiated edits.
    sourceCandidateId: text('source_candidate_id').references(() => queueCandidates.id, { onDelete: 'set null' }),
    // Full content snapshot at this event (not a diff). Enables replay and time-travel without
    // reconstructing from the current document.
    contentSnapshot: text('content_snapshot'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_events_doc').on(table.documentId),
    index('idx_events_doc_prev').on(table.documentId, table.prevEventId),
  ],
);

// ── Document References (bidirectional wiki ↔ source index) ───────────────────

export const documentReferences = sqliteTable(
  'document_references',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    // The wiki page making the reference.
    wikiDocumentId: text('wiki_document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    // The source being referenced.
    sourceDocumentId: text('source_document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    // Optional claim-level anchor (e.g. `claim-01`). Null = page-level reference.
    claimAnchor: text('claim_anchor'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_refs_wiki').on(table.wikiDocumentId),
    index('idx_refs_source').on(table.sourceDocumentId),
    uniqueIndex('idx_refs_triple').on(table.wikiDocumentId, table.sourceDocumentId, table.claimAnchor),
  ],
);

// ── Wiki Backlinks (Neuron → Neuron navigation graph) ─────────────────────────
// F15 iter 2: `[[wiki-link]]` syntax in Neuron bodies. Separate from
// document_references because its semantic is navigation, not provenance —
// a [[link]] says "related page", not "cited source". Populated by the
// backlink-extractor service at boot-time backfill + on every
// candidate_approved.

export const wikiBacklinks = sqliteTable(
  'wiki_backlinks',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    // The Neuron containing the [[link]]
    fromDocumentId: text('from_document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    // The Neuron being linked to
    toDocumentId: text('to_document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    // The exact text inside the brackets. Can differ from the resolved
    // filename — e.g. `[[Orphans + Stale]]` resolves to `orphans-stale.md`
    // but we keep the authored form for display + debugging.
    linkText: text('link_text').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_backlinks_from').on(table.fromDocumentId),
    index('idx_backlinks_to').on(table.toDocumentId),
    // Prevents re-extracting the same link over and over. The link text is
    // part of the key so a Neuron can link twice with different phrasings.
    uniqueIndex('idx_backlinks_unique').on(table.fromDocumentId, table.toDocumentId, table.linkText),
  ],
);
