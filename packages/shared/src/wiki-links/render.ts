import { slugify } from '../slug.js';
import { parseWikiLinks } from './parser.js';
import type { WikiLink } from './types.js';

/**
 * F23 + F30 — canonical markdown-level wiki-link rewriter. Converts
 * `[[...]]` shapes into standard markdown `[label](href)` links so any
 * downstream markdown renderer (marked in admin, mini-mkdn in widget)
 * picks them up without special knowledge.
 *
 * Called by:
 *   - admin/src/lib/wiki-links.ts (re-exports this) for Neuron reader,
 *     queue preview, editor, chat-turn render.
 *   - future widget (F29) pre-render pass.
 *   - server-side render helper if a consumer requests pre-rendered HTML.
 *
 * Canonical hrefs (not bilingual-folded) on purpose — see F148 note in
 * backlink-extractor. The resolver applies the fold at lookup-time so
 * rendered hrefs remain stable under filename renames.
 */

export interface RenderContext {
  /** The KB the content lives in. Intra-KB links resolve against this. */
  currentKbId: string;
  /**
   * Resolve a `kb:<slug>` reference to a KB id (or slug — the href is
   * built with whatever you return). Return null to render the link as
   * an unresolved placeholder with a distinctive class.
   *
   * Typical server-side implementation: look up `knowledge_bases` by
   * slug within the same tenant. Admin-side: look up in the kb-cache.
   */
  resolveKbSlug?: (kbSlug: string) => string | null;
  /**
   * URL builder — inverted from defaults only when a consumer has a
   * different URL shape (e.g. widget on a customer site). Default:
   *   intra     → /kb/<currentKbId>/neurons/<slug>
   *   cross-kb  → /kb/<resolvedKbId>/neurons/<slug>
   *   external  → #external:<tenantSlug>/<kbSlug>/<slug>
   */
  buildHref?: (args: HrefArgs) => string;
}

export interface HrefArgs {
  kind: 'intra' | 'cross-kb' | 'external';
  kbId: string | null;        // for intra + cross-kb
  tenantSlug: string | null;  // for external
  kbSlug: string | null;      // for cross-kb + external
  targetSlug: string;         // slugified target
}

export function rewriteWikiLinks(markdown: string, ctx: RenderContext): string {
  // Parser gives us structured links; regex still needs to replace the
  // raw `[[...]]` in place. We re-run the parser in replace-callback
  // mode via a regex that matches the same shape — keeps replacement
  // positional without an AST pass.
  return markdown.replace(/\[\[([^\[\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g, (rawMatch) => {
    // Re-parse just this one match so we share edge-type/display rules.
    const links = parseWikiLinks(rawMatch, { dedupe: false });
    if (links.length === 0) return rawMatch; // malformed — leave untouched
    const link = links[0]!;
    return linkToMarkdown(link, ctx);
  });
}

function linkToMarkdown(link: WikiLink, ctx: RenderContext): string {
  const targetSlug = toSlug(link.target);
  const display = link.displayLabel ?? link.target;

  if (link.kind === 'intra') {
    const href = (ctx.buildHref ?? defaultBuildHref)({
      kind: 'intra',
      kbId: ctx.currentKbId,
      tenantSlug: null,
      kbSlug: null,
      targetSlug,
    });
    return `[${display}](${href})`;
  }

  if (link.kind === 'cross-kb') {
    const resolved = ctx.resolveKbSlug?.(link.kbSlug!);
    if (!resolved) {
      // Unresolved cross-KB — render as a span-like marker so the reader
      // sees the intent but doesn't 404. Admin CSS can style this.
      return `[${display}](#unresolved-kb:${encodeURIComponent(link.kbSlug!)}/${encodeURIComponent(targetSlug)})`;
    }
    const href = (ctx.buildHref ?? defaultBuildHref)({
      kind: 'cross-kb',
      kbId: resolved,
      tenantSlug: null,
      kbSlug: link.kbSlug,
      targetSlug,
    });
    return `[${display}](${href})`;
  }

  // external — placeholder until Phase 3 federation
  const href = (ctx.buildHref ?? defaultBuildHref)({
    kind: 'external',
    kbId: null,
    tenantSlug: link.tenantSlug,
    kbSlug: link.kbSlug,
    targetSlug,
  });
  return `[${display} ↗](${href})`;
}

function defaultBuildHref(a: HrefArgs): string {
  if (a.kind === 'intra' || a.kind === 'cross-kb') {
    return `/kb/${encodeURIComponent(a.kbId!)}/neurons/${encodeURIComponent(a.targetSlug)}`;
  }
  return `#external:${encodeURIComponent(a.tenantSlug!)}/${encodeURIComponent(a.kbSlug!)}/${encodeURIComponent(a.targetSlug)}`;
}

function toSlug(t: string): string {
  const stripped = t.replace(/\.md$/i, '').split('/').pop()!.trim();
  return slugify(stripped);
}
