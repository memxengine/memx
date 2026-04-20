/**
 * F141 — access-tracker service.
 *
 * Fire-and-forget recorder for Neuron reads. Call sites (documents GET,
 * chat context-builder, MCP read tool, admin reader) invoke
 * `recordAccess(trail, { ... })` without awaiting; the write goes into
 * the append-only `document_access` table. A nightly rollup
 * (access-rollup.ts, wired into the F32 lint-scheduler) collapses raw
 * rows into the `document_access_rollup` aggregate that consumers
 * read for usage-weighting.
 *
 * Key design choices:
 *   - void return, internal .catch() — callers never need to guard the
 *     call. If the tracker errors, we log and move on; telemetry must
 *     never break a user-facing request.
 *   - No aggregation in the hot path. Consumers read the rollup, not
 *     `document_access` directly — one row per read keeps the insert
 *     path trivial.
 *   - Respects the per-KB `knowledge_bases.track_access` toggle. An
 *     early lookup skips the insert entirely when a KB has opted out.
 *     Cached-in-memory so the 1-row-per-read cost stays constant.
 */
import { knowledgeBases, documentAccess, type TrailDatabase } from '@trail/db';
import { eq } from 'drizzle-orm';

export type AccessSource =
  | 'chat'
  | 'api'
  | 'mcp'
  | 'admin-reader'
  | 'graph-click';

export type AccessActorKind = 'user' | 'llm' | 'system';

export interface RecordAccessArgs {
  tenantId: string;
  knowledgeBaseId: string;
  documentId: string;
  source: AccessSource;
  actorKind: AccessActorKind;
}

// Per-KB tracking preference — cached in memory to avoid a SELECT on
// every recordAccess. 60s TTL so a flip from admin Settings propagates
// within a minute. Cheap, per-tenant-scoped keys.
const TRACK_CACHE_TTL_MS = 60_000;
const trackCache = new Map<string, { value: boolean; expiresAt: number }>();

async function isTrackingEnabled(trail: TrailDatabase, kbId: string): Promise<boolean> {
  const hit = trackCache.get(kbId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const row = await trail.db
    .select({ trackAccess: knowledgeBases.trackAccess })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, kbId))
    .get();
  // Default to on — a KB that doesn't exist shouldn't error here
  // (callsite will fail on something more useful); telemetry off-path
  // just silently skips.
  const value = row?.trackAccess ?? true;
  trackCache.set(kbId, { value, expiresAt: Date.now() + TRACK_CACHE_TTL_MS });
  return value;
}

/** Invalidate the per-KB track-access cache — called from the PATCH
 *  /knowledge-bases handler when the toggle flips so the new value
 *  takes effect immediately rather than waiting for the 60s TTL. */
export function invalidateTrackAccessCache(kbId: string): void {
  trackCache.delete(kbId);
}

/**
 * Record a read. Fire-and-forget — caller does NOT await. Errors are
 * logged but never thrown.
 */
export function recordAccess(trail: TrailDatabase, args: RecordAccessArgs): void {
  // 'system' reads are skipped (bootstrap passes, automated cleanup,
  // lint detectors). They don't represent user-triggered interest and
  // would inflate usage_weight for whatever Neurons the automation
  // happens to touch. 'user' and 'llm' are both valid signal — a
  // cc-agent reading a Neuron via MCP is counted (agent-on-behalf-of-
  // user), but compiler-during-ingest is filtered at the MCP tool
  // call-site via userId check (see apps/mcp/src/index.ts read tool).
  if (args.actorKind === 'system') return;

  void (async () => {
    try {
      const enabled = await isTrackingEnabled(trail, args.knowledgeBaseId);
      if (!enabled) return;

      await trail.db
        .insert(documentAccess)
        .values({
          id: `acc_${crypto.randomUUID().slice(0, 12)}`,
          tenantId: args.tenantId,
          knowledgeBaseId: args.knowledgeBaseId,
          documentId: args.documentId,
          source: args.source,
          actorKind: args.actorKind,
        })
        .run();
    } catch (err) {
      // Telemetry is never worth crashing a request path for. Log the
      // first-line cause so the pattern is visible if something breaks
      // but keep the noise low (no stack).
      console.warn(
        '[access-tracker] insert failed:',
        err instanceof Error ? err.message : err,
      );
    }
  })();
}
