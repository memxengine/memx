/**
 * F140 — hierarchical schema inheritance for the ingest compile-prompt.
 *
 * A KB's wiki tree can host multiple domains at different paths:
 *
 *   /neurons/concepts/akupunktur/    medical tone, requires "Kontraindikationer"
 *   /neurons/concepts/coaching/      therapeutic tone, first-person
 *   /neurons/concepts/business/      business tone
 *
 * One KB-wide F104 prompt profile can't serve all three well. F140
 * lets a curator drop an `_schema.md` file into any directory — its
 * frontmatter describes local rules (tone, required sections, canonical
 * tags) that the compile-pipeline merges into the ingest prompt for any
 * Neuron under that path.
 *
 * Inheritance chain (root → target):
 *   /_schema.md                               KB-level (optional)
 *   /neurons/_schema.md                       (optional)
 *   /neurons/concepts/_schema.md              (optional)
 *   /neurons/concepts/akupunktur/_schema.md   most-specific (optional)
 *
 * Merge rules:
 *   - scalars: child overrides parent (tone, summary)
 *   - arrays: unions (required_sections, tags_canonical)
 *   - missing levels are skipped — no "empty schema" penalty
 *
 * This module is pure: no DB writes, no LLM calls. Caller fetches the
 * list of schema Neurons once per ingest via a single SELECT, then
 * passes them in for merging. Keeps the call cheap even on deep trees.
 */

export interface SchemaProfile {
  /** Short tone directive ("medical, formal, cite sources"). */
  tone?: string;
  /** One-sentence summary of what this scope is about. */
  summary?: string;
  /** Sections every Neuron under this scope must contain. */
  requiredSections: string[];
  /** Canonical tag vocabulary for the scope — LLM should prefer these. */
  tagsCanonical: string[];
  /** Extra instructions appended to the compile prompt verbatim. */
  instructions?: string;
  /** The most-specific scope path that contributed (for debug/logging). */
  resolvedFrom: string[];
}

export interface SchemaNeuronRow {
  /** The directory the schema applies to — always a trailing slash. */
  scope: string;
  /** Parsed body content (after frontmatter stripped). */
  body: string;
  /** Parsed frontmatter fields. */
  frontmatter: Partial<Omit<SchemaProfile, 'resolvedFrom'>>;
}

const EMPTY_PROFILE: SchemaProfile = {
  requiredSections: [],
  tagsCanonical: [],
  resolvedFrom: [],
};

/**
 * Walk the chain from root to `targetPath`, merging any scope that
 * covers the target. `schemaRows` is pre-loaded by the caller — one
 * SELECT against documents where filename='_schema.md'. Returns a
 * merged profile (never null — callers always get something usable).
 *
 * `targetPath` must end with `/` (it's a directory path — the file
 * the ingest is about lives under it). Example: '/neurons/concepts/
 * akupunktur/'.
 */
export function resolveSchemaChain(
  targetPath: string,
  schemaRows: SchemaNeuronRow[],
): SchemaProfile {
  // Normalise: ensure trailing slash so prefix-match is unambiguous
  const target = targetPath.endsWith('/') ? targetPath : `${targetPath}/`;

  // Filter to schemas whose scope is a prefix of target, sort by scope
  // length ascending so root-level schemas merge first and
  // most-specific schemas last (overriding).
  const applicable = schemaRows
    .filter((r) => target.startsWith(r.scope))
    .sort((a, b) => a.scope.length - b.scope.length);

  if (applicable.length === 0) return EMPTY_PROFILE;

  let merged: SchemaProfile = { ...EMPTY_PROFILE };
  for (const row of applicable) {
    merged = mergeProfiles(merged, row);
  }
  return merged;
}

function mergeProfiles(parent: SchemaProfile, child: SchemaNeuronRow): SchemaProfile {
  const fm = child.frontmatter;
  return {
    tone: fm.tone ?? parent.tone,
    summary: fm.summary ?? parent.summary,
    requiredSections: uniqueConcat(parent.requiredSections, fm.requiredSections ?? []),
    tagsCanonical: uniqueConcat(parent.tagsCanonical, fm.tagsCanonical ?? []),
    // Child body is appended to parent's instructions — readers down
    // the chain accumulate detail rather than overwriting it.
    instructions: joinLines(parent.instructions, child.body),
    resolvedFrom: [...parent.resolvedFrom, child.scope],
  };
}

