/**
 * @trailmem/sdk — public types.
 *
 * Mirrors Trail's HTTP-API response shapes. We intentionally duplicate
 * the types here rather than importing from `@trail/shared` so the
 * SDK has no monorepo-internal coupling — it can be lifted out and
 * published as a standalone npm package without rewriting imports.
 */

export type Audience = 'curator' | 'tool' | 'public';

// ── Lag 1: Retrieval ─────────────────────────────────────────────────

export interface SearchOptions {
  /** FTS5 query string. `#kbprefix_00000042` is a direct seqId lookup. */
  query: string;
  /** Default `tool` for Bearer auth. Filter applies to documents AND chunks. */
  audience?: Audience;
  /** 1–50; default 10. */
  limit?: number;
  /** Repeated tag filters (AND-semantics). */
  tags?: string[];
}

export interface SearchDocumentHit {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  title: string | null;
  path: string;
  kind: 'source' | 'wiki';
  highlight: string;
  rank: number;
  seq: number | null;
  tags: string | null;
}

export interface SearchChunkHit {
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
  documents: SearchDocumentHit[];
  chunks: SearchChunkHit[];
}

export interface RetrieveOptions {
  /** Brugerens spørgsmål eller tematisk kerne. */
  query: string;
  /** Default `tool` for Bearer auth. */
  audience?: Audience;
  /** Hard upper-bound on `formattedContext.length`. Default 2000, max 8000. */
  maxChars?: number;
  /** Default 5, max 25. */
  topK?: number;
  /** AND-semantics tag filter. */
  tagFilter?: string[];
  /** F161 — hard upper-bound on `images[]` length. Default 10, max 50, set 0 to skip. */
  maxImages?: number;
}

export interface RetrieveChunk {
  documentId: string;
  /** Stable per-KB sequence id (kbprefix_00000017). Null on probe Neurons that pre-date seq assignment. */
  seqId: string | null;
  title: string;
  /** Filesystem-style path inside the KB (e.g. /neurons/zoneterapi.md). */
  neuronPath: string;
  content: string;
  headerBreadcrumb: string | null;
  rank: number;
}

/**
 * F161 — image extracted from a parent document (PDF page-image,
 * standalone image-upload). URL is absolute and ready to fetch with
 * the same Bearer token used to call retrieve. Browsers can NOT load
 * `<img src={url}>` directly because the GET requires Authorization
 * header; consumers proxy through their own server (see
 * `INTEGRATION-API.md` "Rendering images" section).
 */
export interface RetrieveImage {
  documentId: string;
  filename: string;
  /** Absolute URL — `${TRAIL_API_BASE}/api/v1/documents/.../images/...`. Bearer required. */
  url: string;
  /** Vision-generated description (1-2 sentences) or empty string when none. */
  alt: string;
  /** PDF page-number for embedded images; null for standalone uploads. */
  page: number | null;
  width: number;
  height: number;
}

export interface RetrieveResponse {
  chunks: RetrieveChunk[];
  /** Pre-stitched markdown context block. Drop directly into your site-LLM's prompt. */
  formattedContext: string;
  totalChars: number;
  hitCount: number;
  /** F161 — images attached to the documents in `chunks`. Up to `maxImages`. */
  images: RetrieveImage[];
}

// ── F161 — Image search ──────────────────────────────────────────────

export interface ImageSearchOptions {
  /** FTS5 query against vision_description. Empty = browse mode (latest first). */
  query?: string;
  /** Default `tool` for Bearer auth. Filters images attached to non-visible Neurons. */
  audience?: Audience;
  /** 1–50; default 20. */
  limit?: number;
}

export interface ImageSearchHit {
  id: string;
  documentId: string;
  filename: string;
  /** Absolute URL — see RetrieveImage.url for proxy/Bearer notes. */
  url: string;
  alt: string;
  page: number | null;
  width: number;
  height: number;
  /** Vision-model that produced `alt`, or null if unknown (legacy backfill). */
  visionModel: string | null;
  createdAt: string;
}

export interface ImageSearchResponse {
  hits: ImageSearchHit[];
}

// ── Lag 2/3: Chat ────────────────────────────────────────────────────

export interface ChatOptions {
  /** The user's question. */
  message: string;
  /** Slug or UUID. Required when client targets a specific KB. */
  knowledgeBaseId: string;
  /** Pin to continue a multi-turn conversation. Omit on first turn. */
  sessionId?: string;
  /**
   * Default `tool` for Bearer auth, `curator` for session-cookie.
   * Pass `public` for end-user-facing widget integration.
   */
  audience?: Audience;
}

export interface ChatCitation {
  documentId: string;
  path: string;
  filename: string;
}

export interface ChatResponse {
  /** Raw markdown answer with `[[wiki-links]]` left in (curator) or stripped (tool/public). */
  answer: string;
  /** Server-side rewritten markdown — for curator audience resolves wiki-links to admin paths; for tool/public same as `answer`. */
  renderedAnswer: string;
  citations: ChatCitation[];
  /** Pin on next turn. Server creates one when omitted on first turn. */
  sessionId: string | null;
  /** Which backend actually served the answer (after fallback chain). */
  backend: string | null;
  /** Which model actually served the answer. */
  model: string | null;
  /** F156 — how many user-turns now in this session (after this turn was persisted). */
  turnsUsed: number;
  /** F156 — env-tuned cap. When `turnsUsed === turnsLimit`, next request returns 429. */
  turnsLimit: number;
  /** F160 — echoed back so client confirms which template ran. */
  audience: Audience;
}

// ── Errors ───────────────────────────────────────────────────────────

/**
 * Thrown by the client on any non-2xx response. The HTTP status is on
 * `.status`; if the server returned a JSON body with `code` (e.g.
 * `session_turn_cap_reached`) it's on `.code`. The full parsed body
 * is on `.body` — pull `turnsUsed`/`turnsLimit` from there for the
 * 429 cap-reached case.
 */
export class TrailApiError extends Error {
  public readonly status: number;
  public readonly code?: string;
  public readonly body?: Record<string, unknown>;

  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message);
    this.name = 'TrailApiError';
    this.status = status;
    this.body = body;
    if (body && typeof body.code === 'string') {
      this.code = body.code;
    }
  }
}
