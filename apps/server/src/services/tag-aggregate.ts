/**
 * F92 — per-KB tag aggregate cache.
 *
 * The /knowledge-bases/:id/tags endpoint returns every distinct tag
 * present on non-archived Neurons + its count. Computed by SELECT-
 * ing all tag strings and running parseTags + count in app code —
 * SQLite doesn't have a built-in split_on / unnest, and maintaining
 * a trigger-backed tag lookup table adds complexity disproportionate
 * to the current volume (Sanne's KB has ~100 Neurons; Christian's cc
 * KB has a few dozen). Revisit if a KB exceeds ~10k Neurons.
 *
 * Cache layer: 60s TTL. Also busted explicitly on candidate_approved
 * events — see index.ts for the subscribe call — so a fresh Neuron
 * shows up in the filter chip row immediately without waiting for TTL
 * to expire. Per-KB key so buckets don't collide across tenants/KBs.
 */

import type { TrailDatabase } from '@trail/db';
import { parseTags } from '@trail/shared';
import { broadcaster } from './broadcast.js';

export interface TagCount {
  tag: string;
  count: number;
}

interface CacheEntry {
  tags: TagCount[];
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, kbId: string): string {
  return `${tenantId}:${kbId}`;
}

/**
 * Fetch + count tags for a KB. Served from the 60s TTL cache when fresh;
 * otherwise recomputes from the documents table.
 *
 * Case-insensitive dedup mirrors parseTags — `"Ops"` and `"ops"` count as
 * one tag. First-seen casing wins for display (same as the reader/editor
 * chips).
 */
export async function listKbTags(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
): Promise<TagCount[]> {
  const key = cacheKey(tenantId, kbId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.tags;

  // Pull tags for every non-archived Neuron in the KB. parseTags on
  // each row normalises whitespace + dedups within-row before the
  // aggregate count sees them, so `"ops, ops"` on one doc still counts
  // as +1 on `ops`.
  const result = await trail.execute(
    `SELECT tags FROM documents
      WHERE tenant_id = ?
        AND knowledge_base_id = ?
        AND kind = 'wiki'
        AND archived = 0
        AND tags IS NOT NULL
        AND tags != ''`,
    [tenantId, kbId],
  );

  const counts = new Map<string, { display: string; count: number }>();
  for (const row of result.rows as Array<{ tags: string | null }>) {
    const tags = parseTags(row.tags);
    for (const tag of tags) {
      const lower = tag.toLowerCase();
      const existing = counts.get(lower);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(lower, { display: tag, count: 1 });
      }
    }
  }

  const sorted: TagCount[] = Array.from(counts.values())
    .map((v) => ({ tag: v.display, count: v.count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.tag.localeCompare(b.tag);
    });

  cache.set(key, { tags: sorted, expiresAt: Date.now() + TTL_MS });
  return sorted;
}

/** Drop the cached entry for a KB. Called on candidate_approved. */
export function invalidateTagCache(tenantId: string, kbId: string): void {
  cache.delete(cacheKey(tenantId, kbId));
}

// Subscribe once at module load — the broadcaster is a long-lived
// singleton so there's no unsub to worry about. candidate_approved is
// the only event that can change the aggregate (a newly-committed
// Neuron with tags, or an edit that changed tags). candidate_resolved
// covers other effects (reject, flag-source, etc.) that don't touch
// documents.tags, so ignoring them keeps cache churn minimal.
broadcaster.subscribe((event) => {
  if (event.type === 'candidate_approved') {
    invalidateTagCache(event.tenantId, event.kbId);
  }
});
