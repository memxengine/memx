/**
 * F92 — tag canonicalisation + parsing. Shared between admin UI,
 * server-side write paths (submitCuratorEdit, approveUpdate, create-
 * candidate), and any script that has to round-trip tags.
 *
 * Storage contract: `documents.tags` holds a flat comma-separated
 * string. `parseTags` + `serializeTags` own the wire format boundary —
 * UI code works with a deduped, trimmed `string[]`; the DB / API sees
 * the canonical comma-joined form. Empty / whitespace-only entries are
 * dropped on both sides so round-tripping is idempotent.
 *
 * Canonical form — enforced on write (but NOT on read; legacy tags
 * stored before F92 landed may be mixed-case / contain spaces, and
 * we render them verbatim so existing KBs don't visibly regress).
 * Invalid raw inputs are silently dropped at write time rather than
 * rejected with an error, matching the "suggestions, not gate-keeping"
 * tone of the rest of the editor.
 */

/**
 * Parse a DB-stored comma-separated tag string into a deduped array.
 * Case-insensitive dedup — `"Ops, ops"` collapses to `["Ops"]` (first
 * occurrence wins the casing battle for display).
 */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Opposite direction of parseTags — array back to comma-joined form. */
export function serializeTags(tags: string[]): string {
  return tags.join(', ');
}

/**
 * Canonicalise a raw tag input into the storage form enforced by F92.
 * Rules:
 *   - trim + lowercase
 *   - collapse runs of whitespace to a single `-`
 *   - unicode letters + digits + `-` allowed (so Danish æ/ø/å survive);
 *     punctuation and symbols are rejected
 *   - 1-40 chars
 *
 * Matches the precedent from @trail/shared's slugify (`[\p{L}\p{N}]+`) —
 * Sanne's KB is Danish-first, tags like "åndedræt" must round-trip.
 *
 * Returns null when the input can't be normalised to those rules —
 * the call-site is expected to drop the invalid tag silently (so a
 * pasted list with one bad entry still saves the rest).
 */
export function canonicaliseTag(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (!t) return null;
  if (t.length > 40) return null;
  if (!/^[\p{L}\p{N}-]+$/u.test(t)) return null;
  return t;
}

/**
 * Pipe a comma-separated raw string through parseTags → canonicaliseTag
 * → dedup → serialize. The one-call write-path helper. Returns null when
 * the input ends up empty (so callers can store null in the DB column
 * rather than an empty string and preserve the "no tags" nullable
 * semantics).
 */
export function canonicaliseTagString(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const canon = canonicaliseTag(part);
    if (!canon) continue;
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push(canon);
  }
  return out.length === 0 ? null : out.join(', ');
}
