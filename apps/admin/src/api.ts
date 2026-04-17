import type {
  QueueCandidate,
  QueueCandidateKind,
  QueueCandidateStatus,
  ApproveCandidatePayload,
  RejectCandidatePayload,
  KnowledgeBase,
  Document,
} from '@trail/shared';

/**
 * Typed fetch wrapper.
 * Cookies flow via credentials: 'include'. Errors surface as thrown
 * `ApiError` with status + server-provided message.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    ...init,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body.error) {
        message = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
      }
    } catch {
      // ignore
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Resources ────────────────────────────────────────────────────

export function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  return api('/api/v1/knowledge-bases');
}

export interface QueueListResponse {
  items: QueueCandidate[];
  count: number;
}

export interface QueueFilter {
  knowledgeBaseId?: string;
  kind?: QueueCandidateKind;
  status?: QueueCandidateStatus;
  limit?: number;
}

export function listQueue(filter: QueueFilter = {}): Promise<QueueListResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return api(`/api/v1/queue?${qs.toString()}`);
}

export function getCandidate(id: string): Promise<QueueCandidate> {
  return api(`/api/v1/queue/${encodeURIComponent(id)}`);
}

export interface ApprovalResponse {
  candidateId: string;
  documentId: string;
  wikiEventId: string;
  autoApproved: boolean;
}

export function approveCandidate(
  id: string,
  payload: ApproveCandidatePayload = { path: '/neurons/queries/' },
): Promise<ApprovalResponse> {
  return api(`/api/v1/queue/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function rejectCandidate(
  id: string,
  payload: RejectCandidatePayload = {},
): Promise<{ candidateId: string; reason: string | null }> {
  return api(`/api/v1/queue/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface BulkQueueResult {
  action: 'approve' | 'reject';
  requested: number;
  succeeded: Array<{ id: string }>;
  failed: Array<{ id: string; error: string }>;
}

export function bulkQueue(args: {
  action: 'approve' | 'reject';
  ids: string[];
  reason?: string;
  approvePath?: string;
}): Promise<BulkQueueResult> {
  return api(`/api/v1/queue/bulk`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
}

// ── Documents (wiki + source) ────────────────────────────────────

/** List wiki pages in a KB (kind='wiki', non-archived). */
export function listWikiPages(kbId: string): Promise<Document[]> {
  return api(`/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/documents?kind=wiki`);
}

/** List sources in a KB (kind='source', non-archived). */
export function listSources(kbId: string): Promise<Document[]> {
  return api(`/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/documents?kind=source`);
}

/** Fetch a document + its full content. */
export function getDocumentContent(
  docId: string,
): Promise<{ id: string; content: string | null; version: number }> {
  return api(`/api/v1/documents/${encodeURIComponent(docId)}/content`);
}

/** Soft-archive a document. Sets archived=true + status='archived'. */
export function archiveDocument(docId: string): Promise<void> {
  return api(`/api/v1/documents/${encodeURIComponent(docId)}`, { method: 'DELETE' });
}

// ── Search ───────────────────────────────────────────────────────

export interface DocumentSearchHit {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  title: string | null;
  path: string;
  kind: 'source' | 'wiki';
  /** HTML snippet with FTS5 `<mark>` tags around matches. */
  highlight: string;
  rank: number;
}

export interface ChunkSearchHit {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  content: string;
  headerBreadcrumb: string | null;
  highlight: string;
  rank: number;
}

export interface SearchResponse {
  documents: DocumentSearchHit[];
  chunks: ChunkSearchHit[];
}

/** FTS5 search across documents + chunks in a KB. Empty query returns empty. */
export function searchKb(kbId: string, q: string, limit = 10): Promise<SearchResponse> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  return api(`/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/search?${qs.toString()}`);
}

// ── Lint (F32) ──────────────────────────────────────────────────

export interface LintReport {
  kbId: string;
  ranAt: string;
  detectors: Array<{
    name: string;
    scanned: number;
    found: number;
    emitted: number;
    skippedExisting: number;
    elapsedMs: number;
  }>;
  totalEmitted: number;
}

/** Run lint detectors on demand. Idempotent via lint fingerprints. */
export function runLint(kbId: string): Promise<LintReport> {
  return api(`/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/lint`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ── Chat ────────────────────────────────────────────────────────

export interface ChatCitation {
  documentId: string;
  path: string;
  filename: string;
}

export interface ChatResponse {
  answer: string;
  citations?: ChatCitation[];
}

/** Single-turn chat against a KB. Engine retrieves via FTS + calls Claude. */
export function chat(kbId: string, message: string): Promise<ChatResponse> {
  return api(`/api/v1/chat`, {
    method: 'POST',
    body: JSON.stringify({ message, knowledgeBaseId: kbId }),
  });
}

/**
 * Feedback loop: promote a chat Q+A into the Curation Queue as a candidate.
 * Uses kind='chat-answer'. Created by the curator (not service), so it lands
 * as pending for manual review — a human chose to save this, a human should
 * confirm it's worth committing to the wiki.
 */
export function saveChatAsNeuron(args: {
  kbId: string;
  question: string;
  answer: string;
  citations: ChatCitation[];
  title: string;
  confidence?: number;
}): Promise<unknown> {
  const slug = slugify(args.title);
  const metadata = JSON.stringify({
    op: 'create',
    filename: `${slug}.md`,
    path: '/neurons/queries/',
    source: 'chat',
    sourceCitations: args.citations.map((c) => c.documentId),
  });
  const content = [
    `# ${args.title}`,
    '',
    `**Question:** ${args.question}`,
    '',
    '---',
    '',
    args.answer,
    args.citations.length
      ? '\n\n---\n\n## Sources\n' +
        args.citations.map((c) => `- [[${c.filename.replace(/\.md$/i, '')}]]`).join('\n')
      : '',
  ].join('\n');

  return api(`/api/v1/queue/candidates`, {
    method: 'POST',
    body: JSON.stringify({
      knowledgeBaseId: args.kbId,
      kind: 'chat-answer',
      title: args.title,
      content,
      metadata,
      confidence: args.confidence ?? 0.6,
    }),
  });
}

function slugify(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Upload a source file. Uses multipart/form-data — do NOT set Content-Type;
 * the browser generates the boundary. Flows through the same endpoint the
 * engine has had since F06.
 */
export async function uploadSource(
  kbId: string,
  file: File,
  opts: { path?: string } = {},
): Promise<Document> {
  const form = new FormData();
  form.append('file', file);
  if (opts.path) form.append('path', opts.path);

  const response = await fetch(
    `/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/documents/upload`,
    {
      method: 'POST',
      credentials: 'include',
      body: form,
    },
  );
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body.error) message = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
    } catch {
      // ignore
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as Document;
}
