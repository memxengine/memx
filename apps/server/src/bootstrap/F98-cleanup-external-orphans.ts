/**
 * F98 bootstrap cleanup — idempotent.
 *
 * Before F98, orphan-lint emitted `cross-ref-suggestion` candidates for
 * every Neuron with zero `document_references` rows. For Neurons whose
 * originating connector was external (buddy, mcp, chat, api), this was
 * always a false positive — their "source" lives outside Trail and no
 * amount of Auto-link-sources can succeed. F98 teaches the detector to
 * skip them, but doesn't retroactively clear the false-positive
 * candidates already in the queue. This bootstrap does.
 *
 * Runs once at every engine boot (cheap, idempotent): UPDATE pending
 * orphan-findings that target external-originated Neurons → status
 * 'rejected' with a system-attributed reason. Future lint passes won't
 * re-emit them (F98 forward-fix handles that).
 *
 * Safe to leave in place forever. After the first non-trivial run, the
 * UPDATE affects zero rows on subsequent boots.
 */
import { documents, queueCandidates, wikiEvents, type TrailDatabase } from '@trail/db';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { EXTERNAL_CONNECTORS } from '@trail/shared';

export async function cleanupExternalOrphans(trail: TrailDatabase): Promise<void> {
  // Step 1 — find every Neuron whose provenance tells us citations
  // aren't expected. Two disjoint signals:
  //   (a) originating candidate's connector is external (buddy, MCP,
  //       chat, api) — recorded at candidate-creation time (F95).
  //   (b) Neuron's own `documents.path` is in the external-reserved
  //       namespace (/neurons/sessions/, /neurons/queries/) — catches
  //       historical data ported via scripts that used the wrong
  //       candidate kind but correct path.
  // Either signal is enough. Union the two doc-id sets.
  const byConnector = await trail.db
    .select({ documentId: wikiEvents.documentId })
    .from(wikiEvents)
    .innerJoin(queueCandidates, eq(queueCandidates.id, wikiEvents.sourceCandidateId))
    .where(
      and(
        eq(wikiEvents.eventType, 'created'),
        inArray(
          sql`json_extract(${queueCandidates.metadata}, '$.connector')`,
          [...EXTERNAL_CONNECTORS],
        ),
      ),
    )
    .all();

  const byPath = await trail.db
    .select({ documentId: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.kind, 'wiki'),
        or(
          like(documents.path, '/neurons/sessions/%'),
          like(documents.path, '/neurons/queries/%'),
        ),
      ),
    )
    .all();

  const docIds = Array.from(
    new Set([...byConnector.map((r) => r.documentId), ...byPath.map((r) => r.documentId)]),
  );
  if (docIds.length === 0) return;

  // Step 2 — flip every pending orphan-finding targeting those Neurons
  // to rejected. The orphan-finding's target doc id lives in
  // metadata.documentId (set by detectOrphans in packages/core/src/
  // lint/orphans.ts); match on json_extract.
  // `reviewed_by` is an FK to users.id — leave null for system-driven
  // cleanups. The rejection_reason carries the "who/why" context so
  // audit trail isn't lost; it just isn't attributed to a fake user.
  const now = new Date().toISOString();
  const result = await trail.db
    .update(queueCandidates)
    .set({
      status: 'rejected',
      rejectionReason: 'F98 cleanup: external-originated Neuron, sources-less by design',
      resolvedAction: 'dismiss',
      reviewedAt: now,
      reviewedBy: null,
    })
    .where(
      and(
        eq(queueCandidates.status, 'pending'),
        eq(queueCandidates.kind, 'cross-ref-suggestion'),
        inArray(
          sql`json_extract(${queueCandidates.metadata}, '$.documentId')`,
          docIds,
        ),
      ),
    )
    .run();

  const count = (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
  if (count > 0) {
    console.log(
      `  F98 cleanup: dismissed ${count} orphan-finding${count === 1 ? '' : 's'} targeting external-originated Neurons`,
    );
  }
}
