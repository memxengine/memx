/**
 * F160 Phase 2 — output post-processing per audience.
 *
 * Even with a strong system-prompt instructing the LLM to never emit
 * `[[wiki-links]]` or "Kilder:" sections, models sometimes slip — old
 * habits from training, or partial-instruction-following on long
 * prompts. We belt-and-suspenders the prose for tool/public audiences
 * by stripping these patterns programmatically before the answer is
 * persisted or returned.
 *
 * For curator audience this is a no-op — admin curators expect the
 * full markdown including wiki-links and inline citations.
 *
 * The strip is conservative: we only remove patterns that are clearly
 * Trail-internal, never general markdown formatting (bold, italics,
 * paragraphs). The post-process aims to keep the prose's content
 * intact while removing render-poison for external consumers.
 */

import type { Audience } from '../audience.js';

/**
 * Remove `[[wiki-link]]` syntax — both `[[Page]]` and `[[Page|Display]]`
 * forms — replacing with the display text (or page name) so the prose
 * stays readable. Cross-KB links `[[kb:other/Page]]` collapse to the
 * page-name part.
 */
function stripWikiLinks(text: string): string {
  return text.replace(/\[\[([^\]]+?)\]\]/g, (_match, inner: string) => {
    const trimmed = inner.trim();
    // Pipe form: `[[Target|Display]]` → `Display`
    if (trimmed.includes('|')) {
      const parts = trimmed.split('|');
      return parts[parts.length - 1]!.trim();
    }
    // Cross-kb form: `[[kb:other/Page]]` → `Page`
    if (trimmed.startsWith('kb:')) {
      const slash = trimmed.indexOf('/');
      if (slash >= 0) return trimmed.slice(slash + 1);
    }
    return trimmed;
  });
}

/**
 * Strip a trailing "Kilder:" / "Sources:" / "References:" section.
 * Detection: line at start-of-line matching one of those headers
 * (with or without `**`, `##`, etc), followed by content to the end
 * of the document. We're aggressive here — once we see the header,
 * everything after it is dropped. Citations travel as structured
 * data; this section is render-poison for external consumers.
 *
 * Matches Danish "Kilder:" + English "Sources:" / "References:".
 * Case-insensitive.
 */
function stripCitationsBlock(text: string): string {
  // Normalise newlines first so the regex doesn't trip on \r\n.
  const normalised = text.replace(/\r\n/g, '\n');
  // Look for a line that is a citation-block header. Allow optional
  // markdown emphasis or heading markers.
  const headerPattern = /^[ \t]*(?:#{1,6}\s+|\*\*\s*)?(?:Kilder|Sources|References)[:\s]*\*{0,2}\s*$/im;
  const match = normalised.match(headerPattern);
  if (!match || match.index === undefined) return normalised;
  // Drop everything from the header onwards. Trim trailing whitespace
  // so the remaining prose ends cleanly.
  return normalised.slice(0, match.index).trimEnd();
}

/**
 * Apply audience-specific post-processing to an LLM answer string.
 * Returns the cleaned answer ready to persist + return to caller.
 *
 * curator: pass-through (admin UI expects full markdown).
 * tool/public: strip wiki-links + citations block.
 */
export function stripForAudience(answer: string, audience: Audience): string {
  if (audience === 'curator') return answer;
  let out = stripWikiLinks(answer);
  out = stripCitationsBlock(out);
  return out;
}
