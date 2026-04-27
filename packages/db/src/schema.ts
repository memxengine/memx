import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

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
    // Lint rejection policy:
    //   'trusting'  — rejected fingerprints are suppressed permanently.
    //                 No nag-loop on dismissed findings. Default.
    //   'strict'    — rejected fingerprints may re-emit on the next lint
    //                 pass, giving the curator a second chance to catch a
    //                 wrongful dismissal. Higher noise, lower blind-spot
    //                 risk.
    // Per-Trail so owners can dial their own signal/noise tradeoff.
    lintPolicy: text('lint_policy', { enum: ['trusting', 'strict'] })
      .notNull()
      .default('trusting'),
    // F141 — per-KB access-telemetry toggle. On by default; curator can
    // flip off per Trail if they don't want individual reads recorded.
    // Off → recordAccess is a no-op + rollup skips the KB.
    trackAccess: integer('track_access', { mode: 'boolean' }).notNull().default(true),
    // F149 — per-KB ingest-backend overrides. Nullable; runner's
    // resolveIngestChain falls back to env → hardcoded defaults when
    // these are NULL. Legal values for ingest_backend today:
    // 'claude-cli' | 'openrouter'. ingest_model is the provider-specific
    // id (e.g. 'claude-sonnet-4-6' or 'google/gemini-2.5-flash').
    // ingest_fallback_chain is an optional JSON-encoded ChainStep[]
    // override; when present it fully replaces the default chain for
    // this KB.
    ingestBackend: text('ingest_backend'),
    ingestModel: text('ingest_model'),
    ingestFallbackChain: text('ingest_fallback_chain'),
    // F159 Phase 3 — per-KB chat-backend overrides. NULL means
    // resolveChatChain falls back to env defaults. chatFallbackChain
    // is JSON-encoded ChainStep[] when set.
    chatBackend: text('chat_backend'),
    chatModel: text('chat_model'),
    chatFallbackChain: text('chat_fallback_chain'),
    // F160 Phase 2 — per-KB persona overrides for audience-aware chat.
    // Both NULL (default) means "use base template unchanged". When
    // set, the text is appended to the resolved tool/public persona-
    // template under a "## KB-specific persona" header. curator
    // audience has no per-KB override — admin tone is shared.
    chatPersonaTool: text('chat_persona_tool'),
    chatPersonaPublic: text('chat_persona_public'),
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
    kind: text('kind', { enum: ['source', 'wiki', 'work'] }).notNull(),
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
    // F145 — per-KB monotone sequence. Rendered as `<kbPrefix>_<seq:8>` (e.g.
    // `buddy_00000219`) for cross-session references. Populated at insert time
    // by packages/core/src/queue/candidates.ts inside the approve transaction;
    // backfilled for pre-existing rows by migration 0008. Nullable only on the
    // column to avoid a failed migration on a huge pre-seq database — every
    // row should carry a seq after 0008 runs.
    seq: integer('seq'),
    // F138 — Work Layer fields. Only meaningful when kind='work'; null on
    // all other rows. Kept on documents (not a separate table) so wiki-
    // links, backlinks, F99 graph, search and chat treat Work items as
    // regular documents with extra state.
    workStatus: text('work_status', { enum: ['open', 'in-progress', 'done', 'blocked'] }),
    workAssignee: text('work_assignee'),
    workDueAt: text('work_due_at'),
    workKind: text('work_kind', { enum: ['task', 'bug', 'milestone', 'decision'] }),
    // F111.2 — stamped by the ingest subprocess via the MCP write tool so
    // wireSourceRefs can identify all docs touched by a specific job.
    ingestJobId: text('ingest_job_id'),
    // F25/F47 prep — pre-ingest extraction cost (vision-call for image
    // sources, Whisper-transcription for audio, future OCR for scans).
    // Complements ingest_jobs.cost_cents (F149) which tracks compile-fasen.
    // 0 for sources where extraction is free (text/markdown/SVG passthrough).
    // F156 Credits-Based Metering will deduct on this column when it lands.
    extractCostCents: integer('extract_cost_cents').notNull().default(0),
    // F118 — round-robin contradiction-scan coverage. Scheduler orders
    // by this column ASC NULLS FIRST so never-scanned + oldest-scanned
    // Neurons get visited first across passes. Stamped after each
    // scanDocForContradictions completes.
    lastContradictionScanAt: text('last_contradiction_scan_at'),
    // F158 — content-signature for idempotent skip. sha256 hash of
    // (neuron.version + sorted peer-versions). When unchanged from
    // previous successful scan, the entire LLM-call loop is bypassed.
    // Stamped only on success (not error) so a flaky Neuron retries
    // next pass instead of getting stuck.
    lastContradictionScanSignature: text('last_contradiction_scan_signature'),
    // F162 — SHA-256 hex of the original file bytes. Source-rows
    // (kind='source') get hashed at upload time so the upload route
    // can detect duplicates before writing storage or burning ingest
    // credits. NULL on pre-F162 rows + on wiki/work rows; the
    // backfill-content-hash bootstrap populates legacy NULL sources
    // on next server start. App code enforces uniqueness per
    // (tenant_id, knowledge_base_id, content_hash); the partial index
    // (migration 0024) is for lookup speed only — no DB-level UNIQUE
    // so force=true uploads can intentionally bypass.
    contentHash: text('content_hash'),
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
    index('idx_docs_work_status').on(table.knowledgeBaseId, table.workStatus),
    index('idx_docs_work_assignee').on(table.knowledgeBaseId, table.workAssignee),
    uniqueIndex('idx_docs_kb_seq').on(table.knowledgeBaseId, table.seq),
    index('idx_docs_ingest_job').on(table.ingestJobId),
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

