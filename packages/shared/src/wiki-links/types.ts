/**
 * F23 — canonical types for wiki-link parsing + rendering shared across
 * server (backlink-extractor, link-checker) and admin (markdown renderer).
 *
 * Three link-kinds:
 *   - `intra`      : `[[Page Name]]`                    — same KB
 *   - `cross-kb`   : `[[kb:other-slug/Page]]`           — different KB, same tenant
 *   - `external`   : `[[ext:tenant-slug/kb-slug/Page]]` — federation (Phase 3 placeholder)
 *
 * The pipe-suffix `[[Target|X]]` carries EITHER:
 *   - an **edge-type** if X is in `VALID_EDGE_TYPES` (F137 semantic annotation)
 *   - a **display label** otherwise (F23 cosmetic relabel)
 *
 * Disambiguation is the closed-set check — the same `[[A|B]]` parses
 * consistently on server and admin because the rule is identical.
 */

export const VALID_EDGE_TYPES = [
  'cites',
  'is-a',
  'part-of',
  'contradicts',
  'supersedes',
  'example-of',
  'caused-by',
] as const;
export type EdgeType = (typeof VALID_EDGE_TYPES)[number];
export const EDGE_TYPE_SET = new Set<string>(VALID_EDGE_TYPES);

export type WikiLinkKind = 'intra' | 'cross-kb' | 'external';

export interface WikiLink {
  /** Original match text including brackets (`[[kb:foo/bar|Label]]`). */
  raw: string;
  /** Which of the three link-shapes this is. */
  kind: WikiLinkKind;
  /** The page part — what gets slugified to filename. `bar` in `[[kb:foo/bar]]`. */
  target: string;
  /** For cross-kb + external: the KB slug (`foo`). Null for intra. */
  kbSlug: string | null;
  /** For external only: the tenant slug. Null otherwise. */
  tenantSlug: string | null;
  /** Display label from `|pipe` when the pipe-value is not an edge-type. Null otherwise. */
  displayLabel: string | null;
  /** Edge-type from `|pipe` when the pipe-value IS in `VALID_EDGE_TYPES`. Defaults to 'cites'. */
  edgeType: EdgeType;
}
