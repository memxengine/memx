import { documents, type TrailDatabase } from '@trail/db';
import { and, eq, like } from 'drizzle-orm';
import {
  HEURISTIC_PATH,
  HEURISTIC_FADED_THRESHOLD,
  computeConfidence,
  isPinned,
} from '@trail/shared';
import type { LintFinding, LintOptions } from './types.js';

/**
 * F139 — heuristic decay detector.
 *
 * A heuristic Neuron that hasn't been touched or pinned in long enough
 * that its confidence has crossed the faded threshold (< 0.3 by default)
 * is flagged as a candidate for either re-pinning, re-editing, or
 * archiving. Pure SQL + in-memory confidence computation — no LLM call.
 *
 * Emitted as `gap-detection` kind because the semantic fit is the same:
 * "this Neuron has drifted from what the curator would assert today."
 * The existing queue/admin UIs handle gap-detection already; no new
 * candidate kind needed.
 *
 * Idempotent via fingerprint — re-running the pass against an already-
 * flagged heuristic skips emission (F17 queue-dedup). The fingerprint
 * includes the document version so a genuine rewrite requalifies a
 * previously-dismissed finding.
 */
export async function detectFadedHeuristics(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  _opts: LintOptions = {},
): Promise<{ scanned: number; findings: LintFinding[] }> {
  const rows = await trail.db
    .select({
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
      path: documents.path,
      content: documents.content,
      updatedAt: documents.updatedAt,
      version: documents.version,
    })
    .from(documents)
    .where(
      and(
        eq(documents.knowledgeBaseId, kbId),
        eq(documents.tenantId, tenantId),
        eq(documents.kind, 'wiki'),
        eq(documents.archived, false),
        like(documents.path, `${HEURISTIC_PATH}%`),
      ),
    )
    .all();

  const findings: LintFinding[] = [];
  let scanned = 0;
  for (const r of rows) {
    scanned += 1;
    const pinned = isPinned(r.content);
    if (pinned) continue; // pinned heuristics never fade
    const confidence = computeConfidence(r.updatedAt, pinned);
    if (confidence >= HEURISTIC_FADED_THRESHOLD) continue;

    const label = r.title ?? r.filename;
    findings.push({
      kind: 'gap-detection',
      title: `Faded heuristic: ${label}`,
      content: [
        `# Faded heuristic: ${label}`,
        '',
        `The heuristic Neuron **${r.filename}** has not been touched since \`${r.updatedAt}\` and its confidence has fallen to ${confidence.toFixed(
          1,
        )}. Below the faded threshold (${HEURISTIC_FADED_THRESHOLD}) it's excluded from chat context so chat answers don't lean on decision-rules that may no longer reflect how you think.`,
        '',
        `Curator action: either **re-affirm it** (edit or open the Neuron to refresh its last-touched timestamp), **pin it** (add \`pinned: true\` to frontmatter so it never decays again), or **archive it** (the heuristic no longer applies).`,
      ].join('\n'),
      // Version-aware fingerprint: a genuine rewrite (bumps doc.version)
      // refreshes the confidence AND produces a new fingerprint, so a
      // previously-dismissed finding requalifies once the Neuron has
      // actually changed.
      fingerprint: `lint:heuristic-faded:${r.id}:v${r.version}`,
      confidence: 0.7,
      details: {
        documentId: r.id,
        filename: r.filename,
        path: r.path,
        heuristicConfidence: confidence,
        updatedAt: r.updatedAt,
      },
    });
  }

  return { scanned, findings };
}