// ── F161 — Document images (PDF-extracted + standalone image-uploads) ─────
//
// First-class media-table. PDF pipeline (F08) extracts each embedded
// image, writes bytes to storage, runs Vision-callback for ≥100×100px
// images, and now ALSO inserts a row here. Image pipeline (F25) does
// the same for standalone uploads. Vision-description persists as
// structured data so we can search it (FTS5), re-run with newer
// models without full re-ingest, and audit cost.
//
// content_hash enables image-dedup at the metadata layer (same logo
// in two PDFs = same hash; storage-level CAS deferred to Phase 2).
//
// Foreign keys are tenant + KB + parent document — cascade-delete
// when source is removed so we never leak orphan image-rows.
export const documentImages = sqliteTable(
  'document_images',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    storagePath: text('storage_path').notNull(),
    contentHash: text('content_hash').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    page: integer('page'),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    visionDescription: text('vision_description'),
    visionModel: text('vision_model'),
    visionAt: text('vision_at'),
    visionCostCents: integer('vision_cost_cents'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_doc_images_document').on(table.documentId),
    index('idx_doc_images_kb').on(table.tenantId, table.knowledgeBaseId),
    index('idx_doc_images_hash').on(table.tenantId, table.knowledgeBaseId, table.contentHash),
  ],
);

// ── Background jobs (F164) ────────────────────────────────────────────────────
//
// Generic long-running operations: vision-rerun (first consumer),
// bulk-vision-rerun, future ingest/contradiction-scan/etc. Designed
// for crash-recovery via heartbeat (status='running' AND
// last_heartbeat_at < now-60s → reset to 'pending'), cooperative abort
// (abort_requested=1 + AbortController signal), and SSE-streamed
// progress (the runner persists progress JSON; SSE just relays).
//
// Separate from ingest_jobs (F143) on purpose — ingest_jobs has
// domain-specific columns (file_size, page_count, ingest_phase) that
// don't translate to a Vision-rerun. Two specialised tables sharing
// a few invariants is cleaner than one polymorphic table with NULL
// columns half the time.
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'paused', 'completed', 'failed', 'aborted'],
    }).notNull().default('pending'),
    payload: text('payload').notNull(),
    progress: text('progress'),
    result: text('result'),
    errorMessage: text('error_message'),
    parentJobId: text('parent_job_id'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    lastHeartbeatAt: text('last_heartbeat_at'),
    abortRequested: integer('abort_requested').notNull().default(0),
    costCentsEstimated: integer('cost_cents_estimated'),
    costCentsActual: integer('cost_cents_actual'),
  },
  (table) => [
    index('idx_jobs_tenant_status').on(table.tenantId, table.status),
    index('idx_jobs_kb_status').on(table.knowledgeBaseId, table.status),
    index('idx_jobs_parent').on(table.parentJobId),
    index('idx_jobs_running_heartbeat').on(table.status, table.lastHeartbeatAt),
  ],
);

