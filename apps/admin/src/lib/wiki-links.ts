import { slugify } from '@trail/shared';

/**
 * Preprocess wiki `[[target]]` / `[[target|display]]` syntax into
 * standard markdown links before `marked.parse()` runs. Marked passes
 * the resulting `[label](href)` through its normal pipeline, so the
 * output HTML has real anchor tags with correct escaping + no risk of
 * mangling content inside code blocks.
 *
 * Target resolution: `[[NADA-punkter]]` →
 * `[NADA-punkter](/kb/<kbId>/neurons/nada-punkter)`. The admin's
 * Neuron reader route matches on the slug, and ingest uses the same
 * `slugify()` to compute filenames — so the link and the file both
 * collapse to the same canonical form.
 *
 * Without slugify, `[[FMC]]` pointed at `/neurons/FMC` and the reader
 * couldn't find `fmc.md`; `[[ARC Farm Intelligence]]` pointed at
 * `/neurons/ARC%20Farm%20Intelligence` and couldn't find
 * `arc-farm-intelligence.md`. Both cases were common in
 * compile-generated Neurons that reference entities by their display
 * name.
 *
 * Path prefixes like `[[concepts/shen-men]]` are flattened to their
 * final segment — the reader resolves by slug globally per KB.
 */
export function rewriteWikiLinks(markdown: string, kbId: string): string {
  return markdown.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, rawTarget: string, rawDisplay?: string) => {
    const target = targetToSlug(rawTarget.trim());
    const display = (rawDisplay ?? rawTarget).trim();
    const href = `/kb/${encodeURIComponent(kbId)}/neurons/${encodeURIComponent(target)}`;
    return `[${display}](${href})`;
  });
}

function targetToSlug(t: string): string {
  const stripped = t
    .replace(/\.md$/i, '')
    .split('/')
    .pop()!
    .trim();
  return slugify(stripped);
}
