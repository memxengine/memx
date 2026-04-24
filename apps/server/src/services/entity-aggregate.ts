/**
 * F148 — per-KB entity-Neuron aggregate cache.
 *
 * Returns the list of entity-Neurons (pages under /neurons/entities/)
 * that exist in a KB, so the ingest prompt can inject them as an
 * ENTITY VOCABULARY block. Lets the compiler link `Sanne Andersen`
 * mentions in a fresh source to the existing `sanne-andersen.md` entity
 * page instead of creating a duplicate.
 *
 * Mirror of `tag-aggregate.ts`: 60s TTL cache, busted on
 * `candidate_approved`. The entity list is small per KB (Sanne's KB
 * tops out at ~30 named people; the cap at 200 is generous). Capped to
 * keep the prompt's token cost bounded even on KBs that grow to
 * hundreds of entities.
 */

import type { TrailDatabase } from '@trail/db';
import { broadcaster } from './broadcast.js';

export interface EntityRef {
  title: string;
  filename: string;
}

interface CacheEntry {
  entities: EntityRef[];
  expiresAt: number;
}

const TTL_MS = 60_000;
const MAX_ENTITIES = 200;
const cache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, kbId: string): string {
  return `${tenantId}:${kbId}`;
}

/**
 * Fetch every non-archived entity-Neuron in a KB, sorted by title.
 * Served from the 60s TTL cache when fresh. Caller is expected to be
 * the ingest-prompt builder, which runs once per job — cheap.
 *
 * Rows where `title` is NULL are skipped: without a display title the
 * LLM can't usefully be told "link to this entity", and the entity
 * page is likely broken anyway (orphan-lint will flag it).
 */
export async function listKbEntities(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
): Promise<EntityRef[]> {
  const key = cacheKey(tenantId, kbId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.entities;

  const result = await trail.execute(
    `SELECT title, filename FROM documents
      WHERE tenant_id = ?
        AND knowledge_base_id = ?
        AND kind = 'wiki'
        AND archived = 0
        AND path LIKE '/neurons/entities/%'
        AND title IS NOT NULL
        AND title != ''
      ORDER BY title COLLATE NOCASE ASC
      LIMIT ?`,
    [tenantId, kbId, MAX_ENTITIES],
  );

  const entities: EntityRef[] = (result.rows as Array<{ title: string; filename: string }>).map((r) => ({
    title: r.title,
    filename: r.filename,
  }));

  cache.set(key, { entities, expiresAt: Date.now() + TTL_MS });
  return entities;
}

/** Drop the cached entry for a KB. Called on candidate_approved. */
export function invalidateEntityCache(tenantId: string, kbId: string): void {
  cache.delete(cacheKey(tenantId, kbId));
}

// Long-lived subscription; module lifetime = process lifetime.
broadcaster.subscribe((event) => {
  if (event.type === 'candidate_approved') {
    invalidateEntityCache(event.tenantId, event.kbId);
  }
});
