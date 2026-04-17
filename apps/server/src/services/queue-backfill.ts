/**
 * Queue-enrichment backfill — a one-shot (idempotent) pass over existing
 * pending candidates. Two jobs:
 *
 *  1. Populate `actions` on candidates that landed before the actions
 *     primitive existed. Lint findings carry stable fingerprints + a
 *     known `details` payload, so we can recompute the action set
 *     directly from the stored data — no LLM call needed. Contradiction,
 *     orphan Neuron, orphan source, stale Neuron all covered.
 *
 *  2. Pre-translate every pending candidate (title + content + actions)
 *     into every supported non-EN locale. Calls the translation service
 *     serially in the background so a freshly-rebooted admin finds every
 *     pending alert already in Danish. Skips candidates whose locale is
 *     already cached — safe to run on every startup.
 *
 * Sequential by design: the translation service spawns a claude -p
 * subprocess per candidate. Parallelising would stampede the CLI and
 * consume tokens fast. At ~25s per candidate and a typical queue of
 * 10-30 pending alerts, the full pass completes in under ten minutes
 * in the background.
 *
 * Runs after boot (not blocking startup). Env:
 *   - TRAIL_BACKFILL_LOCALES ("da,de,..." — default "da", "" disables)
 *   - TRAIL_BACKFILL_DELAY_SECONDS (default 30 — wait after boot before
 *     starting, so normal traffic isn't competing with the CLI for
 *     handles on the first minute)
 */
import { queueCandidates, documents, type TrailDatabase } from '@trail/db';
import { and, eq, isNull, like, or } from 'drizzle-orm';
import type { CandidateAction, QueueCandidate } from '@trail/shared';
import { ensureCandidateInLocale } from './translation.js';

const LOCALES_RAW = process.env.TRAIL_BACKFILL_LOCALES ?? 'da';
const BACKFILL_LOCALES: Array<'en' | 'da'> = LOCALES_RAW.split(',')
  .map((s) => s.trim())
  .filter((s): s is 'en' | 'da' => s === 'da');
const INITIAL_DELAY_MS = Number(process.env.TRAIL_BACKFILL_DELAY_SECONDS ?? 30) * 1000;

