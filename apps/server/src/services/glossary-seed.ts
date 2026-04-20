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

/** Signatures the bootstrap uses to detect the old polluted seed and
 *  replace it with the empty template. Trail-APP terminology entries
 *  the first F102 ship mis-seeded from data/glossary.json. Both
 *  languages' labels listed so cleanup works regardless of kb.language.
 *
 *  Threshold: ≥2 of these must appear in the content to count as
 *  polluted. Single-match would false-positive a crypto-glossary that
 *  legitimately defines "## Fingeraftryk" (fingerprint) as a domain
 *  term — but no domain glossary would emit Neuron+Kurator+Queue all
 *  together. The 2-marker threshold draws a clean line. */
export const POLLUTED_SEED_MARKERS = [
  // Danish
  '## Neuron',
  '## Kilde',
  '## Kurator',
  '## Kurations-kø',
  '## Kandidat',
  '## Handling',
  '## Fingeraftryk',
  // English
  '## Source',
  '## Curator',
  '## Curation Queue',
  '## Candidate',
  '## Action',
  '## Fingerprint',
];
export const POLLUTED_MARKER_THRESHOLD = 2;

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
