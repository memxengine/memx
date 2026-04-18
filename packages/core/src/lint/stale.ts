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

  // ISO-8601 with a fixed offset sorts lexicographically the same as it
  // sorts chronologically; pushing the `updatedAt < cutoff` check into SQL
  // means the engine never ships fresh docs over the wire just to throw
  // them out in JS — relevant once a KB has thousands of Neurons.
  const stale = await trail.db
    .select({
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
      path: documents.path,
      updatedAt: documents.updatedAt,
      version: documents.version,
    })
    .from(documents)
    .where(
      and(
        eq(documents.kind, 'wiki'),
        eq(documents.knowledgeBaseId, kbId),
        eq(documents.tenantId, tenantId),
        eq(documents.archived, false),
        notInArray(documents.filename, hubPages),
        lt(documents.updatedAt, cutoffIso),
      ),
    )
    .all();

  const findings: LintFinding[] = [];

  for (const d of stale) {
    const ageDays = Math.floor((Date.now() - new Date(d.updatedAt).getTime()) / (24 * 60 * 60 * 1000));
    const label = d.title ?? d.filename;
    findings.push({
      kind: 'gap-detection',
      title: `Stale Neuron: ${label} (${ageDays} days)`,
      content: [
        `# Stale Neuron: ${label}`,
        '',
        `The Neuron **${d.filename}** at \`${d.path}\` has not been updated in ${ageDays} days (last touched ${d.updatedAt}).`,
        '',
        `A Neuron staying silent this long is not automatically wrong, but it is the most likely to have drifted from what its Sources now say. Curator actions:`,
        '',
        `- Re-read the page; if still accurate, approve-to-touch it (a one-line edit resets the clock).`,
        `- Re-compile it against its current Sources.`,
        `- Archive it if the topic is obsolete.`,
      ].join('\n'),
      // Version-aware fingerprint: if the Neuron is rewritten the
      // staleness clock technically restarts anyway (updatedAt bumps),
      // but including version keeps the format consistent and means a
      // dismissed-stale finding doesn't need a full month to re-qualify
      // — a genuine edit re-surfaces it immediately if it's still old.
      fingerprint: `lint:stale-neuron:${d.id}:v${d.version}`,
      confidence: 0.5,
      details: {
        documentId: d.id,
        filename: d.filename,
        path: d.path,
        updatedAt: d.updatedAt,
        ageDays,
      },
      actions: [
        {
          id: 'still-relevant',
          effect: 'mark-still-relevant',
          args: { documentId: d.id },
          label: { en: 'Still relevant' },
          explanation: {
            en:
              `Confirm [[${d.filename.replace(/\.md$/i, '')}|${label}]] is still accurate. The ` +
              `update-timestamp gets bumped to today so the stale detector stops flagging it ` +
              `for another ${staleDays} days. Nothing else changes — the page content stays ` +
              `exactly as it is.`,
          },
        },
        {
          id: 'archive-neuron',
          effect: 'retire-neuron',
          args: { documentId: d.id },
          label: { en: 'Archive' },
          explanation: {
            en:
              `Archive [[${d.filename.replace(/\.md$/i, '')}|${label}]]. Pick this when the ` +
              `topic is obsolete — the Source it compiled from has been retracted, the domain ` +
              `has moved on, or the page is superseded by a newer Neuron. The page disappears ` +
              `from the Neurons list; reversible via the archived-documents tab.`,
          },
        },
        {
          id: 'dismiss',
          effect: 'reject',
          label: { en: 'Dismiss as false positive' },
          explanation: {
            en:
              `Discard this alert without touching the page. Pick this when ` +
              `[[${d.filename.replace(/\.md$/i, '')}|${label}]] is deliberately evergreen — a ` +
              `definition, a historical note, a reference page that simply doesn't change. ` +
              `The alert won't re-fire until the Neuron drifts past another staleness threshold.`,
          },
        },
      ],
    });
  }

  return { scanned: stale.length, findings };
}
