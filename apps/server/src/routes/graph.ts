import { Hono } from 'hono';
import {
  documents,
  documentAccessRollup,
  wikiBacklinks,
} from '@trail/db';
import { and, eq, sql } from 'drizzle-orm';
import { requireAuth, getTenant, getTrail } from '../middleware/auth.js';
import { resolveKbId, DEFAULT_HUB_PAGES } from '@trail/core';
import { parseTags } from '@trail/shared';

// Reuse the lint-layer's hub list so the graph colours the same set
// of structural Neurons as the orphan-detector skips. Adding a new hub
// filename to DEFAULT_HUB_PAGES flows through both surfaces.
const HUB_FILENAMES = new Set<string>(DEFAULT_HUB_PAGES);

/**
 * Pull a short body excerpt out of a Neuron's raw markdown for the
 * graph tooltip. Strips frontmatter, the leading `# Title` heading,
 * and then EVERY markdown syntax mark so what the tooltip shows is
 * flat reading text — not `**bold**`, `[[wiki-link]]`, `## Heading`,
 * or `[text](url)`. The tooltip is a tiny preview, not a renderer.
 */
function excerptOf(raw: string | null): string | null {
  if (!raw) return null;
  let text = raw;

  // 1. Drop frontmatter block — Karpathy-style compile output always
  //    prefixes with `---\n...\n---\n`.
  const fmMatch = text.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  if (fmMatch) text = text.slice(fmMatch[0].length);

  // 2. Drop the first `# Heading` line — duplicates the tooltip header.
  text = text.replace(/^\s*#\s+[^\n]*\n+/, '');

  // 3. Strip markdown block syntax before flattening to one line.
  //    - Fenced code blocks: drop entirely (noise in a 1-line preview).
  //    - Setext headings (=== / ---) and ATX headings (##): drop the
  //      marker characters, keep the text.
  //    - List markers at line start: drop.
  //    - Block quotes: drop `>` prefix.
  text = text
    .replace(/```[\s\S]*?```/g, ' ')        // fenced code
    .replace(/^\s*#{1,6}\s+/gm, '')         // ATX headings
    .replace(/^\s*[-*+]\s+/gm, '')          // bullet lists
    .replace(/^\s*\d+\.\s+/gm, '')          // numbered lists
    .replace(/^\s*>\s?/gm, '');             // block quotes

  // 4. Strip inline markdown. Wiki-links render as their display text
  //    (or target) so `[[fmc|FMC]]` becomes `FMC`. Regular links
  //    collapse to their anchor text. Bold/italic/code markers drop.
  text = text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')     // [[target|display]]
    .replace(/\[\[([^\]]+)\]\]/g, '$1')                 // [[target]]
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')               // ![alt](img) drop
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')            // [text](url) → text
    .replace(/`([^`]+)`/g, '$1')                        // `code`
    .replace(/\*\*([^*]+)\*\*/g, '$1')                  // **bold**
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')       // *italic*
    .replace(/__([^_]+)__/g, '$1')                      // __bold__
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1');          // _italic_

  // 5. Collapse all whitespace into single spaces.
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length === 0) return null;

  // 6. Truncate at the nearest word boundary within 30 chars of MAX
  //    so we don't hack off a word mid-stroke.
  const MAX = 220;
  if (text.length <= MAX) return text;
  const cut = text.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(' ');
  const safe = lastSpace > MAX - 30 ? cut.slice(0, lastSpace) : cut;
  return safe.trimEnd() + '…';
}

/**
 * F99 — Neuron graph endpoint.
 *
 * Returns the full Neuron-to-Neuron graph for a KB: nodes = wiki
 * Neurons, edges = wiki_backlinks (Neuron `[[link]]` references).
 *
 * Source documents are deliberately excluded from v1 — Obsidian-style
 * graph view wants to show the *shape of knowledge*, not the ingest
 * inputs. Citations (document_references) are a separate layer we can
 * add later as a toggle (F99.x).
 *
 * No positions stored yet — client-side FA2 handles layout until the
 * compile-time layout pass lands (see F99 plan doc §Layout).
 */
export const graphRoutes = new Hono();

graphRoutes.use('*', requireAuth);

graphRoutes.get('/knowledge-bases/:kbId/graph', async (c) => {
  const trail = getTrail(c);
  const tenant = getTenant(c);
  const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));
  if (!kbId) return c.json({ error: 'Knowledge base not found' }, 404);

  // Nodes: every non-archived wiki OR work doc. F138 adds kind='work'
  // so the graph shows Knowledge + Work in one frame — the whole point
  // of the Work Layer is that tasks/bugs live alongside the Neurons
  // they reference. Node shape is carried in the response so the admin
  // renders circles for knowledge and squares for work.
  const nodeRows = await trail.db
    .select({
      id: documents.id,
      kind: documents.kind,
      title: documents.title,
      filename: documents.filename,
      path: documents.path,
      tags: documents.tags,
      content: documents.content,
      workStatus: documents.workStatus,
      workKind: documents.workKind,
      backlinkCount: sql<number>`(
        SELECT COUNT(*) FROM ${wikiBacklinks}
        WHERE ${wikiBacklinks.toDocumentId} = ${documents.id}
      )`.as('backlink_count'),
    })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenant.id),
        eq(documents.knowledgeBaseId, kbId),
        sql`(${documents.kind} = 'wiki' OR ${documents.kind} = 'work')`,
        eq(documents.archived, false),
      ),
    )
    .all();

  // Edges: wiki_backlinks. F137 — carry edge_type along so the admin
  // renders typed relations (contradicts, supersedes, is-a ...)
  // distinctly. When a Neuron links to the same target via two phrasings
  // with different edge-types, keep the first one seen — matches how
  // the extractor dedupes on (from, to, linkText) internally.
  const edgeRowsRaw = await trail.db
    .select({
      source: wikiBacklinks.fromDocumentId,
      target: wikiBacklinks.toDocumentId,
      edgeType: wikiBacklinks.edgeType,
    })
    .from(wikiBacklinks)
    .where(
      and(
        eq(wikiBacklinks.tenantId, tenant.id),
        eq(wikiBacklinks.knowledgeBaseId, kbId),
      ),
    )
    .all();

  // App-side dedup on (source, target) — selectDistinct on drizzle
  // with multiple columns was brittle, and we need to pick the most
  // informative edge_type when a pair has multiple entries. Priority:
  // anything non-'cites' wins over 'cites' (typed is a strict upgrade
  // over default), otherwise first-seen wins.
  const edgeMap = new Map<string, { source: string; target: string; edgeType: string }>();
  for (const row of edgeRowsRaw) {
    const key = `${row.source}→${row.target}`;
    const existing = edgeMap.get(key);
    if (!existing) {
      edgeMap.set(key, row);
    } else if (existing.edgeType === 'cites' && row.edgeType !== 'cites') {
      edgeMap.set(key, row);
    }
  }
  const edgeRows = Array.from(edgeMap.values());

  // Orphan signal: Neuron has zero outgoing document_references (no
  // source citations). Matches F98's orphan-lint heuristic so the
  // graph colours stay aligned with the queue findings the curator
  // already knows.
  const orphanIds = new Set(
    (
      await trail.db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenant.id),
            eq(documents.knowledgeBaseId, kbId),
            eq(documents.kind, 'wiki'),
            eq(documents.archived, false),
            sql`NOT EXISTS (
              SELECT 1 FROM document_references dr
              WHERE dr.wiki_document_id = ${documents.id}
            )`,
          ),
        )
        .all()
    ).map((r) => r.id),
  );

  // F141 — usage_weight from the access-rollup aggregate. One SELECT,
  // join-less map lookup in node building. Missing rows → weight 0
  // (KBs that never ran the nightly rollup, or Neurons never read).
  const usageRows = await trail.db
    .select({
      documentId: documentAccessRollup.documentId,
      usageWeight: documentAccessRollup.usageWeight,
    })
    .from(documentAccessRollup)
    .where(eq(documentAccessRollup.knowledgeBaseId, kbId))
    .all();
  const usageByDoc = new Map<string, number>(
    usageRows.map((r) => [r.documentId, r.usageWeight]),
  );

  const nodes = nodeRows.map((r) => {
    const rawSize = Math.sqrt(r.backlinkCount);
    const hub = HUB_FILENAMES.has(r.filename);
    // Hub pages get a gentle size bump so they stand out without
    // dominating the frame. At size=20 (the earlier value) three
    // clumped hubs rendered as one giant clover-leaf — aesthetic
    // regression. Cap at 12 so even a zero-backlink hub reads as
    // "a bit more prominent than default" and a 25-backlink hub
    // (overview.md on Sanne's KB) caps gracefully.
    const size = hub
      ? Math.max(7, Math.min(12, rawSize + 7))
      : Math.max(4, Math.min(20, rawSize * 3 + 4));
    return {
      id: r.id,
      label: r.title ?? r.filename,
      filename: r.filename,
      path: r.path,
      x: null as number | null,
      y: null as number | null,
      size,
      // Hub pages are NOT orphans — F98's lint exempts them, so the
      // graph mirrors that. Otherwise every wiki would paint overview
      // cyan which isn't the signal we want.
      orphan: !hub && orphanIds.has(r.id),
      hub,
      tags: parseTags(r.tags),
      backlinks: r.backlinkCount,
      // F141 — 0-1 normalised-per-KB usage weight. Consumers can
      // scale node-radius (e.g. size * (0.5 + usageWeight)) or render
      // a heat overlay. 0 for Neurons never read or KBs that haven't
      // rolled up yet — callers should treat 0 as "unknown", not "cold".
      usageWeight: usageByDoc.get(r.id) ?? 0,
      excerpt: excerptOf(r.content),
      // F138 — kind drives node shape in the admin renderer: 'wiki'
      // → circle (knowledge), 'work' → square (task/bug/milestone).
      // workStatus + workKind populated only when kind='work' so the
      // client can colour the square by status without a second round-
      // trip.
      kind: r.kind,
      workStatus: r.workStatus,
      workKind: r.workKind,
    };
  });

  // Filter edges to known node ids — a stray backlink pointing at an
  // archived or deleted doc would otherwise render as a dangling edge.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = edgeRows
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map((e, i) => ({
      id: `e${i}`,
      source: e.source,
      target: e.target,
      edgeType: e.edgeType,
    }));

  return c.json({
    nodes,
    edges,
    meta: {
      layoutComputedAt: null,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
  });
});
