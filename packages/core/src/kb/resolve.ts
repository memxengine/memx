/**
 * F135 — resolve a KB identifier (slug or UUID) to its canonical UUID.
 *
 * Every HTTP entry point accepts either form so shared URLs like
 * `/kb/sanne-andersen/queue` resolve alongside `/kb/<uuid>/queue`.
 * Internally the engine keeps operating on UUIDs — this helper is the
 * single resolver that sits at the HTTP boundary.
 *
 * Tenant-scoped: a slug only resolves within the caller's tenant. Two
 * tenants can hold the same slug without collision (the DB's unique
 * index on `slug` is per-tenant, see packages/db/src/schema.ts).
 */
import { and, eq } from 'drizzle-orm';
import { knowledgeBases, type TrailDatabase } from '@trail/db';

// UUID-shape detector. We check the shape, not the value — so a bogus
// string that happens to look like a UUID still gets routed to the
// primary-key path and fails with the same 404 as an unknown slug.
// Either a 32-hex with dashes (canonical) or 32-hex compact.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export async function resolveKbId(
  trail: TrailDatabase,
  tenantId: string,
  identifier: string,
): Promise<string | null> {
  if (!identifier) return null;
  const column = looksLikeUuid(identifier) ? knowledgeBases.id : knowledgeBases.slug;
  const row = await trail.db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(column, identifier), eq(knowledgeBases.tenantId, tenantId)))
    .get();
  return row?.id ?? null;
}
