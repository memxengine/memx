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
