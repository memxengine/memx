/**
 * F23 + F30 — end-to-end verification of the wiki-links shared package.
 *
 * Exercises every link shape + edge-type/display disambiguation + the
 * dedupe toggle + renderer output in both default-href and
 * cross-kb-resolved modes. Not a unit-test framework — just asserts
 * via bun's stdlib, fails loud.
 *
 * Run: `bun run packages/shared/scripts/verify-wiki-links.ts`
 */

import {
  parseWikiLinks,
  parseIntraKbLinks,
  rewriteWikiLinks,
  VALID_EDGE_TYPES,
} from '../src/wiki-links/index.js';

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

// ── Parser: intra-KB ────────────────────────────────────────────────────

console.log('\n── Parser: intra-KB ──');
{
  const r = parseWikiLinks('See [[Yin og Yang]] and [[NADA]].');
  eq('intra plain, 2 links', r.length, 2);
  eq('intra[0].target', r[0]!.target, 'Yin og Yang');
  eq('intra[0].kind', r[0]!.kind, 'intra');
  eq('intra[0].edgeType default cites', r[0]!.edgeType, 'cites');
  eq('intra[0].displayLabel null', r[0]!.displayLabel, null);
}

// ── Parser: pipe disambiguation ────────────────────────────────────────

console.log('\n── Parser: pipe disambiguation ──');
{
  const r = parseWikiLinks('[[Zen|is-a]] [[Yoga|Beautiful Yoga]] [[Tai Chi|UnknownLabel]]');
  eq('3 links', r.length, 3);
  eq('[[Zen|is-a]] → edgeType=is-a', r[0]!.edgeType, 'is-a');
  eq('[[Zen|is-a]] → displayLabel null', r[0]!.displayLabel, null);
  eq('[[Yoga|Beautiful Yoga]] → edgeType=cites', r[1]!.edgeType, 'cites');
  eq('[[Yoga|Beautiful Yoga]] → displayLabel=Beautiful Yoga', r[1]!.displayLabel, 'Beautiful Yoga');
  eq('[[Tai Chi|UnknownLabel]] → displayLabel kept', r[2]!.displayLabel, 'UnknownLabel');
}

// ── Parser: cross-kb ────────────────────────────────────────────────────

console.log('\n── Parser: cross-kb ──');
{
  const r = parseWikiLinks('[[kb:other-trail/Page Name]]');
  eq('1 link', r.length, 1);
  eq('kind=cross-kb', r[0]!.kind, 'cross-kb');
  eq('kbSlug=other-trail', r[0]!.kbSlug, 'other-trail');
  eq('target=Page Name', r[0]!.target, 'Page Name');
  eq('tenantSlug=null', r[0]!.tenantSlug, null);
}

// ── Parser: external ────────────────────────────────────────────────────

console.log('\n── Parser: external ──');
{
  const r = parseWikiLinks('[[ext:acme/main-trail/Page]]');
  eq('1 link', r.length, 1);
  eq('kind=external', r[0]!.kind, 'external');
  eq('tenantSlug=acme', r[0]!.tenantSlug, 'acme');
  eq('kbSlug=main-trail', r[0]!.kbSlug, 'main-trail');
  eq('target=Page', r[0]!.target, 'Page');
}

// ── Parser: malformed → rejected ────────────────────────────────────────

console.log('\n── Parser: malformed ──');
{
  eq('[[kb:slug]] alone → 0 links', parseWikiLinks('[[kb:slug]]').length, 0);
  eq('[[ext:tenant/kb]] → 0 links', parseWikiLinks('[[ext:tenant/kb]]').length, 0);
  eq('empty [[]] → 0 links', parseWikiLinks('[[]]').length, 0);
}

// ── Parser: frontmatter-strip ───────────────────────────────────────────

console.log('\n── Parser: frontmatter strip ──');
{
  const md = `---\nsources:\n  - "[[not-a-link]]"\n---\n\n# Body\n[[real]] is here.`;
  const withStrip = parseWikiLinks(md, { stripFrontmatter: true });
  const noStrip = parseWikiLinks(md, { stripFrontmatter: false });
  eq('with strip: 1 link', withStrip.length, 1);
  eq('with strip: target=real', withStrip[0]!.target, 'real');
  eq('no strip: 2 links', noStrip.length, 2);
}