// ── Vision quality ratings (F164 Phase 5) ─────────────────────────────────────
//
// Curator 👍/👎 feedback on Vision-generated image descriptions, surfaced
// from the JobProgressModal sample-grid + Lightbox. v1 = collect-only.
// v1.5 plans: feed 👎-rated images back into prompt-tuning, compare
// model variants by aggregate up/down rate.
//
// Unique(user_id, image_id) — one rating per curator per image. Re-vote
// flips existing row via UPSERT. Cascade-delete via image and user FKs.
export const visionQualityRatings = sqliteTable(
  'vision_quality_ratings',
  {
    id: text('id').primaryKey(),
    imageId: text('image_id').notNull().references(() => documentImages.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    rating: text('rating', { enum: ['up', 'down'] }).notNull(),
    model: text('model'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('idx_vqr_user_image').on(table.userId, table.imageId),
    index('idx_vqr_image').on(table.imageId),
    index('idx_vqr_tenant_rating').on(table.tenantId, table.rating),
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
    // Producer-generated resolution options as JSON (CandidateAction[]). Null
    // means the candidate was created before the actions primitive existed;
    // readers stamp defaultActions (Approve/Reject) so every candidate looks
    // uniform at the API boundary. Set at creation, never mutated afterwards
    // except for lazy-filled translations per locale on view.
    actions: text('actions'),
    // Which action id the curator (or auto-policy) executed. Null until
    // resolved. Distinct from status: 'approved' is the final state, but a
    // candidate could have reached it via many different actions.
    resolvedAction: text('resolved_action'),
    // Per-locale cache of LLM-translated title + content. Shape:
    //   {"da": {"title": "...", "content": "..."}, "de": ...}
    // Populated lazily on first view in a non-EN locale via the
    // translation service; never re-translated once cached. Null means
    // no locales have been requested yet.
    translations: text('translations'),
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
    // F137 — typed relation carried by the link. Parsed from
    // `[[target|edge-type]]` syntax by the backlink-extractor; defaults
    // to 'cites' for bare `[[link]]`s and all pre-F137 rows.
    //   cites        — bare mention, weakest relation (default)
    //   is-a         — hierarchical specialisation
    //   part-of      — composition (A is-part-of B)
    //   contradicts  — explicit disagreement between claims
    //   supersedes   — versioning (A replaces older B)
    //   example-of   — concrete instance of an abstract concept
    //   caused-by    — causal dependency
    edgeType: text('edge_type').notNull().default('cites'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_backlinks_from').on(table.fromDocumentId),
    index('idx_backlinks_to').on(table.toDocumentId),
    index('idx_backlinks_edge_type').on(table.edgeType),
    // Prevents re-extracting the same link over and over. The link text is
    // part of the key so a Neuron can link twice with different phrasings.
    uniqueIndex('idx_backlinks_unique').on(table.fromDocumentId, table.toDocumentId, table.linkText),
  ],
);

// ── F141 — Neuron access telemetry + rollup ──────────────────────────────────

/**
 * Append-only log of every Neuron read. One row per request — cheap,
 * indexed, and disposable (old rows can be purged at the rollup step).
 * actor_kind='llm' reads (compiler, lint) are ignored by the rollup
 * aggregation so automated passes don't inflate usage weights.
 */
export const documentAccess = sqliteTable(
  'document_access',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    // Which surface triggered the read: chat | api | mcp | admin-reader | graph-click
    source: text('source').notNull(),
    actorKind: text('actor_kind', { enum: ['user', 'llm', 'system'] }).notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_access_doc').on(table.documentId, table.createdAt),
    index('idx_access_kb').on(table.knowledgeBaseId, table.createdAt),
  ],
);

/**
 * Rolled-up aggregate — one row per document, updated by the nightly
 * rollup pass in the F32 lint-scheduler. Callers that need usage
 * signal (graph node sizing, search tie-break, chat-context bias)
 * read this table; they don't scan document_access directly.
 */
export const documentAccessRollup = sqliteTable(
  'document_access_rollup',
  {
    documentId: text('document_id').primaryKey().references(() => documents.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    reads7d: integer('reads_7d').notNull().default(0),
    reads30d: integer('reads_30d').notNull().default(0),
    reads90d: integer('reads_90d').notNull().default(0),
    readsTotal: integer('reads_total').notNull().default(0),
    lastReadAt: text('last_read_at'),
    // 0-1 normalised per-KB — a KB's hottest Neuron hits 1.0.
    usageWeight: real('usage_weight').notNull().default(0),
    rolledUpAt: text('rolled_up_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_rollup_kb').on(table.knowledgeBaseId),
  ],
);

// ── F143 — Persistent ingest queue ──────────────────────────────────────────
//
// Replaces the pair of module-scoped Maps (`activeIngests` + `ingestQueue`) in
// services/ingest.ts. Queue survives server restarts / redeploys — a boot
// sweep resets `running` rows back to `queued` so the scheduler picks them
// up on the next tick. At-least-once semantics are covered by the existing
// candidate idempotency key (F92 canonicalisation + ae56430 dedup guard),
// so a duplicate job execution is harmless.

export const ingestJobs = sqliteTable(
  'ingest_jobs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    // queued → running → done | failed. Boot recovery re-queues any `running`
    // rows. Terminal states are kept for audit so the admin UI can show
    // "ingested 5 minutes ago" in the compile-log card.
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    attempts: integer('attempts').notNull().default(0),
    // LLM prompt shape (source-kind variant, context inheritance, etc.) —
    // JSON stringified. Kept on the job so a re-run after boot-recovery uses
    // the same shape the original trigger chose.
    promptOptions: text('prompt_options'),
    errorMessage: text('error_message'),
    // F149 — per-job cost tracking. Populated by OpenRouter-backend from
    // the `usage.total_cost` field of each response; claude-cli on Max
    // Plan emits 0 (rendered as "gratis (Max)" in the cost dashboard).
    // NOT NULL DEFAULT 0 so pre-F149 rows satisfy the schema.
    costCents: integer('cost_cents').notNull().default(0),
    // F149 — 'claude-cli' | 'openrouter'. NULL on pre-F149 rows; UI
    // renders those as "claude-cli" legacy for display purposes.
    backend: text('backend'),
    // F149 — JSON array of {turn, model} entries recording which model
    // actually ran each turn. Typical shape: `[{turn:1,model:"gemini-
    // 2.5-flash"}]`. When fallback fires: `[{turn:1,model:"flash"},
    // {turn:7,model:"glm"}]`. Null on pre-F149 runs.
    modelTrail: text('model_trail'),
    // F151 shadow — heuristic cost estimate for pre-F149 jobs where
    // cost_cents is 0 (Max Plan or untracked). Derived from output-
    // token size × Sonnet-API pricing. NULL on non-backfilled rows.
    // UI shows only when a "shadow estimate" toggle is on. Never mix
    // with real cost_cents in sums unless the user explicitly opts in.
    costCentsEstimated: integer('cost_cents_estimated'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_ingest_jobs_kb_status').on(table.knowledgeBaseId, table.status),
    index('idx_ingest_jobs_doc').on(table.documentId),
  ],
);

// ── F149 Phase 2e — Per-tenant encrypted API keys ──────────────────────────
//
// One row per tenant. Each provider's API key is stored as an
// AES-256-GCM sealed blob in the shape `nonce:ciphertext:tag` (all
// base64). The master key lives in TRAIL_SECRETS_MASTER_KEY env at
// server boot; rotation via apps/server/scripts/rotate-secrets-key.ts.
//
// Read-path: ingest runner checks here FIRST when resolving the
// OpenRouter/Anthropic API key for a tenant's run. Falls back to
// process env (Christian's personal key) when NULL. Never exposed
// verbatim in any HTTP response — only the F152 status endpoint
// surfaces a boolean "is configured".

export const tenantSecrets = sqliteTable(
  'tenant_secrets',
  {
    tenantId: text('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
    openrouterApiKeyEncrypted: text('openrouter_api_key_encrypted'),
    anthropicApiKeyEncrypted: text('anthropic_api_key_encrypted'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
);

// ── F156 Phase 0 — credits balance + transactions ────────────────────────────
// Dev-credits foundation. consumeCredits() decrements `balance` + appends
// a row to credit_transactions in one tx. UI reads `balance` directly;
// audit trail lives in transactions. Phase 2 layers Stripe Checkout +
// monthly auto-topup; Phase 4 adds hard-cap enforcement. See F156 plan-
// doc for full rollout phases.

export const tenantCredits = sqliteTable('tenant_credits', {
  tenantId: text('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  // Current balance in credits (1 credit = 1¢ USD of measured LLM cost
  // per F156 plan-doc §"Hvordan credits beregnes per ingest"). Can go
  // negative — Phase 4 hard-enforcement isn't shipped yet.
  balance: integer('balance').notNull().default(0),
  // Monthly top-up baseline per tier (Hobby 100 / Starter 400 / Pro 2000
  // / Business 10000). Phase 0 doesn't auto-top-up; the column is here
  // so Phase 2 can read it without a schema bump.
  monthlyIncluded: integer('monthly_included').notNull().default(0),
  lastTopupAt: text('last_topup_at'),
  // Used by Phase 3 alert system to dedupe "you're running low" emails.
  lowBalanceAlertedAt: text('low_balance_alerted_at'),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const creditTransactions = sqliteTable(
  'credit_transactions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    // 'consume' | 'monthly_topup' | 'purchase' | 'adjustment' | 'refund'
    kind: text('kind').notNull(),
    // Negative for consume, positive for top-ups. balance_after is the
    // post-transaction balance so dashboard reads don't need a SUM.
    amount: integer('amount').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    // 'ingest' | 'chat' | 'lint' | 'extract'. Null for non-consume rows.
    feature: text('feature'),
    relatedIngestJobId: text('related_ingest_job_id'),
    relatedChatTurnId: text('related_chat_turn_id'),
    relatedStripeId: text('related_stripe_id'),
    note: text('note'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_credit_tx_tenant').on(table.tenantId, table.createdAt),
    index('idx_credit_tx_kind').on(table.tenantId, table.kind, table.createdAt),
    index('idx_credit_tx_ingest').on(table.relatedIngestJobId),
    index('idx_credit_tx_chat').on(table.relatedChatTurnId),
  ],
);

// ── F111 — API Keys (bearer auth for extensions + external clients) ──────────

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // SHA-256 hex of the raw `trail_<64hex>` token. Never stored in plaintext.
    keyHash: text('key_hash').notNull(),
    lastUsedAt: text('last_used_at'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    revokedAt: text('revoked_at'),
  },
  (table) => [
    uniqueIndex('idx_api_keys_user_name').on(table.userId, table.name),
    index('idx_api_keys_hash').on(table.keyHash),
  ],
);

// ── F144 — Chat history persistence ─────────────────────────────────────────
//
// chat.tsx previously stored turns in a React useState, so any route-change,
// reload, or tab-close wiped the conversation. These tables keep sessions
// + turns server-side per-KB so curators can revisit answers days later and
// citations survive slug-drift (neuronId is the stable key, title+slug are
// display-only). Token counts + latency are captured per turn so the F121
// budget ledger extends naturally into ad-hoc chat.

export const chatSessions = sqliteTable(
  'chat_sessions',
  {
    id: text('id').primaryKey(),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id),
    // Auto-derived from the first user-turn; editable via rename. Nullable
    // only for the brief moment between session-create and the first turn
    // landing — a freshly-minted session has no title yet.
    title: text('title'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_chat_sessions_kb').on(table.knowledgeBaseId, table.archived, table.updatedAt),
    index('idx_chat_sessions_user').on(table.userId, table.updatedAt),
  ],
);

export const chatTurns = sqliteTable(
  'chat_turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    // JSON-encoded array of { neuronId, title, slug }. neuronId is the
    // stable UUID so renames don't break the link; title+slug are frozen
    // at write-time for display.
    citations: text('citations'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    latencyMs: integer('latency_ms'),
    // F159 Phase 3 — per-turn cost + audit. NULL on Claude-CLI rows
    // (Max-Plan flat fee — no per-call cost). Populated by
    // OpenRouter / Claude-API backends from usage data.
    costCents: integer('cost_cents'),
    backendUsed: text('backend_used'),
    modelUsed: text('model_used'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_chat_turns_session').on(table.sessionId, table.createdAt),
  ],
);

// ── F148 — Link Integrity (broken-link findings) ────────────────────────────
//
// One row per [[wiki-link]] the link-checker service cannot resolve against
// any Neuron in the KB — via canonical slug, title match, OR the F148 Lag 2
// bilingual fold. Serves two purposes: (a) a durable record so the admin UI
// can show "N broken links in this Trail" without re-parsing every body on
// each request, and (b) idempotency for the checker's candidate_approved +
// daily-sweep passes. UNIQUE (from_document_id, link_text) means a re-scan
// that finds the same broken link is a no-op.
//
// status lifecycle: open → auto_fixed (content rewritten by checker) |
// dismissed (curator confirmed intentional dead link) | open-stale (daily
// sweep confirmed still broken after N days — surfaces for harder
// attention).
export const brokenLinks = sqliteTable(
  'broken_links',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    fromDocumentId: text('from_document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    // Exact text inside [[...]] — preserves case + spaces for the admin UI
    // so curator sees what the author wrote, not the slugified form.
    linkText: text('link_text').notNull(),
    // Filled when the checker found a single high-confidence candidate
    // (fold-match with ties, or Levenshtein ≤ 2 to an existing title).
    // Curator accepts via POST /link-check/:id/accept.
    suggestedFix: text('suggested_fix'),
    status: text('status', { enum: ['open', 'auto_fixed', 'dismissed'] }).notNull().default('open'),
    reportedAt: text('reported_at').notNull().default(sql`(datetime('now'))`),
    fixedAt: text('fixed_at'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('idx_broken_links_unique').on(table.fromDocumentId, table.linkText),
    index('idx_broken_links_kb_status').on(table.knowledgeBaseId, table.status),
  ],
);
