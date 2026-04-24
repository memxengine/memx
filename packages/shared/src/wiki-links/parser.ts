import { EDGE_TYPE_SET, type EdgeType, type WikiLink, type WikiLinkKind } from './types.js';

/**
 * F23 — canonical wiki-link parser. Recognises three prefixes:
 *
 *   `[[Page]]`                     → intra
 *   `[[kb:other-slug/Page]]`       → cross-kb (same tenant)
 *   `[[ext:tenant/kb-slug/Page]]`  → external (Phase 3 placeholder)
 *
 * Pipe disambiguation: `[[A|B]]` where B is in `VALID_EDGE_TYPES` → edge-type;
 * otherwise → display label.
 *
 * The regex is intentionally strict on the separator `/`: a cross-kb link
 * without a trailing page would be `[[kb:other-slug]]` which we REJECT
 * (returns nothing) since it has no target. Keeps the resolver honest.
 *
 * Frontmatter-stripping is opt-in. Backlink extractor strips (so a
 * `sources:` frontmatter list doesn't register as links); the admin
 * markdown renderer does NOT strip (its input is already the body post-
 * frontmatter split).
 */

export interface ParseOptions {
  /** Strip `---\n...\n---\n` frontmatter before scanning. Default: false. */
  stripFrontmatter?: boolean;
  /**
   * Dedup by target (first-write-wins on edgeType). Default: true.
   * Backlink extractor wants dedup; chat-render wants all occurrences.
   */
  dedupe?: boolean;
}

const LINK_RE = /\[\[([^\[\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g;

export function parseWikiLinks(content: string, opts: ParseOptions = {}): WikiLink[] {
  const { stripFrontmatter = false, dedupe = true } = opts;
  const body = stripFrontmatter ? stripFrontmatterBlock(content) : content;

  const matches = body.matchAll(LINK_RE);
  const out: WikiLink[] = [];
  const seen = new Set<string>();

  for (const m of matches) {
    const inner = m[1]!.trim();
    if (!inner) continue;

    const pipeRaw = (m[2] ?? '').trim();
    const { edgeType, displayLabel } = classifyPipe(pipeRaw);

    const parsed = parseInner(inner);
    if (!parsed) continue;

    const link: WikiLink = {
      raw: m[0]!,
      kind: parsed.kind,
      target: parsed.target,
      kbSlug: parsed.kbSlug,
      tenantSlug: parsed.tenantSlug,
      displayLabel,
      edgeType,
    };

    if (dedupe) {
      const key = dedupeKey(link);
      if (seen.has(key)) continue;
      seen.add(key);
    }

    out.push(link);
  }

  return out;
}

/**
 * Backward-compat shape used by the legacy backlink-extractor API.
 * `{ target, edgeType }` only, intra-KB only. Cross-kb + external links
 * are silently dropped — existing callers don't want cross-KB in the
 * wiki_backlinks graph (explicitly scoped per F23 non-goals).
 */
export interface LegacyWikiLinkMatch {
  target: string;
  edgeType: EdgeType;
}
export function parseIntraKbLinks(content: string): LegacyWikiLinkMatch[] {
  return parseWikiLinks(content, { stripFrontmatter: true, dedupe: true })
    .filter((l) => l.kind === 'intra')
    .map((l) => ({ target: l.target, edgeType: l.edgeType }));
}

// ── internal helpers ────────────────────────────────────────────────────

interface ParsedInner {
  kind: WikiLinkKind;
  target: string;
  kbSlug: string | null;
  tenantSlug: string | null;
}

/**
 * Recognise prefix + split into components. Returns null if the shape
 * is structurally broken (ext without all three parts, kb without page).
 */
function parseInner(raw: string): ParsedInner | null {
  // Preserve original case for target/slug parts — slug normalization
  // happens in the renderer, not here. Parser keeps raw text so both
  // consumers can decide what to do.
  if (raw.startsWith('ext:')) {
    const rest = raw.slice(4);
    const parts = rest.split('/');
    if (parts.length < 3) return null;
    const tenantSlug = parts[0]!.trim();
    const kbSlug = parts[1]!.trim();
    const target = parts.slice(2).join('/').trim();
    if (!tenantSlug || !kbSlug || !target) return null;
    return { kind: 'external', target, kbSlug, tenantSlug };
  }

  if (raw.startsWith('kb:')) {
    const rest = raw.slice(3);
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    const kbSlug = rest.slice(0, slash).trim();
    const target = rest.slice(slash + 1).trim();
    if (!kbSlug || !target) return null;
    return { kind: 'cross-kb', target, kbSlug, tenantSlug: null };
  }

  return { kind: 'intra', target: raw, kbSlug: null, tenantSlug: null };
}

function classifyPipe(pipeRaw: string): { edgeType: EdgeType; displayLabel: string | null } {
  if (!pipeRaw) return { edgeType: 'cites', displayLabel: null };
  const lower = pipeRaw.toLowerCase();
  if (EDGE_TYPE_SET.has(lower)) {
    return { edgeType: lower as EdgeType, displayLabel: null };
  }
  return { edgeType: 'cites', displayLabel: pipeRaw };
}

function dedupeKey(l: WikiLink): string {
  return `${l.kind}|${l.tenantSlug ?? ''}|${l.kbSlug ?? ''}|${l.target}`;
}

function stripFrontmatterBlock(content: string): string {
  const m = content.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  return m ? content.slice(m[0].length) : content;
}
