import { rewriteWikiLinks as rewriteCore } from '@trail/shared';
import { matchKb, peekKbs } from './kb-cache';

/**
 * F23 + F30 — admin-side thin wrapper over the canonical renderer from
 * `@trail/shared`. Resolves cross-KB references (`[[kb:other-slug/page]]`)
 * via the module-level kb-cache so callers don't need to thread a
 * kb-list through their render pipeline.
 *
 * Before F23 this module owned its own `[[...]]` regex — duplicated with
 * the server's backlink-extractor and incapable of parsing `kb:` /
 * `ext:` prefixes. Now it delegates to the shared parser + renderer so
 * every place Trail renders markdown honors the same link grammar.
 */
export function rewriteWikiLinks(markdown: string, kbId: string): string {
  const kbs = peekKbs();
  return rewriteCore(markdown, {
    currentKbId: kbId,
    resolveKbSlug: kbs
      ? (slug) => {
          const hit = matchKb(kbs, slug);
          return hit?.id ?? null;
        }
      : undefined,
  });
}
