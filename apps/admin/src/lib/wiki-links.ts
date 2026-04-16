/**
 * Preprocess wiki `[[target]]` / `[[target|display]]` syntax into
 * standard markdown links before `marked.parse()` runs. Marked passes
 * the resulting `[label](href)` through its normal pipeline, so the
 * output HTML has real anchor tags with correct escaping + no risk of
 * mangling content inside code blocks.
 *
 * Target resolution: `[[nada-protokol|NADA-punkter]]` →
 * `[NADA-punkter](/kb/<kbId>/neurons/nada-protokol)`. The admin's
 * Neuron reader route matches on the slug (filename without .md).
 *
 * Target cleanup: slugs with path prefixes like `[[concepts/shen-men]]`
 * are flattened to their final segment — the reader resolves by
 * filename globally per KB, not by path. Trailing `.md` is stripped.
 */
export function rewriteWikiLinks(markdown: string, kbId: string): string {
  return markdown.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, rawTarget: string, rawDisplay?: string) => {
    const target = normaliseTarget(rawTarget.trim());
    const display = (rawDisplay ?? rawTarget).trim();
    const href = `/kb/${encodeURIComponent(kbId)}/neurons/${encodeURIComponent(target)}`;
    return `[${display}](${href})`;
  });
}

function normaliseTarget(t: string): string {
  return t
    .replace(/\.md$/i, '')
    .split('/')
    .pop()!
    .trim();
}
