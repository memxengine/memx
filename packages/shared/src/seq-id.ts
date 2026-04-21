/**
 * F145 — human-readable per-KB sequence IDs.
 *
 * Every Document row carries a monotone integer `seq` per KB (migration
 * 0008). The display form combines a KB-derived prefix with an 8-digit
 * zero-padded decimal: `buddy_00000219`, `trail-research_00000042`.
 *
 * Why decimal+8: the prefix makes it obvious which KB owns the id, and
 * 8 digits scales to 10⁸ Neurons per KB — far beyond any realistic
 * corpus. Decimal keeps it immediately readable when pasted in chat
 * without anyone having to mentally decode base-36 or hex.
 *
 * Why monotone-per-KB: cross-session communication between cc sessions
 * and buddy needs a stable handle that doesn't drift when a Neuron is
 * re-compiled (UUIDs change on recompile via wiki-events). Seq is
 * assigned at first insert and never mutated after.
 */

import { slugify } from './slug.js';

export const SEQ_ID_PAD = 8;
export const SEQ_ID_SEPARATOR = '_';

/**
 * Derive the KB-prefix component. Takes the first token of the KB name
 * (e.g. "Buddy sessions" → "buddy"; "Trail Research" → "trail"; "F138 QA" → "f138"),
 * then slugifies it so downstream code never has to worry about spaces,
 * diacritics or case. Falls back to `kb` when the name is all punctuation.
 */
export function kbPrefix(kbName: string | null | undefined): string {
  if (!kbName) return 'kb';
  const firstWord = kbName.trim().split(/\s+/)[0] ?? '';
  const slug = slugify(firstWord);
  return slug || 'kb';
}

/**
 * Render a display-ready seqId. Returns null when either input is null,
 * so callers can conditionally render ("show the badge when seqId is
 * present") without a special-case branch.
 */
export function formatSeqId(
  kbName: string | null | undefined,
  seq: number | null | undefined,
): string | null {
  if (seq === null || seq === undefined) return null;
  const prefix = kbPrefix(kbName);
  return `${prefix}${SEQ_ID_SEPARATOR}${String(seq).padStart(SEQ_ID_PAD, '0')}`;
}

/**
 * Inverse of formatSeqId — parse `<prefix>_<digits>` back to its parts.
 * Also accepts the `#` lookup prefix used in search UIs. Returns null on
 * any shape mismatch so callers can fall through to regular FTS.
 */
export function parseSeqId(raw: string): { prefix: string; seq: number } | null {
  const trimmed = raw.trim().replace(/^#/, '');
  const match = trimmed.match(/^([a-z0-9][a-z0-9-]*)_(\d+)$/);
  if (!match) return null;
  const seq = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(seq) || seq < 0) return null;
  return { prefix: match[1]!, seq };
}