export function startQueueBackfill(trail: TrailDatabase): () => void {
  let stopped = false;

  const timer = setTimeout(() => {
    if (stopped) return;
    void run(trail).catch((err) => {
      console.error('[queue-backfill] run failed:', err);
    });
  }, INITIAL_DELAY_MS);

  console.log(
    `  queue-backfill: scheduled (delay ${Math.round(INITIAL_DELAY_MS / 1000)}s, locales=${BACKFILL_LOCALES.join(',') || 'none'})`,
  );

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function run(trail: TrailDatabase): Promise<void> {
  const t0 = Date.now();
  // Step 1: enrich candidates that have a recognised lint fingerprint but
  // no actions populated. Pure SQL + rebuilt action set.
  const enriched = await enrichActionsFromFingerprints(trail);
  if (enriched > 0) {
    console.log(`[queue-backfill] enriched ${enriched} candidate${enriched === 1 ? '' : 's'} with rich actions`);
  }

  // Step 2: pre-translate every pending candidate to every configured
  // non-EN locale. Serial so the CLI subprocess doesn't fan out.
  //
  // We iterate *all* pending candidates and delegate the "is anything
  // missing?" check to ensureCandidateInLocale — it looks at title,
  // content, AND every action's label/explanation, and short-circuits
  // when nothing's missing. An earlier optimisation that filtered on the
  // `translations` column alone was too coarse: it skipped candidates
  // whose title had been translated by one pass but whose actions were
  // added LATER by the enrichment step in the same backfill run.
  let translated = 0;
  for (const locale of BACKFILL_LOCALES) {
    const pending = await listPendingCandidates(trail);
    for (const p of pending) {
      try {
        await ensureCandidateInLocale(trail, p.tenantId, p.id, locale);
        translated += 1;
      } catch (err) {
        console.error(`[queue-backfill] translate ${p.id} to ${locale} failed:`, err);
      }
    }
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (translated > 0 || enriched > 0) {
    console.log(
      `[queue-backfill] done: ${enriched} enriched, ${translated} translations populated in ${elapsed}s`,
    );
  }
}

/**
 * Walk every pending candidate whose metadata carries a `lintFingerprint`
 * starting with `lint:` AND has null actions, and attach the right action
 * set based on the fingerprint prefix. Returns the number of rows updated.
 *
 * The action sets are kept in sync with the detector source-of-truth
 * (packages/core/src/lint/*.ts). Add a new detector → add a branch here.
 */
async function enrichActionsFromFingerprints(trail: TrailDatabase): Promise<number> {
  const rows = await trail.db
    .select({
      id: queueCandidates.id,
      tenantId: queueCandidates.tenantId,
      title: queueCandidates.title,
      metadata: queueCandidates.metadata,
    })
    .from(queueCandidates)
    .where(
      and(
        eq(queueCandidates.status, 'pending'),
        isNull(queueCandidates.actions),
        or(
          like(queueCandidates.metadata, '%"lintFingerprint":"lint:orphan-neuron:%'),
          like(queueCandidates.metadata, '%"lintFingerprint":"lint:orphan-source:%'),
          like(queueCandidates.metadata, '%"lintFingerprint":"lint:stale-neuron:%'),
          like(queueCandidates.metadata, '%"lintFingerprint":"lint:contradiction:%'),
        ),
      ),
    )
    .all();

  let updated = 0;
  for (const row of rows) {
    const actions = await buildActionsFromMetadata(trail, row as EnrichCandidate);
    if (!actions) continue;
    await trail.db
      .update(queueCandidates)
      .set({ actions: JSON.stringify(actions) })
      .where(eq(queueCandidates.id, row.id))
      .run();
    updated += 1;
  }
  return updated;
}

interface EnrichCandidate {
  id: string;
  tenantId: string;
  title: string;
  metadata: string | null;
}

async function buildActionsFromMetadata(
  trail: TrailDatabase,
  row: EnrichCandidate,
): Promise<CandidateAction[] | null> {
  const meta = row.metadata ? safeParseJson(row.metadata) : null;
  const fp = typeof meta?.lintFingerprint === 'string' ? meta.lintFingerprint : '';

  if (fp.startsWith('lint:orphan-neuron:')) {
    const docId = typeof meta?.documentId === 'string' ? meta.documentId : null;
    if (!docId) return null;
    const l = await labelFor(trail, docId);
    return orphanNeuronActions(docId, l);
  }
  if (fp.startsWith('lint:orphan-source:')) {
    const docId = typeof meta?.documentId === 'string' ? meta.documentId : null;
    if (!docId) return null;
    const l = await labelFor(trail, docId);
    return orphanSourceActions(docId, l.label);
  }
  if (fp.startsWith('lint:stale-neuron:')) {
    const docId = typeof meta?.documentId === 'string' ? meta.documentId : null;
    if (!docId) return null;
    const l = await labelFor(trail, docId);
    return staleNeuronActions(docId, l);
  }
  if (fp.startsWith('lint:contradiction:')) {
    const newId = typeof meta?.newDocumentId === 'string' ? meta.newDocumentId : null;
    const existingId = typeof meta?.existingDocumentId === 'string' ? meta.existingDocumentId : null;
    if (!newId || !existingId) return null;
    const [n, e] = await Promise.all([labelFor(trail, newId), labelFor(trail, existingId)]);
    return contradictionActions(newId, existingId, n, e);
  }
  return null;
}

interface DocLabel {
  /** Display text, title preferred over filename. */
  label: string;
  /** Wiki-link slug — filename minus .md — for building `[[slug|display]]`. */
  slug: string;
}

async function labelFor(trail: TrailDatabase, docId: string): Promise<DocLabel> {
  const row = await trail.db
    .select({ title: documents.title, filename: documents.filename })
    .from(documents)
    .where(eq(documents.id, docId))
    .get();
  const filename = row?.filename ?? 'unknown';
  return {
    label: row?.title ?? filename,
    slug: filename.replace(/\.md$/i, ''),
  };
}

function wikiLink(d: DocLabel): string {
  return `[[${d.slug}|${d.label}]]`;
}

function orphanNeuronActions(docId: string, d: DocLabel): CandidateAction[] {
  const link = wikiLink(d);
  return [
    {
      id: 'link-sources',
      effect: 'acknowledge',
      args: { documentId: docId },
      label: { en: 'Link to sources' },
      explanation: {
        en:
          `Open ${link} in the Neurons tab and add \`sources: [...]\` to its frontmatter ` +
          `listing the Source filenames its claims came from. The reference extractor picks ` +
          `those up on save and this alert resolves on the next lint pass. Nothing else is ` +
          `modified now — you do the linking yourself.`,
      },
    },
    {
      id: 'archive-neuron',
      effect: 'retire-neuron',
      args: { documentId: docId },
      label: { en: `Archive "${d.label}"` },
      explanation: {
        en:
          `Archive ${link}. Pick this when the Neuron's claims cannot be defended — ` +
          `no Source to link, no independent verification. The page disappears from the ` +
          `Neurons list and every link pointing to it becomes a broken link until you ` +
          `clean them up. Reversible via the archived-documents tab.`,
      },
    },
    {
      id: 'dismiss',
      effect: 'reject',
      label: { en: 'Dismiss as false positive' },
      explanation: {
        en:
          `Discard this alert. Pick this when ${link} is meant to stand on its own ` +
          `without Source citations — an opinion page, a meta-note, a concept that the ` +
          `Trail considers axiomatic. Nothing changes. The alert won't re-fire unless the ` +
          `Neuron is rewritten.`,
      },
    },
  ];
}

function orphanSourceActions(docId: string, label: string): CandidateAction[] {
  return [
    {
      id: 'keep-source',
      effect: 'acknowledge',
      args: { documentId: docId },
      label: { en: 'Keep for now' },
      explanation: {
        en:
          `Leave "${label}" in place — you plan to cite it in a future Neuron, or the ` +
          `compiler should eventually pick it up. Nothing changes; this alert will re-fire ` +
          `on the next lint pass if the Source is still uncited.`,
      },
    },
    {
      id: 'archive-source',
      effect: 'retire-neuron',
      args: { documentId: docId },
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
  ];
}

function staleNeuronActions(docId: string, d: DocLabel): CandidateAction[] {
  const link = wikiLink(d);
  return [
    {
      id: 'still-relevant',
      effect: 'mark-still-relevant',
      args: { documentId: docId },
      label: { en: 'Still relevant' },
      explanation: {
        en:
          `Confirm ${link} is still accurate. The update-timestamp gets bumped to ` +
          `today so the stale detector stops flagging it. Nothing else changes — the page ` +
          `content stays exactly as it is.`,
      },
    },
    {
      id: 'archive-neuron',
      effect: 'retire-neuron',
      args: { documentId: docId },
      label: { en: `Archive "${d.label}"` },
      explanation: {
        en:
          `Archive ${link}. Pick this when the topic is obsolete — the Source it ` +
          `compiled from has been retracted, the domain has moved on, or the page is ` +
          `superseded by a newer Neuron. The page disappears from the Neurons list; ` +
          `reversible via the archived-documents tab.`,
      },
    },
    {
      id: 'dismiss',
      effect: 'reject',
      label: { en: 'Dismiss as false positive' },
      explanation: {
        en:
          `Discard this alert without touching ${link}. Pick this when the Neuron is ` +
          `deliberately evergreen — a definition, a historical note, a reference page ` +
          `that simply doesn't change.`,
      },
    },
  ];
}

function contradictionActions(
  newId: string,
  existingId: string,
  n: DocLabel,
  e: DocLabel,
): CandidateAction[] {
  const linkNew = wikiLink(n);
  const linkExisting = wikiLink(e);
  return [
    {
      id: 'retire-a',
      effect: 'retire-neuron',
      args: { documentId: newId },
      label: { en: `Retire "${n.label}"` },
      explanation: {
        en:
          `Archive ${linkNew} and keep ${linkExisting}. Pick this if the existing page was ` +
          `already correct and the new one introduced a wrong claim. The page disappears from ` +
          `the Neurons list; every link pointing to it becomes a broken link until you clean ` +
          `them up.`,
      },
    },
    {
      id: 'retire-b',
      effect: 'retire-neuron',
      args: { documentId: existingId },
      label: { en: `Retire "${e.label}"` },
      explanation: {
        en:
          `Archive ${linkExisting} and keep ${linkNew}. Pick this if the new claim supersedes ` +
          `the existing one — a better source, a correction, a newer version. The existing ` +
          `page disappears; any link pointing to it becomes a broken link.`,
      },
    },
    {
      id: 'reconcile',
      effect: 'acknowledge',
      label: { en: 'Reconcile manually' },
      explanation: {
        en:
          `Close this alert and fix the conflict yourself. Neither page is archived — open ` +
          `${linkNew} and ${linkExisting}, then edit them so they agree. Pick this when the ` +
          `truth is somewhere in between and both pages need nuance.`,
      },
    },
    {
      id: 'dismiss',
      effect: 'reject',
      label: { en: 'Dismiss as false positive' },
      explanation: {
        en:
          `Discard this alert. Pick this when the two passages don't actually contradict ` +
          `— the detector was confused by different phrasing or a narrower/wider focus. ` +
          `Nothing changes in your Trail.`,
      },
    },
  ];
}

/**
 * List every pending candidate in the database. The translation pass
 * delegates the "is anything missing?" decision to ensureCandidateInLocale
 * which checks both the translations column AND per-action label/
 * explanation — a catch-all filter here would miss the mixed state where
 * title is cached but actions aren't.
 */
async function listPendingCandidates(
  trail: TrailDatabase,
): Promise<Array<Pick<QueueCandidate, 'id' | 'tenantId'>>> {
  return trail.db
    .select({
      id: queueCandidates.id,
      tenantId: queueCandidates.tenantId,
    })
    .from(queueCandidates)
    .where(eq(queueCandidates.status, 'pending'))
    .all();
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}
