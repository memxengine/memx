/**
 * Storage is canonical `/neurons/...` now. This helper remains as a safety
 * shim for two edge cases:
 *  - legacy data that slipped in before the bootstrap rewrite ran
 *  - external ingest clients (buddy, CMS adapters) that haven't caught up to
 *    the namespace change yet
 *
 * For any `/neurons/...` input it's a no-op. For a stale `/wiki/...` it
 * rewrites to `/neurons/...` so the curator never sees the old prefix.
 */
export function displayPath(p: string | null | undefined): string {
  if (!p) return '';
  return p.replace(/^\/wiki(\/|$)/, '/neurons$1');
}
