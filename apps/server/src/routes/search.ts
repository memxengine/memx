import { Hono } from 'hono';
import { documents, knowledgeBases } from '@trail/db';
import { and, eq } from 'drizzle-orm';
import { requireAuth, getTenant, getTrail } from '../middleware/auth.js';
import { parseTags, canonicaliseTag, parseSeqId, kbPrefix } from '@trail/shared';
import { resolveKbId } from '@trail/core';
import {
  parseAudienceParam,
  defaultAudienceForAuth,
  isVisibleToAudience,
  type Audience,
} from '../services/audience.js';
import type { AppBindings } from '../app.js';

export const searchRoutes = new Hono<AppBindings>();

searchRoutes.use('*', requireAuth);

searchRoutes.get('/knowledge-bases/:kbId/search', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Not found' }, 404);
  const query = c.req.query('q') ?? '';
  const limit = Math.min(Number(c.req.query('limit') ?? 10), 50);
  // F160 — audience-filter. External Bearer integrations default to
  // `tool` (heuristics + internal-tagged docs hidden). Admin session
  // gets `curator` (everything visible). Caller can override via
  // ?audience=. Garbage values silently fall back to default rather
  // than erroring — saves a round-trip when a typo'd param shows up.
  const authType = c.get('authType');
  const audience: Audience =
    parseAudienceParam(c.req.query('audience')) ?? defaultAudienceForAuth(authType);
  // F92 — repeated ?tag= params narrow the hit list to Neurons whose
  // `tags` column contains every tag (AND-semantics). Canonicalise
  // here so `Ops`, `ops`, and `OPS` all collapse to the same filter
  // and match a case-insensitive DB value. An empty/non-canonicalisable
  // tag is dropped silently — same rule as the write path.
  const rawTags = c.req.queries('tag') ?? [];
  const tagFilters = rawTags
    .map((raw) => canonicaliseTag(raw))
    .filter((t): t is string => !!t);

  if (!query.trim()) {
    return c.json({ documents: [], chunks: [] });
  }

  // F145 — `#`-prefixed queries are seqId lookups, not FTS. Three shapes:
  //   #buddy_00000219 → exact hit if this KB's prefix matches "buddy"
  //   #00000219 / #219 → plain digits, look up seq in current KB
  //   anything else after `#` → fall through to FTS
  // No tag filter interaction: seqId uniquely identifies a row, so tags
  // would just narrow away the intended result.
  if (query.trim().startsWith('#')) {
    const hit = await lookupBySeqId(trail, tenant.id, kbId, query.trim());
    // F160 — apply audience filter even on direct seqId hits. An
    // external Bearer caller probing `#sanne_00000017` shouldn't get a
    // heuristic Neuron back just because they guessed the right seq.
    if (hit && isVisibleToAudience(audience, hit.path, hit.tags)) {
      return c.json({ documents: [hit], chunks: [] });
    }
    // Unknown #id (or audience-filtered) — return empty rather than
    // silently fall through so the curator knows the id didn't resolve
    // (not that "nothing looks like that word either"). Matches how
    // #tag searches behave elsewhere.
    return c.json({ documents: [], chunks: [] });
  }

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return c.json({ documents: [], chunks: [] });

  const [documents, chunks] = await Promise.all([
    trail.searchDocuments(ftsQuery, kbId, tenant.id, limit),
    trail.searchChunks(ftsQuery, kbId, tenant.id, limit),
  ]);

  // F92 tag facet. searchDocuments returns a narrow projection that
  // doesn't include the tags column, so we re-hydrate tags here for
  // just the doc IDs in the hit list, then filter + decorate.
  // F160 — for non-curator audience we ALSO need tags to apply the
  // audience-filter (drops Neurons tagged 'internal'), so always
  // load them when there's a hit list. The tag-load cost is one
  // small IN-query against an indexed PK list — cheap.
  if (documents.length > 0) {
    const tagMap = await loadTagsForDocIds(
      trail,
      tenant.id,
      documents.map((d) => d.id),
    );
    let filtered = documents;
    // F92 explicit tag filter (AND-semantics).
    if (tagFilters.length > 0) {
      filtered = filtered.filter((d) => {
        const docTags = parseTags(tagMap.get(d.id) ?? null).map((t) => t.toLowerCase());
        return tagFilters.every((t) => docTags.includes(t));
      });
    }
    // F160 audience-filter. curator path is a no-op (isVisibleToAudience
    // returns true unconditionally), so admin-UI behaviour is unchanged.
    if (audience !== 'curator') {
      filtered = filtered.filter((d) =>
        isVisibleToAudience(audience, d.path, tagMap.get(d.id) ?? null),
      );
    }
    return c.json({
      documents: filtered.map((d) => ({ ...d, tags: tagMap.get(d.id) ?? null })),
      chunks,
    });
  }

  return c.json({ documents, chunks });
});

/**
 * One-shot tags lookup for the hit list. Single IN query — the hit
 * list is capped at `limit` (max 50) so the parameter list never
 * exceeds SQLite's 999-param ceiling.
 */
async function loadTagsForDocIds(
  trail: ReturnType<typeof getTrail>,
  tenantId: string,
  ids: string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await trail.execute(
    `SELECT id, tags FROM documents
      WHERE tenant_id = ?
        AND id IN (${placeholders})`,
    [tenantId, ...ids],
  );
  for (const row of rows.rows as Array<{ id: string; tags: string | null }>) {
    map.set(row.id, row.tags);
  }
  return map;
}

/**
 * F145 — resolve a `#`-prefixed seqId query to a single document row.
 * Accepts the full `#prefix_digits` form or a bare `#digits` that defaults
 * to the current KB. Returns null when the id doesn't match anything in
 * the current tenant.
 */
async function lookupBySeqId(
  trail: ReturnType<typeof getTrail>,
  tenantId: string,
  currentKbId: string,
  query: string,
): Promise<{ id: string; title: string | null; path: string; kind: string; tags: string | null; seq: number } | null> {
  const parsed = parseSeqId(query);
  let seq: number;
  let targetKbId = currentKbId;
  if (parsed) {
    seq = parsed.seq;
    // Verify the parsed prefix matches the current KB. If not, resolve to
    // whichever KB in this tenant has a matching prefix.
    const kbs = await trail.db
      .select({ id: knowledgeBases.id, name: knowledgeBases.name })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.tenantId, tenantId))
      .all();
    const match = kbs.find((kb) => kbPrefix(kb.name) === parsed.prefix);
    if (!match) return null;
    targetKbId = match.id;
  } else {
    // `#<digits>` shorthand — look up in current KB.
    const digits = query.trim().replace(/^#/, '');
    const parsedDigits = Number.parseInt(digits, 10);
    if (!Number.isFinite(parsedDigits) || parsedDigits < 0) return null;
    seq = parsedDigits;
  }
  const row = await trail.db
    .select({
      id: documents.id,
      title: documents.title,
      path: documents.path,
      kind: documents.kind,
      tags: documents.tags,
      seq: documents.seq,
    })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.knowledgeBaseId, targetKbId),
        eq(documents.seq, seq),
      ),
    )
    .get();
  if (!row || row.seq === null) return null;
  return { ...row, seq: row.seq };
}

// Turn user input into a safe FTS5 MATCH expression.
// FTS5 MATCH treats quotes, dashes, and other punctuation as syntax, so a
// raw user string can explode the parser. We tokenise on whitespace, strip
// non-word chars, and OR the terms together as phrase-prefix searches.
function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return terms.join(' OR ');
}
