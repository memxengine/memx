/**
 * F148 Lag 2 — bilingual slug-fold. Applied at resolve-time as a last-
 * chance match when the canonical slug comparison fails. Lets a URL
 * `/neurons/yin-og-yang` resolve to `yin-and-yang.md` on a Danish KB
 * without rewriting the filename, and the mirror on an English KB.
 *
 * `slugify()` stays the authoritative producer of filenames. The fold is
 * READ-SIDE ONLY — never used when computing a filename or a backlink
 * target. That way the canonical form written to disk is deterministic,
 * and the fold is a pure safety net that can be extended or removed
 * without migrating any content.
 *
 * Why only connective words (not diacritics): proper nouns expose
 * ambiguity. "Aalborg" is always ASCII; "Århus" is always diacritic.
 * Folding `aa ↔ å` across the board would collapse them. The connective-
 * word set is small and unambiguous — "and/of/to/with" have single
 * Danish equivalents and vice versa.
 */

const BILINGUAL_FOLDS: Record<string, Array<[string, string]>> = {
  da: [
    // [foreign, native] — a Danish KB folds foreign forms to native.
    ['and', 'og'],
    ['of', 'i'],
    ['to', 'til'],
    ['with', 'med'],
    ['as', 'som'],
    ['from', 'fra'],
    ['without', 'uden'],
  ],
  en: [
    // Mirror: English KB folds Danish connectives to English.
    ['og', 'and'],
    ['i', 'of'],
    ['til', 'to'],
    ['med', 'with'],
    ['som', 'as'],
    ['fra', 'from'],
    ['uden', 'without'],
  ],
};

/**
 * Fold a slug toward the KB's canonical language form. Word-boundary-
 * aware: only replaces when the target sits between `-` or slug-edges,
 * so `without` isn't mangled when folding `with`. Idempotent — a slug
 * already in canonical form returns unchanged.
 */
export function foldBilingual(slug: string, language: string): string {
  const pairs = BILINGUAL_FOLDS[language];
  if (!pairs) return slug;

  let out = slug;
  for (const [foreign, native] of pairs) {
    // (^|-)<foreign>(?=-|$) — lookahead for trailing boundary so the
    // replacement keeps whatever follows intact. Leading `-` captured
    // and restored via $1 so mid-slug hits (e.g. `yin-and-yang`) don't
    // lose their preceding hyphen.
    const re = new RegExp(`(^|-)${foreign}(?=-|$)`, 'g');
    out = out.replace(re, `$1${native}`);
  }
  return out;
}
