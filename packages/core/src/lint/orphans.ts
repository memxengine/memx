import {
  documents,
  documentReferences,
  type TrailDatabase,
} from '@trail/db';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { LintFinding, LintOptions } from './types.js';

const DEFAULT_HUB_PAGES = ['overview.md', 'log.md'];

function stripMd(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

/**
 * Orphan detector — two flavours:
 *
 * 1. **Orphan Neurons**: wiki pages that cite zero sources via
 *    `document_references`. Something the compiler wrote but never backed
 *    up with provenance. Emits `cross-ref-suggestion` so the curator can
 *    link claims or archive the page.
 *
 * 2. **Orphan Sources**: source documents that nothing in the wiki cites.
 *    The source landed in the system but the LLM compiler never pulled
 *    anything from it — either the file is irrelevant, or the compile
 *    pipeline missed it and we should re-ingest. Emits `gap-detection`.
 *
 * Hub pages (overview.md, log.md) are exempt — they're structural entry
 * points, nothing cites them by design.
 *
 * Pure SQL. No LLM call. Safe to run on every queue read if we wanted,
 * cheap even on tens of thousands of documents.
 */
export async function detectOrphans(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  opts: LintOptions = {},
): Promise<{ scanned: number; findings: LintFinding[] }> {
  const hubPages = opts.hubPages ?? DEFAULT_HUB_PAGES;
  const findings: LintFinding[] = [];

  // ── Orphan Neurons ──────────────────────────────────────────────
  // Left join: every wiki doc with the count of refs originating from it.
  // Docs with zero refs are orphans.
  const wikiRows = await trail.db
    .select({
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
      path: documents.path,
      updatedAt: documents.updatedAt,
      version: documents.version,
      refCount: sql<number>`COUNT(${documentReferences.id})`.as('ref_count'),
    })
    .from(documents)
    .leftJoin(
      documentReferences,
      eq(documentReferences.wikiDocumentId, documents.id),
    )
    .where(
      and(
        eq(documents.kind, 'wiki'),
        eq(documents.knowledgeBaseId, kbId),
        eq(documents.tenantId, tenantId),
        eq(documents.archived, false),
        notInArray(documents.filename, hubPages),
      ),
    )
    .groupBy(documents.id)
    .all();

  for (const w of wikiRows) {
    if (w.refCount > 0) continue;
    const label = w.title ?? w.filename;
    findings.push({
      kind: 'cross-ref-suggestion',
      title: `Orphan Neuron: ${label}`,
      content: [
        `# Orphan Neuron: ${label}`,
        '',
        `The Neuron **${w.filename}** at \`${w.path}\` has no tracked citations back to any Source — either the compiler wrote it without linking evidence, or the references were lost.`,
        '',
        `Curator action: either link its claims to the Sources they came from, or archive the Neuron if its claims cannot be defended.`,
      ].join('\n'),
      // Include Neuron version in the fingerprint: a substantive rewrite
      // bumps doc.version → new fingerprint → old suppressions no longer
      // match, so a previously-dismissed orphan finding re-qualifies once
      // the page has actually changed. Pre-F90 candidates used a
      // version-less fingerprint (`lint:orphan-neuron:<id>`); those still
      // match themselves, so backfill idempotency is preserved.
      fingerprint: `lint:orphan-neuron:${w.id}:v${w.version}`,
      confidence: 0.7,
      details: {
        documentId: w.id,
        filename: w.filename,
        path: w.path,
        updatedAt: w.updatedAt,
      },
      actions: [
        {
          id: 'auto-link-sources',
          effect: 'auto-link-sources',
          args: { documentId: w.id },
          label: { en: 'Auto-link sources' },
          explanation: {
            en:
              `Ask the LLM to infer which Source documents [[${stripMd(w.filename)}|${label}]] ` +
              `most likely draws its claims from, then patch its frontmatter \`sources: [...]\` ` +
              `accordingly. The reference extractor picks that up and this alert resolves on ` +
              `the next lint run. If the LLM finds no plausible match you'll get a toast and ` +
              `the finding stays pending for manual linking.`,
          },
        },
        {
          id: 'link-sources',
          effect: 'acknowledge',
          args: { documentId: w.id },
          label: { en: 'Link manually' },
          explanation: {
            en:
              `Open [[${stripMd(w.filename)}|${label}]] in the Neurons tab and add ` +
              `\`sources: [...]\` to its frontmatter listing the Source filenames its claims ` +
              `came from. The reference extractor picks those up on save and this alert ` +
              `resolves on the next lint run. Nothing else is modified now — you do the ` +
              `linking yourself.`,
          },
        },
        {
          id: 'archive-neuron',
          effect: 'retire-neuron',
          args: { documentId: w.id },
          label: { en: `Archive "${label}"` },
          explanation: {
            en:
              `Archive [[${stripMd(w.filename)}|${label}]]. Pick this when the Neuron's claims ` +
              `cannot be defended — no Source to link, no independent verification. The page ` +
              `disappears from the Neurons list and every link pointing to it becomes a broken ` +
              `link until you clean them up. Reversible via the archived-documents tab.`,
          },
        },
        {
          id: 'dismiss',
          effect: 'reject',
          label: { en: 'Dismiss as false positive' },
          explanation: {
            en:
              `Discard this alert. Pick this when [[${stripMd(w.filename)}|${label}]] is ` +
              `meant to stand on its own without Source citations — an opinion page, a ` +
              `meta-note, a concept that the Trail considers axiomatic. Nothing changes. ` +
              `The alert won't re-fire unless the Neuron is rewritten.`,
          },
        },
      ],
    });
  }

  // ── Orphan Sources ──────────────────────────────────────────────
  // Sources that no wiki document cites.
  const sourceRows = await trail.db
    .select({
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
      path: documents.path,
      status: documents.status,
      fileType: documents.fileType,
      version: documents.version,
      refCount: sql<number>`COUNT(${documentReferences.id})`.as('ref_count'),
    })
    .from(documents)
    .leftJoin(
      documentReferences,
      eq(documentReferences.sourceDocumentId, documents.id),
    )
    .where(
      and(
        eq(documents.kind, 'source'),
        eq(documents.knowledgeBaseId, kbId),
        eq(documents.tenantId, tenantId),
        eq(documents.archived, false),
        eq(documents.status, 'ready'),
      ),
    )
    .groupBy(documents.id)
    .all();

  for (const s of sourceRows) {
    if (s.refCount > 0) continue;
    const label = s.title ?? s.filename;
    // Sources don't live under /neurons/<slug>/, so wrapping them in
    // [[wiki-link]] would produce a broken target — the admin's reader
    // can't open a source at that URL. Keep quotes only.
    void label;
    findings.push({
      kind: 'gap-detection',
      title: `Unused Source: ${label}`,
      content: [
        `# Unused Source: ${label}`,
        '',
        `The Source **${s.filename}** (${s.fileType}) was ingested and compiled, but no Neuron cites it.`,
        '',
        `Possible reasons:`,
        `- The compile pipeline found nothing worth extracting — archive the source if that's intentional.`,
        `- The pipeline missed it — consider re-ingesting.`,
        `- Compilation succeeded but dropped claim anchors — investigate the ingest logs.`,
      ].join('\n'),
      // Version bump on Source-orphan is rare (Sources are mostly
      // immutable) but including it keeps the format uniform across
      // detectors and opens the door to re-qualifying a finding after a
      // source is re-ingested.
      fingerprint: `lint:orphan-source:${s.id}:v${s.version}`,
      confidence: 0.6,
      details: {
        documentId: s.id,
        filename: s.filename,
        path: s.path,
        fileType: s.fileType,
      },
      actions: [
        {
          id: 'keep-source',
          effect: 'acknowledge',
          args: { documentId: s.id },
          label: { en: 'Keep for now' },
          explanation: {
            en:
              `Leave "${label}" in place — you plan to cite it in a future Neuron, or the ` +
              `compiler should eventually pick it up. Nothing changes; this alert will re-fire ` +
              `on the next lint run if the Source is still uncited.`,
          },
        },
        {
          id: 'archive-source',
          effect: 'retire-neuron',
          args: { documentId: s.id },
          label: { en: `Archive "${label}"` },
          explanation: {
            en:
              `Archive "${label}". Pick this when the Source turned out to be irrelevant or ` +
              `duplicative — nothing cites it and nothing will. The file disappears from the ` +
              `Sources list but stays on disk; reversible via the archived-documents tab.`,
          },
        },
        {
          id: 'dismiss',
          effect: 'reject',
          label: { en: 'Dismiss as false positive' },
          explanation: {
            en:
              `Discard this alert. Pick this when the Source IS cited but the reference ` +
              `extractor missed it — e.g. the frontmatter uses a different filename spelling. ` +
              `Nothing changes. Fixing the reference is a manual task in the Neuron editor.`,
          },
        },
      ],
    });
  }

  return { scanned: wikiRows.length + sourceRows.length, findings };
}
