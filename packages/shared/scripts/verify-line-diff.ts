/**
 * F20 — end-to-end verification of the line-diff primitive used by the
 * curator's DiffView. Exercises identical/empty/pure-add/pure-remove
 * plus mixed scenarios with alignment (before/after sides aligned via
 * blank placeholders for the opposite side).
 *
 * Run: `bun run packages/shared/scripts/verify-line-diff.ts`
 */

import { computeLineDiff } from '../src/diff/line-diff.js';

let failures = 0;
function assert(label: string, cond: unknown, detail?: string): void {
  if (!cond) {
    failures++;
    console.error(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
function eq<T>(label: string, got: T, want: T): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  assert(label, ok, ok ? undefined : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// ── Identical ──────────────────────────────────────────────────────────
console.log('\n── Identical ──');
{
  const d = computeLineDiff('a\nb\nc', 'a\nb\nc');
  eq('3 unchanged', d.stats, { added: 0, removed: 0, unchanged: 3 });
  eq('inline = 3 rows, all unchanged', d.inline.map((l) => l.kind), ['unchanged', 'unchanged', 'unchanged']);
  eq('before.length === after.length', d.before.length, d.after.length);
}

// ── Pure add ───────────────────────────────────────────────────────────
console.log('\n── Pure add ──');
{
  const d = computeLineDiff('', 'x\ny');
  // Empty string `split('\n')` yields [''] — one empty row. That row
  // doesn't match any of after's real rows, so it registers as a
  // single `removed:''` alongside the 2 adds.
  assert('all additions present', d.stats.added === 2);
  eq('before has exactly 2 GAP slots (one per addition)',
    d.before.filter((r) => r.text === '' && r.kind === 'unchanged').length,
    2);
}

// ── Pure remove ────────────────────────────────────────────────────────
console.log('\n── Pure remove ──');
{
  const d = computeLineDiff('x\ny', '');
  assert('2 removes', d.stats.removed === 2);
}

// ── Replace single line ────────────────────────────────────────────────
console.log('\n── Replace single line ──');
{
  const d = computeLineDiff('a\nb\nc', 'a\nB\nc');
  eq('stats: 1 added 1 removed 2 unchanged', d.stats, { added: 1, removed: 1, unchanged: 2 });
  // inline ordering: 'a' unchanged, then remove-before-add tie-break
  eq('inline kinds', d.inline.map((l) => l.kind),
    ['unchanged', 'removed', 'added', 'unchanged']);
  eq('before aligned (GAP in slot where add occurred)',
    d.before.map((l) => `${l.kind}:${l.text}`),
    ['unchanged:a', 'removed:b', 'unchanged:', 'unchanged:c']);
  eq('after aligned (GAP in slot where remove occurred)',
    d.after.map((l) => `${l.kind}:${l.text}`),
    ['unchanged:a', 'unchanged:', 'added:B', 'unchanged:c']);
}

// ── Insertion in the middle ────────────────────────────────────────────
console.log('\n── Insert in middle ──');
{
  const d = computeLineDiff('a\nc', 'a\nb\nc');
  eq('1 added, 0 removed, 2 unchanged', d.stats, { added: 1, removed: 0, unchanged: 2 });
  eq('inline kinds', d.inline.map((l) => l.kind), ['unchanged', 'added', 'unchanged']);
}

// ── Line number tracking ───────────────────────────────────────────────
console.log('\n── Line numbers ──');
{
  const d = computeLineDiff('a\nb\nc', 'a\nB\nc');
  // Before-side 'b' is line 2 of before, after-side 'B' is line 2 of after.
  const beforeRemove = d.before.find((l) => l.kind === 'removed')!;
  const afterAdd = d.after.find((l) => l.kind === 'added')!;
  eq('before removed line number', beforeRemove.lineNumber, 2);
  eq('after added line number', afterAdd.lineNumber, 2);
}

// ── Realistic Neuron-sized diff ────────────────────────────────────────
console.log('\n── Realistic Neuron body ──');
{
  const before = `---
title: Stress
---

# Stress

## Grad 1
Let skub af kroppens reserver.

## Grad 2
Tydelig afmatning. Søvnforstyrrelser.

## Grad 3
Kronisk træthed.`;
  const after = `---
title: Stress
---

# Stress

## Grad 1
Let skub af kroppens reserver.

## Grad 2
Tydelig afmatning. Søvnforstyrrelser. Tidligt morgenopvågnen.

## Grad 3
Kronisk træthed.

## Grad 4
Udbrændthed. Kræver lægefaglig opfølgning.`;

  const d = computeLineDiff(before, after);
  assert('more added than removed', d.stats.added > d.stats.removed);
  assert('many unchanged lines kept', d.stats.unchanged > 5);
  // Assert the new Grad 4 heading appears in after, not before
  const addedTexts = d.inline.filter((l) => l.kind === 'added').map((l) => l.text);
  assert('Grad 4 heading added', addedTexts.some((t) => t === '## Grad 4'));
}

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '✓ all passed' : `✗ ${failures} failures`}`);
if (failures > 0) process.exit(1);
