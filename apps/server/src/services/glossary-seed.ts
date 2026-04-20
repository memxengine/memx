/**
 * F102 — build the initial `/neurons/glossary.md` Neuron for a fresh KB.
 *
 * The seed is an EMPTY TEMPLATE — header + one-line explanation — and
 * nothing else. The compile-pipeline is what fills this Neuron up over
 * time, one entry per domain-specific fagterm the LLM encounters in a
 * Source (NADA, øreakupunktur, fredsknap for Sanne; CMS-connector,
 * ingest-pipeline for trail-dev; and so on).
 *
 * Explicitly NOT seeded from `data/glossary.json` — that file holds the
 * TRAIL APP terminology (Neuron, Source, Curator, …) which has a home
 * in the global `/glossary` admin panel. Pouring it into every KB's
 * domain glossary was a misread of the F102 plan (caught by Christian
 * before it did any damage): Sanne doesn't need "## Curator" in her
 * akupunktur-ordliste, she needs "## NADA".
 *
 * Frontmatter keeps `type: glossary` so F100 export and any future
 * type-based grouping can recognise it. `sources: []` is honest — the
 * stub isn't drawn from a KB Source — and the orphan-lint already
 * exempts glossary.md from the missing-sources rule (see
 * packages/core/src/lint/orphans.ts DEFAULT_HUB_PAGES).
 */

/** Signature the bootstrap uses to detect the old polluted seed and
 *  replace it with the empty template. `## Fingeraftryk` is the DA
 *  label for "Fingerprint" (trail-app terminology) — it has no reason
 *  to appear in any domain glossary the pipeline would build. Matching
 *  presence of either language's signature is enough. */
export const POLLUTED_SEED_MARKERS = ['## Fingeraftryk', '## Fingerprint'];

/**
 * Build the empty-template markdown body for a newly-created KB's
 * glossary Neuron. Locale picks the header language; unknown locales
 * fall back to English.
 */
export function buildSeedGlossary(locale: string | null | undefined): string {
  const lang: 'en' | 'da' = locale === 'da' ? 'da' : 'en';
  const today = new Date().toISOString().slice(0, 10);

  if (lang === 'da') {
    return [
      '---',
      'title: Ordliste',
      'type: glossary',
      'tags: [ordliste, terminologi]',
      `date: ${today}`,
      'sources: []',
      '---',
      '',
      '# Ordliste',
      '',
      'Domæne-specifikke fagtermer fra denne vidensbase. Ingen endnu — pipelinen tilføjer entries efterhånden som Kilder compile\'s, og fagtermer der optræder i flere Kilder får skærpede definitioner over tid.',
      '',
    ].join('\n');
  }

  return [
    '---',
    'title: Glossary',
    'type: glossary',
    'tags: [glossary, terminology]',
    `date: ${today}`,
    'sources: []',
    '---',
    '',
    '# Glossary',
    '',
    'Domain-specific terms from this knowledge base. None yet — the compile pipeline adds entries as Sources are ingested, and terms that recur across Sources get their definitions refined over time.',
    '',
  ].join('\n');
}