function uniqueConcat<T>(a: T[], b: T[]): T[] {
  const seen = new Set<T>(a);
  const out = [...a];
  for (const item of b) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function joinLines(a: string | undefined, b: string | undefined): string | undefined {
  const parts = [a, b].filter((s): s is string => !!s && s.trim().length > 0);
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

/**
 * Format a resolved profile as a prompt-ready string. Empty profile →
 * empty string (caller can concatenate unconditionally). Inserted by
 * the ingest pipeline before the main compile instruction.
 */
export function renderSchemaForPrompt(profile: SchemaProfile): string {
  const lines: string[] = [];
  if (profile.tone) {
    lines.push(`TONE FOR THIS PATH: ${profile.tone}`);
  }
  if (profile.summary) {
    lines.push(`SCOPE SUMMARY: ${profile.summary}`);
  }
  if (profile.requiredSections.length > 0) {
    lines.push(
      `REQUIRED SECTIONS (every Neuron under this path must include):\n${profile.requiredSections
        .map((s) => `  - ${s}`)
        .join('\n')}`,
    );
  }
  if (profile.tagsCanonical.length > 0) {
    lines.push(
      `CANONICAL TAGS FOR THIS PATH (prefer these over synonyms):\n${profile.tagsCanonical
        .map((t) => `  - ${t}`)
        .join('\n')}`,
    );
  }
  if (profile.instructions) {
    lines.push(`ADDITIONAL PATH INSTRUCTIONS:\n${profile.instructions}`);
  }
  if (lines.length === 0) return '';
  const header = `PATH SCHEMA (inherited from ${profile.resolvedFrom.join(' → ')}):`;
  return `\n\n${header}\n${lines.join('\n\n')}\n`;
}

/**
 * Lightweight YAML frontmatter extractor for _schema.md files. Handles
 * the subset we care about: scalar strings, string arrays in flow-form
 * `[a, b, c]` or multi-line `- a\n- b`. Not a full YAML parser; schema
 * files that try to use anchors or nested maps will get the empty
 * profile — explicit-fail-safe rather than implicit-wrong.
 */
export function parseSchemaNeuron(path: string, content: string): SchemaNeuronRow | null {
  // Normalise scope: the schema's scope is its directory path (from
  // documents.path — which already ends with '/').
  const scope = path.endsWith('/') ? path : `${path}/`;

  if (!content.startsWith('---')) {
    return { scope, body: content, frontmatter: {} };
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return { scope, body: content, frontmatter: {} };
  }
  const fmText = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\n+/, '');

  const fm: SchemaNeuronRow['frontmatter'] = {};
  // Walk key: value lines. Very simple — YAML subset, not a parser.
  const lines = fmText.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1]!;
    const rest = m[2]!.trim();

    if (rest === '') {
      // Multi-line array: next lines "- foo"
      const items: string[] = [];
      i += 1;
      while (i < lines.length && lines[i]!.match(/^\s*-\s+/)) {
        items.push(lines[i]!.replace(/^\s*-\s+/, '').trim());
        i += 1;
      }
      applyArray(fm, key, items);
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      // Flow-form array [a, b, c]
      const items = rest
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      applyArray(fm, key, items);
      i += 1;
      continue;
    }

    // Scalar
    const value = rest.replace(/^["']|["']$/g, '');
    applyScalar(fm, key, value);
    i += 1;
  }

  return { scope, body, frontmatter: fm };
}

function applyScalar(
  fm: SchemaNeuronRow['frontmatter'],
  key: string,
  value: string,
): void {
  if (key === 'tone') fm.tone = value;
  else if (key === 'summary') fm.summary = value;
  else if (key === 'instructions') fm.instructions = value;
}

function applyArray(
  fm: SchemaNeuronRow['frontmatter'],
  key: string,
  items: string[],
): void {
  if (key === 'required_sections' || key === 'requiredSections') {
    fm.requiredSections = items;
  } else if (key === 'tags_canonical' || key === 'tagsCanonical') {
    fm.tagsCanonical = items;
  }
}
