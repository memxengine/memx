import { documents, type TrailDatabase } from '@trail/db';
import { and, eq, lt, notInArray } from 'drizzle-orm';
import type { LintFinding, LintOptions } from './types.js';

const DEFAULT_STALE_DAYS = 90;
const DEFAULT_HUB_PAGES = ['overview.md', 'log.md'];

/**
 * Stale detector — Neurons that have not been touched in `staleDays` days.
 * Old pages are not automatically wrong, but in a living knowledge base
 * they are the most likely to have drifted from the current state of the
 * sources they compile. We emit them as `gap-detection` candidates so the
 * curator can re-verify, retire, or accept "yes this is still valid".
 *
 * Hub pages (overview.md, log.md) are skipped — the log naturally tails
 * ancient entries, and the overview is regenerated on demand.
 *
 * Sources are excluded on purpose: "stale source" is not a meaningful
 * signal. Sources are immutable artifacts; whether a source is stale is a
 * judgement about the world, not the file.
 */
export async function detectStale(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  opts: LintOptions = {},
): Promise<{ scanned: number; findings: LintFinding[] }> {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const hubPages = opts.hubPages ?? DEFAULT_HUB_PAGES;

  const cutoffMs = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Bulk scan — a plain `updatedAt < cutoff` comparison on ISO-8601 strings
  // works because the engine writes all timestamps in Zulu/UTC with the
  // same offset, so lexicographic order matches chronological order.
  const all = await trail.db
    .select({
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
      path: documents.path,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.kind, 'wiki'),
        eq(documents.knowledgeBaseId, kbId),
        eq(documents.tenantId, tenantId),
        eq(documents.archived, false),
        notInArray(documents.filename, hubPages),
      ),
    )
    .all();

  const findings: LintFinding[] = [];
  const stale = all.filter((d) => d.updatedAt < cutoffIso);

  for (const d of stale) {
    const ageDays = Math.floor((Date.now() - new Date(d.updatedAt).getTime()) / (24 * 60 * 60 * 1000));
    findings.push({
      kind: 'gap-detection',
      title: `Stale Neuron: ${d.title ?? d.filename} (${ageDays} days)`,
      content: [
        `# Stale Neuron: ${d.title ?? d.filename}`,
        '',
        `The Neuron **${d.filename}** at \`${d.path}\` has not been updated in ${ageDays} days (last touched ${d.updatedAt}).`,
        '',
        `A Neuron staying silent this long is not automatically wrong, but it is the most likely to have drifted from what its Sources now say. Curator actions:`,
        '',
        `- Re-read the page; if still accurate, approve-to-touch it (a one-line edit resets the clock).`,
        `- Re-compile it against its current Sources.`,
        `- Archive it if the topic is obsolete.`,
      ].join('\n'),
      fingerprint: `lint:stale-neuron:${d.id}`,
      confidence: 0.5,
      details: {
        documentId: d.id,
        filename: d.filename,
        path: d.path,
        updatedAt: d.updatedAt,
        ageDays,
      },
    });
  }

  return { scanned: all.length, findings };
}
