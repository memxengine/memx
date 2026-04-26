/**
 * F160 Phase 1 — `POST /api/v1/knowledge-bases/:kbId/retrieve`.
 *
 * Lag 1 retrieval — det primære integrations-endpoint for site-LLM-
 * orchestratorer. Forskellen fra `/search`: body i stedet for query-
 * string (større queries OK), returnerer chunks med fuld content +
 * en pre-formatteret `formattedContext`-blok klar til at stuffe ind
 * i en site-LLM's prompt uden second-pass `read`-kald.
 *
 * Designed til at site-LLM kan ringe ind med brugerens spørgsmål,
 * få relevant KB-baggrund tilbage, og selv formulere svaret i sin
 * egen tone uden et ekstra Trail-LLM-kald i mellem.
 *
 * Audience-filtering: Bearer-callers defaulter til `tool` så
 * heuristics + internal-tagged Neurons aldrig leaker. Caller kan
 * eksplicit overskrive til `curator` eller `public` via body-felt.
 *
 * Token-budget: `maxChars` (default 2000) er en HARD upper-bound på
 * sum(chunks.content) i `formattedContext`. Vi bygger fra højest
 * rank ned indtil næste chunk ville sprænge budgettet, så site-LLM
 * får de mest relevante chunks selv når mange kunne matche.
 */

import { Hono } from 'hono';
import { documents, knowledgeBases } from '@trail/db';
import { and, eq, inArray } from 'drizzle-orm';
import { requireAuth, getTenant, getTrail } from '../middleware/auth.js';
import { canonicaliseTag, parseTags, kbPrefix } from '@trail/shared';
import { resolveKbId } from '@trail/core';
import {
  parseAudienceParam,
  defaultAudienceForAuth,
  isVisibleToAudience,
  type Audience,
} from '../services/audience.js';
import type { AppBindings } from '../app.js';

export const retrieveRoutes = new Hono<AppBindings>();
retrieveRoutes.use('*', requireAuth);

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_CHARS = 2000;
const HARD_TOP_K_CAP = 25;
const HARD_MAX_CHARS = 8000;

interface RetrieveBody {
  query?: unknown;
  audience?: unknown;
  maxChars?: unknown;
  topK?: unknown;
  tagFilter?: unknown;
}

retrieveRoutes.post('/knowledge-bases/:kbId/retrieve', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Not found' }, 404);

  let body: RetrieveBody;
  try {
    body = (await c.req.json()) as RetrieveBody;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return c.json({ error: 'query is required' }, 400);
  }

  const authType = c.get('authType');
  const audience: Audience =
    parseAudienceParam(typeof body.audience === 'string' ? body.audience : null) ??
    defaultAudienceForAuth(authType);

  // Clamp numeric inputs into safe ranges. We don't 400 on out-of-band
  // values — better to silently honour the cap than make an integration
  // fragile to "I sent 1000 instead of the max 25" goofs.
  const topK = clampInt(body.topK, DEFAULT_TOP_K, 1, HARD_TOP_K_CAP);
  const maxChars = clampInt(body.maxChars, DEFAULT_MAX_CHARS, 1, HARD_MAX_CHARS);

  const tagFilter = parseTagFilter(body.tagFilter);

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) {
    // Empty / un-FTS-able query (e.g. all stopwords) — return zero hits
    // rather than 500. Site-LLM can decide whether to retry or fall back
    // to "I couldn't find anything specific".
    return c.json({
      chunks: [],
      formattedContext: '',
      totalChars: 0,
      hitCount: 0,
    });
  }

  // Pull more chunks than topK so audience + tag filtering still leaves
  // a useful list when many chunks come from filtered-out documents.
  // 3x is a safe over-fetch — the FTS5 cost is dominated by the query
  // parse + match, not the extra 10 rows back.
  const rawChunks = await trail.searchChunks(ftsQuery, kbId, tenant.id, topK * 3);

  if (rawChunks.length === 0) {
    return c.json({
      chunks: [],
      formattedContext: '',
      totalChars: 0,
      hitCount: 0,
    });
  }

  // Hydrate parent-document metadata in one IN-query.
  const docIds = Array.from(new Set(rawChunks.map((c) => c.documentId)));
  const parentDocs = await trail.db
    .select({
      id: documents.id,
      title: documents.title,
      path: documents.path,
      tags: documents.tags,
      seq: documents.seq,
      knowledgeBaseId: documents.knowledgeBaseId,
    })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenant.id),
        inArray(documents.id, docIds),
      ),
    )
    .all();

  const docMap = new Map(parentDocs.map((d) => [d.id, d]));

  // Resolve KB prefix once for seqId rendering. All chunks come from the
  // same caller-specified KB so we only need one lookup.
  const kbRow = await trail.db
    .select({ name: knowledgeBases.name })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, kbId))
    .get();
  const prefix = kbRow ? kbPrefix(kbRow.name) : null;

  // Apply audience + tag filtering, then build the budgeted result list.
  const filtered: Array<{
    documentId: string;
    seqId: string | null;
    title: string;
    neuronPath: string;
    content: string;
    headerBreadcrumb: string | null;
    rank: number;
  }> = [];

  for (const chunk of rawChunks) {
    const doc = docMap.get(chunk.documentId);
    if (!doc) continue;
    if (!isVisibleToAudience(audience, doc.path, doc.tags)) continue;
    if (tagFilter.length > 0) {
      const docTags = parseTags(doc.tags ?? null).map((t) => t.toLowerCase());
      if (!tagFilter.every((t) => docTags.includes(t))) continue;
    }
    filtered.push({
      documentId: doc.id,
      seqId: prefix && doc.seq != null ? `${prefix}_${String(doc.seq).padStart(8, '0')}` : null,
      title: doc.title ?? doc.path.split('/').pop() ?? doc.path,
      neuronPath: doc.path,
      content: chunk.content,
      headerBreadcrumb: chunk.headerBreadcrumb,
      rank: chunk.rank,
    });
    if (filtered.length >= topK) break;
  }

  // Build formattedContext within maxChars budget. Higher rank wins;
  // we keep adding chunks in order until the next one would exceed.
  // This prefers fewer high-rank chunks over many low-rank ones — site-
  // LLM benefits more from focused context than scattered crumbs.
  const sections: string[] = [];
  const includedChunks: typeof filtered = [];
  let totalChars = 0;
  for (const c of filtered) {
    const header = c.headerBreadcrumb
      ? `## ${c.title} — ${c.headerBreadcrumb}`
      : `## ${c.title}`;
    const section = `${header}\n\n${c.content}`;
    // +2 for the section separator (\n\n) we'll add when joining.
    const projected = totalChars + section.length + (sections.length > 0 ? 2 : 0);
    if (projected > maxChars) break;
    sections.push(section);
    includedChunks.push(c);
    totalChars = projected;
  }
  const formattedContext = sections.join('\n\n');

  return c.json({
    chunks: includedChunks,
    formattedContext,
    totalChars,
    hitCount: includedChunks.length,
  });
});

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function parseTagFilter(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => canonicaliseTag(t))
    .filter((t): t is string => !!t);
}

/**
 * Same FTS5-sanitiser as `/search` uses. Duplicated here rather than
 * imported because /search keeps its own as a private helper; pulling
 * it out into a shared module is a follow-up cleanup, not blocker for
 * F160 Phase 1.
 */
function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return terms.join(' OR ');
}
