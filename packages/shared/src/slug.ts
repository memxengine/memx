/**
 * Canonical slugify used across engine, admin, and CLI scripts.
 *
 * Unicode-aware on purpose: the default KB language is Danish and users
 * write Neuron titles like "Ørsted" or "Fællesskab". The old `[^\w\s-]`
 * pattern treated those letters as punctuation and stripped them, so
 * "Ørsted" slugified to "rsted". `\p{L}\p{N}` preserves any letter or
 * digit in any script while still removing quotes, apostrophes, and
 * other punctuation.
 *
 * Capped at 60 chars — filename-safe, URL-friendly, and short enough that
 * the slug stays recognisable in wiki-tree listings.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Like slugify but never returns the empty string. Falls back to a short
 * random id so callers get a stable filename even when the input is all
 * punctuation.
 */
export function uniqueSlug(text: string): string {
  const base = slugify(text);
  if (base) return base;
  // Fallback path only hits when the input is all punctuation. An 8-char
  // Math.random tail is enough — a collision just lands in the regular
  // filename-dedup lane upstream, and @trail/shared stays dep-free (no
  // node:crypto, no DOM lib).
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

import { foldBilingual } from './slug-fold.js';

export { foldBilingual };

/**
 * F148 — read-side normalized form of a slug, folded toward the KB's
 * canonical language. Used by resolvers (URL matcher, backlink extractor,
 * link checker) as a fallback strategy when canonical-slug match fails.
 * Never call this when PRODUCING a filename — `slugify()` owns that path
 * so on-disk slugs stay deterministic.
 *
 * Example: on a Danish KB, `normalizedSlug('yin-and-yang', 'da')` returns
 * `'yin-og-yang'`. The same call on an English KB returns
 * `'yin-and-yang'` unchanged. Symmetric application on both sides of a
 * comparison (incoming URL slug AND filename-sans-.md) makes the fold
 * commutative — order of arguments doesn't matter.
 */
export function normalizedSlug(slug: string, language: string): string {
  return foldBilingual(slug, language);
}