// ── Parser: dedupe ──────────────────────────────────────────────────────

console.log('\n── Parser: dedupe ──');
{
  const r1 = parseWikiLinks('[[A]] [[A]] [[A]]', { dedupe: true });
  eq('dedupe=true → 1 link', r1.length, 1);
  const r2 = parseWikiLinks('[[A]] [[A]] [[A]]', { dedupe: false });
  eq('dedupe=false → 3 links', r2.length, 3);
}

// ── Parser: legacy intra-kb wrapper ─────────────────────────────────────

console.log('\n── Parser: legacy wrapper ──');
{
  const r = parseIntraKbLinks('[[A]] [[kb:other/B]] [[ext:t/k/C]]');
  eq('legacy drops cross-kb + ext', r.length, 1);
  eq('legacy[0].target=A', r[0]!.target, 'A');
}

// ── Renderer: intra-KB default href ─────────────────────────────────────

console.log('\n── Renderer: intra ──');
{
  const md = rewriteWikiLinks('See [[Yin og Yang]] today.', { currentKbId: 'kb-foo' });
  eq('intra → [Yin og Yang](/kb/kb-foo/neurons/yin-og-yang)',
    md,
    'See [Yin og Yang](/kb/kb-foo/neurons/yin-og-yang) today.',
  );
}

// ── Renderer: display label ─────────────────────────────────────────────

console.log('\n── Renderer: display label ──');
{
  const md = rewriteWikiLinks('[[Yoga|Beautiful Yoga]]', { currentKbId: 'kb' });
  eq('display label used', md, '[Beautiful Yoga](/kb/kb/neurons/yoga)');
}

// ── Renderer: edge-type pipe is invisible ──────────────────────────────

console.log('\n── Renderer: edge-type pipe ──');
{
  const md = rewriteWikiLinks('[[Zen|is-a]]', { currentKbId: 'kb' });
  eq('edge-type pipe hidden from display', md, '[Zen](/kb/kb/neurons/zen)');
}

// ── Renderer: cross-kb resolved ─────────────────────────────────────────

console.log('\n── Renderer: cross-kb resolved ──');
{
  const md = rewriteWikiLinks('[[kb:other-trail/Page A]]', {
    currentKbId: 'kb-current',
    resolveKbSlug: (slug) => (slug === 'other-trail' ? 'kb-other-id' : null),
  });
  eq('cross-kb resolved', md, '[Page A](/kb/kb-other-id/neurons/page-a)');
}

// ── Renderer: cross-kb unresolved ───────────────────────────────────────

console.log('\n── Renderer: cross-kb unresolved ──');
{
  const md = rewriteWikiLinks('[[kb:ghost-trail/Page]]', {
    currentKbId: 'kb',
    resolveKbSlug: () => null,
  });
  assert('unresolved cross-kb → placeholder href', md.includes('#unresolved-kb:ghost-trail'),
    `got=${md}`);
}

// ── Renderer: external ─────────────────────────────────────────────────

console.log('\n── Renderer: external ──');
{
  const md = rewriteWikiLinks('[[ext:acme/main/Page X]]', { currentKbId: 'kb' });
  assert('external → arrow + placeholder href', md.includes('Page X ↗') && md.includes('#external:acme'),
    `got=${md}`);
}

// ── Renderer: preserves surrounding text ──────────────────────────────

console.log('\n── Renderer: surrounding text ──');
{
  const md = rewriteWikiLinks(
    '## Title\n\nSome **bold** with [[Page]] and a [link](https://x.dk).\n\n- item',
    { currentKbId: 'kb' },
  );
  assert('preserves markdown around link',
    md === '## Title\n\nSome **bold** with [Page](/kb/kb/neurons/page) and a [link](https://x.dk).\n\n- item',
    `got=${md}`);
}

// ── Edge-type constants sanity ────────────────────────────────────────

console.log('\n── Edge-type set ──');
eq('7 edge types', VALID_EDGE_TYPES.length, 7);
assert('contains cites', VALID_EDGE_TYPES.includes('cites'));
assert('contains is-a', VALID_EDGE_TYPES.includes('is-a'));

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? '✓ all passed' : `✗ ${failures} failures`}`);
if (failures > 0) process.exit(1);
