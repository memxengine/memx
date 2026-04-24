/**
 * F28 — verify the pipeline registry routes the right format to the
 * right pipeline. Pure unit-test of the registry — doesn't actually
 * run any extractor (no buffer needed).
 *
 * Run: bun run packages/pipelines/scripts/verify-registry.ts
 */

import { listPipelines, pickPipeline } from '../src/index.js';

let failures = 0;
function assert(label: string, cond: unknown, detail?: string): void {
  if (!cond) {
    failures++;
    console.error(`✗ ${label}${detail ? `\n    ${detail}` : ''}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// ── All 4 built-ins registered ────────────────────────────────────────
console.log('── Registered pipelines ──');
const names = listPipelines().map((p) => p.name);
console.log(`  registry: [${names.join(', ')}]`);
assert('4 built-in pipelines registered', names.length === 4, `got ${names.length}`);
for (const name of ['pdf', 'docx', 'pptx', 'xlsx']) {
  assert(`${name} registered`, names.includes(name));
}

// ── Extension-based dispatch ─────────────────────────────────────────
console.log('\n── Extension-based dispatch ──');
{
  assert('pdf for "foo.pdf"', pickPipeline('foo.pdf')?.name === 'pdf');
  assert('pdf for "Foo.PDF" (case-insensitive)', pickPipeline('Foo.PDF')?.name === 'pdf');
  assert('docx for "report.docx"', pickPipeline('report.docx')?.name === 'docx');
  assert('pptx for "deck.pptx"', pickPipeline('deck.pptx')?.name === 'pptx');
  assert('xlsx for "sheet.xlsx"', pickPipeline('sheet.xlsx')?.name === 'xlsx');
  assert('null for unknown ext', pickPipeline('img.png') === null);
  assert('null for missing ext', pickPipeline('README') === null);
}

// ── MIME-based dispatch wins over extension ─────────────────────────
console.log('\n── MIME wins over extension ──');
{
  // MIME match scores 1, extension scores 0.95 — MIME wins.
  const winner = pickPipeline('foo.pdf', 'application/pdf');
  assert('exact MIME match scores 1', winner?.name === 'pdf');
  // Wrong filename + correct MIME still routes correctly
  const w2 = pickPipeline('untitled', 'application/pdf');
  assert('MIME-only routing works', w2?.name === 'pdf');
}

// ── accepts() scoring shape ─────────────────────────────────────────
console.log('\n── accepts() scoring ──');
{
  const pdf = listPipelines().find((p) => p.name === 'pdf')!;
  assert('pdf.accepts foo.pdf without MIME = 0.95', pdf.accepts('foo.pdf') === 0.95);
  assert('pdf.accepts with MIME = 1.0', pdf.accepts('foo.pdf', 'application/pdf') === 1);
  assert('pdf.accepts non-pdf = 0', pdf.accepts('foo.docx') === 0);
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '✓ all passed' : `✗ ${failures} failures`}`);
if (failures > 0) process.exit(1);
