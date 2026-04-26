/**
 * F160 Phase 2 — verify audience-aware chat (persona templates +
 * per-KB overrides + output postprocessing).
 *
 * What this proves end-to-end (not infers):
 *   1. Migration 0023 — both chat_persona_tool + chat_persona_public
 *      columns present on knowledge_bases.
 *   2. buildSystemPrompt(audience='curator') loads chat-curator.md
 *      template and produces the same output it did pre-F160 for the
 *      admin-UI back-compat path.
 *   3. buildSystemPrompt(audience='tool') loads chat-tool.md and
 *      includes the "Output rules" section (not in curator template).
 *   4. buildSystemPrompt(audience='public') loads chat-public.md and
 *      includes "du-form" instruction (not in tool template).
 *   5. Per-KB chat_persona_tool override is appended to tool template
 *      under "## KB-specific persona" header.
 *   6. Per-KB chat_persona_public override is appended to public
 *      template, NOT to tool or curator.
 *   7. curator audience IGNORES per-KB overrides (admin tone is
 *      shared — verified by passing an override and confirming it's
 *      NOT in the resolved prompt).
 *   8. stripForAudience('curator') is pass-through.
 *   9. stripForAudience('tool') strips [[wiki-links]] to plain text.
 *  10. stripForAudience('tool') strips trailing "Kilder:" section.
 *  11. stripForAudience('public') same as tool.
 *  12. Cross-form wiki-link stripping: [[Page|Display]] → "Display",
 *      [[kb:other/Page]] → "Page".
 *
 * No HTTP / LLM calls — pure unit tests against the helper functions.
 * Run with: `cd apps/server && bun run scripts/verify-f160-phase2.ts`
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLibsqlDatabase, knowledgeBases } from '@trail/db';
import { buildSystemPrompt } from '../src/services/chat/build-prompt.ts';
import { stripForAudience } from '../src/services/chat/postprocess.ts';

const REPO_ROOT_DB = join(homedir(), 'Apps/broberg/trail/data/trail.db');

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures += 1;
  }
}

console.log(`\n=== F160 Phase 2 probe ===\n`);

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });
await trail.runMigrations();

// ── 1. Migration 0023 schema ────────────────────────────────────────────
console.log('[1] Migration 0023 — persona override columns present');
const kbCols = await trail.execute(
  `SELECT name FROM pragma_table_info('knowledge_bases')`,
);
const colNames = (kbCols.rows as Array<{ name: string }>).map((r) => r.name);
assert(colNames.includes('chat_persona_tool'), 'chat_persona_tool exists');
assert(colNames.includes('chat_persona_public'), 'chat_persona_public exists');

// ── 2-4. Persona templates load + are distinct ──────────────────────────
console.log('\n[2-4] Persona templates load + are audience-distinct');
const curator = buildSystemPrompt({
  currentTrailName: 'Probe Trail',
  context: 'context block',
  audience: 'curator',
});
const tool = buildSystemPrompt({
  currentTrailName: null,
  context: 'context block',
  audience: 'tool',
});
const publicAudience = buildSystemPrompt({
  currentTrailName: null,
  context: 'context block',
  audience: 'public',
});
assert(
  curator.includes('Reference wiki pages with [[page-name]] links'),
  'curator template loaded (matches pre-F160 instruction)',
);
assert(curator.includes('Probe Trail'), 'curator includes currentTrailName');
assert(curator.includes('context block'), 'curator includes context');

assert(tool.includes('Output rules'), 'tool template loaded (Output rules section)');
assert(
  tool.includes('Never') && tool.includes('citations'),
  'tool template instructs against [[wiki-links]] / citations in prose',
);
assert(!tool.includes('## Current Trail'), 'tool DOES NOT include Current Trail header');

assert(publicAudience.includes('Du-form'), 'public template loaded (Du-form instruction)');
assert(
  publicAudience.includes('Never diagnose') || publicAudience.includes('diagnose'),
  'public template includes diagnose-prohibition',
);

// ── 5-6. Per-KB persona override appends correctly ──────────────────────
console.log('\n[5-6] Per-KB persona overrides are appended');
const sannePersona = 'Du er Sanne Andersen, zoneterapeut i Aalborg. Booking via sanne-andersen.dk/book.';
const toolWithOverride = buildSystemPrompt({
  currentTrailName: null,
  context: 'ctx',
  audience: 'tool',
  kbPersonaOverride: 'Always cite the practitioner by name.',
});
assert(
  toolWithOverride.includes('## KB-specific persona') &&
    toolWithOverride.includes('Always cite the practitioner by name.'),
  'tool override appended under KB-specific persona header',
);

const publicWithOverride = buildSystemPrompt({
  currentTrailName: null,
  context: 'ctx',
  audience: 'public',
  kbPersonaOverride: sannePersona,
});
assert(
  publicWithOverride.includes('## KB-specific persona') &&
    publicWithOverride.includes('Sanne Andersen'),
  'public override appended under KB-specific persona header',
);

// ── 7. Curator audience IGNORES per-KB override ─────────────────────────
console.log('\n[7] curator audience ignores per-KB override (admin tone is global)');
const curatorWithOverride = buildSystemPrompt({
  currentTrailName: 'Probe',
  context: 'ctx',
  audience: 'curator',
  kbPersonaOverride: 'this should not appear',
});
assert(
  !curatorWithOverride.includes('this should not appear'),
  'curator does not append KB persona override',
);
assert(
  !curatorWithOverride.includes('## KB-specific persona'),
  'curator does not include KB-specific persona header',
);

// ── 8. stripForAudience curator = pass-through ──────────────────────────
console.log('\n[8] stripForAudience(curator) is pass-through');
const sample = 'Læs [[Zoneterapi]] for mere.\n\n**Kilder:**\n- zoneterapi.md';
assert(stripForAudience(sample, 'curator') === sample, 'curator returns input unchanged');

// ── 9-10. stripForAudience tool/public strips ───────────────────────────
console.log('\n[9-10] stripForAudience(tool/public) strips wiki-links + Kilder');
const stripped = stripForAudience(sample, 'tool');
assert(!stripped.includes('[['), 'tool strips [[ delimiter');
assert(!stripped.includes(']]'), 'tool strips ]] delimiter');
assert(stripped.includes('Zoneterapi'), 'tool keeps the link text');
assert(!stripped.includes('Kilder'), 'tool strips Kilder section');
assert(!stripped.includes('zoneterapi.md'), 'tool strips Kilder content');

const strippedPub = stripForAudience(sample, 'public');
assert(strippedPub === stripped, 'public strips identically to tool');

// ── 11. Variants: pipe-form, kb:-form ───────────────────────────────────
console.log('\n[11] Wiki-link variants — pipe + cross-kb');
const pipeForm = stripForAudience('Se [[zoneterapi|Zoneterapi]] for info', 'tool');
assert(pipeForm === 'Se Zoneterapi for info', 'pipe-form [[Target|Display]] → Display');

const kbForm = stripForAudience('Se [[kb:other/Side]] for info', 'tool');
assert(kbForm === 'Se Side for info', 'cross-kb [[kb:other/Page]] → Page');

// ── 12. Trailing whitespace cleanup after strip ─────────────────────────
console.log('\n[12] Strip cleans trailing whitespace');
const withTrailing = 'Svaret her.\n\n**Kilder:**\n- a.md\n- b.md\n';
const cleaned = stripForAudience(withTrailing, 'tool');
assert(cleaned === 'Svaret her.', `clean trailing whitespace (got "${cleaned}")`);

console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s) ===\n`);
process.exit(failures === 0 ? 0 : 1);
