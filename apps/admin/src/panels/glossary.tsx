/**
 * Glossary page — single-screen dictionary of every Trail system term.
 *
 * Flat alphabetical list in the active locale. Related-term chips at the
 * bottom of each entry link to anchors within the same page. No search
 * box in v1; the list is short enough to scan and browser Cmd+F works
 * fine on monospace ids.
 */
import { useMemo } from 'preact/hooks';
import { bilingual, t, useLocale } from '../lib/i18n';
import { useGlossary, type GlossaryTerm } from '../lib/glossary';
import { CenteredLoader } from '../components/centered-loader';

export function GlossaryPanel() {
  const locale = useLocale();
  const glossary = useGlossary();

  const sorted = useMemo(() => {
    if (!glossary) return [];
    return [...glossary.terms].sort((a, b) =>
      bilingual(a.label, locale).localeCompare(bilingual(b.label, locale), locale),
    );
  }, [glossary, locale]);

  return (
    <div class="page-shell">
      <header class="mb-8">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">{t('glossary.title')}</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">{t('glossary.subtitle')}</p>
      </header>

      {!glossary ? <CenteredLoader /> : null}

      <ul class="space-y-6">
        {sorted.map((term) => (
          <GlossaryEntry key={term.id} term={term} />
        ))}
      </ul>
    </div>
  );
}

function GlossaryEntry({ term }: { term: GlossaryTerm }) {
  const locale = useLocale();
  return (
    <li id={term.id} class="border-l-2 border-[color:var(--color-accent)]/40 pl-4">
      <h2 class="text-lg font-semibold mb-1">
        {bilingual(term.label, locale)}
        <code class="ml-2 text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
          {term.id}
        </code>
      </h2>
      <p class="text-sm text-[color:var(--color-fg-muted)] leading-relaxed">
        {bilingual(term.definition, locale)}
      </p>
      {term.relatedTerms && term.relatedTerms.length > 0 ? (
        <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
          <span class="text-[color:var(--color-fg-subtle)]">{t('glossary.seeAlso')}:</span>
          {term.relatedTerms.map((rel) => (
            <a
              key={rel}
              href={`#${rel}`}
              class="px-1.5 py-0.5 rounded border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)] transition"
            >
              {rel}
            </a>
          ))}
        </div>
      ) : null}
    </li>
  );
}
