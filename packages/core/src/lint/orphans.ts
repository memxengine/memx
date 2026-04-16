import {
  documents,
  documentReferences,
  type TrailDatabase,
} from '@trail/db';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { LintFinding, LintOptions } from './types.js';

const DEFAULT_HUB_PAGES = ['overview.md', 'log.md'];

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
    findings.push({
      kind: 'cross-ref-suggestion',
      title: `Orphan Neuron: ${w.title ?? w.filename}`,
      content: [
        `# Orphan Neuron: ${w.title ?? w.filename}`,
        '',
        `The Neuron **${w.filename}** at \`${w.path}\` has no tracked citations back to any Source — either the compiler wrote it without linking evidence, or the references were lost.`,
        '',
        `Curator action: either link its claims to the Sources they came from, or archive the Neuron if its claims cannot be defended.`,
      ].join('\n'),
      fingerprint: `lint:orphan-neuron:${w.id}`,
      confidence: 0.7,
      details: {
        documentId: w.id,
        filename: w.filename,
        path: w.path,
        updatedAt: w.updatedAt,
      },
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
    findings.push({
      kind: 'gap-detection',
      title: `Unused Source: ${s.title ?? s.filename}`,
      content: [
        `# Unused Source: ${s.title ?? s.filename}`,
        '',
        `The Source **${s.filename}** (${s.fileType}) was ingested and compiled, but no Neuron cites it.`,
        '',
        `Possible reasons:`,
        `- The compile pipeline found nothing worth extracting — archive the source if that's intentional.`,
        `- The pipeline missed it — consider re-ingesting.`,
        `- Compilation succeeded but dropped claim anchors — investigate the ingest logs.`,
      ].join('\n'),
      fingerprint: `lint:orphan-source:${s.id}`,
      confidence: 0.6,
      details: {
        documentId: s.id,
        filename: s.filename,
        path: s.path,
        fileType: s.fileType,
      },
    });
  }

  return { scanned: wikiRows.length + sourceRows.length, findings };
}
