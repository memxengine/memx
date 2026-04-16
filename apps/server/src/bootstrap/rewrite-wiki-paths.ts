/**
 * One-shot namespace rename: `/wiki/...` → `/neurons/...`.
 *
 * Trail's brand vocabulary is Trail (KB) + Neuron (compiled wiki page).
 * The internal namespace `/wiki/` leaked into stored `documents.path` and
 * `queue_candidates.metadata.path` via legacy prompts, seed data, and
 * ported llmwiki content. We now store `/neurons/` canonically so the
 * engine, MCP prompts, admin, and exported data all agree.
 *
 * Idempotent: scans for rows that still start with `/wiki/`, rewrites them,
 * exits clean if none are left. Safe to run on every boot — and should,
 * because ported data and old backups can reintroduce `/wiki/` rows.
 */
import { documents, queueCandidates, type TrailDatabase } from '@trail/db';
import { eq, like } from 'drizzle-orm';

export async function rewriteWikiToNeurons(trail: TrailDatabase): Promise<void> {
  const docRows = await trail.db
    .select({ id: documents.id, path: documents.path })
    .from(documents)
    .where(like(documents.path, '/wiki/%'))
    .all();

  for (const row of docRows) {
    const next = '/neurons/' + row.path.slice('/wiki/'.length);
    await trail.db
      .update(documents)
      .set({ path: next, updatedAt: new Date().toISOString() })
      .where(eq(documents.id, row.id))
      .run();
  }

  // queue_candidates.metadata is a TEXT blob of JSON. Parse, rewrite the
  // `path` field if it starts with /wiki/, write back — only touching rows
  // that actually need it.
  const candRows = await trail.db
    .select({ id: queueCandidates.id, metadata: queueCandidates.metadata })
    .from(queueCandidates)
    .where(like(queueCandidates.metadata, '%"path":"/wiki/%'))
    .all();

  let candRewrites = 0;
  for (const row of candRows) {
    if (!row.metadata) continue;
    try {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      const p = meta.path;
      if (typeof p !== 'string' || !p.startsWith('/wiki/')) continue;
      meta.path = '/neurons/' + p.slice('/wiki/'.length);
      await trail.db
        .update(queueCandidates)
        .set({ metadata: JSON.stringify(meta) })
        .where(eq(queueCandidates.id, row.id))
        .run();
      candRewrites += 1;
    } catch {
      // Malformed metadata — skip. Legacy dev rows had invalid JSON.
    }
  }

  if (docRows.length || candRewrites) {
    console.log(
      `  namespace rewrite: /wiki/ → /neurons/ on ${docRows.length} document${docRows.length === 1 ? '' : 's'} + ${candRewrites} candidate${candRewrites === 1 ? '' : 's'}`,
    );
  }
}
