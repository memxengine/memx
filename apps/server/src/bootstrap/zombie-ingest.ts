/**
 * Recover from unclean shutdowns.
 *
 * Ingest jobs are in-memory (`services/ingest.ts` tracks `activeIngests` as a
 * Map) and the document row carries `status='processing'` for the duration.
 * When the engine dies mid-ingest — SIGTERM, crash, machine sleep, whatever —
 * the Map disappears but the row is still `processing` forever. Subsequent
 * boots never retry, so the document looks stuck from the admin's POV.
 *
 * Cheap recovery: at startup, flip every `kind='source'` row that's been in
 * `processing` for more than ZOMBIE_THRESHOLD_MS to `failed` with an
 * explanatory error. The curator can re-upload or delete. We do NOT try to
 * auto-restart the ingest — the LLM compile is expensive and the failure
 * mode might repeat; let a human decide.
 */
import { documents, type TrailDatabase } from '@trail/db';
import { and, eq, lt } from 'drizzle-orm';

const ZOMBIE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes — ingest usually finishes in 1-3min

export async function recoverZombieIngests(trail: TrailDatabase): Promise<void> {
  const cutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_MS).toISOString();

  const zombies = await trail.db
    .select({ id: documents.id, filename: documents.filename, updatedAt: documents.updatedAt })
    .from(documents)
    .where(and(eq(documents.status, 'processing'), lt(documents.updatedAt, cutoff)))
    .all();

  if (zombies.length === 0) return;

  await trail.db
    .update(documents)
    .set({
      status: 'failed',
      errorMessage: 'Ingest interrupted — engine restarted before compile finished. Re-upload to retry.',
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(documents.status, 'processing'), lt(documents.updatedAt, cutoff)))
    .run();

  console.log(
    `  recovered ${zombies.length} zombie ingest${zombies.length === 1 ? '' : 's'}: ${zombies
      .map((z) => z.filename)
      .slice(0, 3)
      .join(', ')}${zombies.length > 3 ? '…' : ''}`,
  );
}
