/**
 * @trailmem/sdk — typed client for the Trail HTTP API.
 *
 * Three methods, one per integration layer (F160):
 *   - `search(opts)`   → Lag 1 retrieval (FTS5, raw documents + chunks)
 *   - `retrieve(opts)` → Lag 1 retrieval (top-K chunks + formattedContext)
 *   - `chat(opts)`     → Lag 2/3 (LLM-synthesized answer with audience)
 *
 * The constructor takes a base URL + Bearer token. Per-call methods
 * each take a knowledgeBaseId so a single client instance can serve
 * multiple Trails. Throws `TrailApiError` on non-2xx responses with
 * the parsed body attached.
 *
 * No third-party dependencies — uses the runtime's global `fetch`
 * (Node 18+, Bun, Deno, Cloudflare Workers, browsers).
 */

import {
  type SearchOptions,
  type SearchResponse,
  type RetrieveOptions,
  type RetrieveResponse,
  type ChatOptions,
  type ChatResponse,
  type ImageSearchOptions,
  type ImageSearchResponse,
  TrailApiError,
} from './types.js';

export interface TrailClientConfig {
  /**
   * Trail engine URL. Examples:
   *   http://127.0.0.1:58021   (local dev)
   *   https://app.trailmem.com (SaaS, after F33 deploy)
   *
   * No trailing slash needed; the client normalises.
   */
  baseUrl: string;
  /** `trail_<64hex>` Bearer token. Mint via Admin → Settings → API Keys. */
  apiKey: string;
  /**
   * Custom fetch implementation. Pass when running in an environment
   * without a global `fetch` or when you want to inject middleware
   * (logging, retries, request-id propagation). Defaults to global
   * `fetch`.
   */
  fetch?: typeof fetch;
}

export class TrailClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: TrailClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? fetch;
  }

  /**
   * Lag 1 — FTS5 search over a KB. Returns matching documents and
   * chunks in parallel. Use when your site-LLM wants to discover what
   * the KB has on a topic before pulling a focused retrieve.
   */
  async search(knowledgeBaseId: string, opts: SearchOptions): Promise<SearchResponse> {
    const params = new URLSearchParams();
    params.set('q', opts.query);
    if (opts.audience) params.set('audience', opts.audience);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    for (const tag of opts.tags ?? []) params.append('tag', tag);
    return this.request<SearchResponse>(
      `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/search?${params.toString()}`,
      { method: 'GET' },
    );
  }

  /**
   * Lag 1 — focused retrieval optimised for site-LLM context-stuffing.
   * Returns top-K chunks + a pre-formatted `formattedContext` string
   * you can drop straight into your LLM's prompt. No second-pass read
   * needed.
   */
  async retrieve(knowledgeBaseId: string, opts: RetrieveOptions): Promise<RetrieveResponse> {
    return this.request<RetrieveResponse>(
      `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/retrieve`,
      {
        method: 'POST',
        body: JSON.stringify({
          query: opts.query,
          ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
          ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
          ...(opts.topK !== undefined ? { topK: opts.topK } : {}),
          ...(opts.tagFilter !== undefined ? { tagFilter: opts.tagFilter } : {}),
          ...(opts.maxImages !== undefined ? { maxImages: opts.maxImages } : {}),
        }),
      },
    );
  }

  /**
   * F161 — image-search. FTS5 over vision-generated descriptions of
   * PDF-extracted + standalone-uploaded images. Empty `query` returns
   * latest-first browse. Audience-filter excludes images attached to
   * heuristic + internal-tagged Neurons. Image URLs are absolute and
   * Bearer-protected — render via a proxy route on the consumer's
   * server (see INTEGRATION-API.md "Rendering images").
   */
  async searchImages(
    knowledgeBaseId: string,
    opts: ImageSearchOptions = {},
  ): Promise<ImageSearchResponse> {
    const params = new URLSearchParams();
    if (opts.query) params.set('q', opts.query);
    if (opts.audience) params.set('audience', opts.audience);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.request<ImageSearchResponse>(
      `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/images${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
    );
  }

  /**
   * Lag 2/3 — LLM-synthesized chat answer. Audience controls prose
   * tone (curator/tool/public). Server enforces the F156 turn-cap:
   * when the response carries `turnsUsed === turnsLimit`, the next
   * call with the same `sessionId` will throw with
   * `code === 'session_turn_cap_reached'`. Drop the sessionId in
   * that case to start a new conversation.
   */
  async chat(opts: ChatOptions): Promise<ChatResponse> {
    return this.request<ChatResponse>(`/api/v1/chat`, {
      method: 'POST',
      body: JSON.stringify({
        message: opts.message,
        knowledgeBaseId: opts.knowledgeBaseId,
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      }),
    });
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      let body: Record<string, unknown> | undefined;
      try {
        body = (await res.json()) as Record<string, unknown>;
        if (typeof body.error === 'string') message = body.error;
      } catch {
        // Non-JSON error body — keep the status-line message.
      }
      throw new TrailApiError(res.status, message, body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
