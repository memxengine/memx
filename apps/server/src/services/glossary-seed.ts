/**
 * F102 — build the initial `/neurons/glossary.md` Neuron for a fresh KB.
 *
 * Seeds from `data/glossary.json` (the app's curated trail-terminology
 * dictionary that the /glossary admin panel renders). Every new KB starts
 * knowing what a Neuron, Source, Curator, etc. is in its primary language.
 * From there the compile-pipeline takes over: each ingested Source can
 * append domain-specific terms (NADA, øreakupunktur, CMS-connector, …)
 * via str_replace on this same Neuron.
 *
 * Frontmatter keeps `type: glossary` so F100 export and any future
 * type-based grouping can recognise it. `sources: []` is the honest
 * answer — the seed isn't drawn from a KB Source — and the orphan-lint
 * already exempts glossary.md from the missing-sources rule (see
 * packages/core/src/lint/orphans.ts DEFAULT_HUB_PAGES).
 */
import glossaryData from '../data/glossary.json' with { type: 'json' };

interface TermEntry {
  id: string;
  label: { en: string; da: string };
  definition: { en: string; da: string };
  relatedTerms?: string[];
}

interface GlossaryData {
  version: number;
  terms: TermEntry[];
}

/**
 * Build the markdown body for a newly-created KB's glossary Neuron.
 * Locale picks the label + definition language. Unknown locales fall
 * back to English since that's the glossary.json authoring language.
 */
export function buildSeedGlossary(locale: string | null | undefined): string {
  const lang: 'en' | 'da' = locale === 'da' ? 'da' : 'en';
  const data = glossaryData as GlossaryData;
  const today = new Date().toISOString().slice(0, 10);

  const header =
    lang === 'da'
      ? [
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
          'Fagtermer der er relevante for denne vidensbase. Pipelinen tilføjer og opdaterer automatisk når nye Kilder compile\'s.',
          '',
        ]
      : [
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
          'Domain terms relevant to this knowledge base. The compile pipeline adds and revises entries as new Sources are ingested.',
          '',
        ];

  const sections = data.terms.map((term) => {
    const label = term.label[lang] ?? term.label.en;
    const definition = term.definition[lang] ?? term.definition.en;
    return `## ${label}\n\n${definition}\n`;
  });

  return [...header, ...sections].join('\n');
}
