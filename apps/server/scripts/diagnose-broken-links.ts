/**
 * Diagnose the 202 broken_links findings across 9 KBs to understand
 * what's salvageable. Categorizes by pattern:
 *
 *   A. Has suggested_fix where suggestion looks high-confidence (the
 *      suggestion's slug is close to the broken link's slug, e.g.
 *      `[[Qi (energy)]] → [[Qi (energi)]]` — English/Danish drift)
 *   B. Has suggested_fix but low-confidence (Levenshtein-2 random
 *      match like `[[rag]] → [[Log]]`)
 *   C. No suggested_fix at all — genuinely broken or hallucinated
 *   D. Frequency — is the same linkText appearing many times? One
 *      curator decision can resolve many rows.
 *
 * Read-only: no writes, safe to run repeatedly.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLibsqlDatabase } from '@trail/db';
import { slugify, normalizedSlug } from '@trail/shared';

const trail = await createLibsqlDatabase({ path: join(homedir(), 'Apps/broberg/trail/data/trail.db') });

// --- 1. Category breakdown per KB ----------------------------------------
const byKb = await trail.execute(`
  SELECT
    kb.name AS kb_name,
    kb.language,
    SUM(CASE WHEN bl.suggested_fix IS NOT NULL THEN 1 ELSE 0 END) AS with_suggestion,
    SUM(CASE WHEN bl.suggested_fix IS NULL THEN 1 ELSE 0 END) AS without_suggestion,
    COUNT(*) AS total
  FROM broken_links bl
  JOIN knowledge_bases kb ON kb.id = bl.knowledge_base_id
  WHERE bl.status = 'open'
  GROUP BY kb.id
  ORDER BY total DESC
`);
console.log('\n=== 1. Per-KB breakdown ===');
console.table(byKb.rows);

// --- 2. Link-text frequency (same broken link across many rows) ----------
const freq = await trail.execute(`
  SELECT
    bl.link_text,
    COUNT(*) AS occurrences,
    MAX(bl.suggested_fix) AS suggested_fix,
    GROUP_CONCAT(DISTINCT kb.name) AS kbs
  FROM broken_links bl
  JOIN knowledge_bases kb ON kb.id = bl.knowledge_base_id
  WHERE bl.status = 'open'
  GROUP BY bl.link_text
  HAVING occurrences > 1
  ORDER BY occurrences DESC
  LIMIT 20
`);
console.log('\n=== 2. Most-repeated broken linkTexts (one fix solves many rows) ===');
for (const r of freq.rows as any[]) {
  console.log(`  ${String(r.occurrences).padStart(3)}×  [[${r.link_text}]]  ${r.suggested_fix ? `→ ${r.suggested_fix}` : '(no fix)'}  in: ${r.kbs}`);
}

// --- 3. Suggestion-confidence classification -----------------------------
// For each finding with a suggested_fix, compute Levenshtein-distance of
// slugify(linkText) vs slugify(extractTitle(suggested_fix)). Low distance
// = same concept spelled differently. High distance = likely false match.
function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array(n + 1).fill(0).map((_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i-1] === b[j-1] ? 0 : 1));
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

const withSugg = await trail.execute(`
  SELECT bl.link_text, bl.suggested_fix, kb.language, kb.name AS kb_name
  FROM broken_links bl
  JOIN knowledge_bases kb ON kb.id = bl.knowledge_base_id
  WHERE bl.status = 'open' AND bl.suggested_fix IS NOT NULL
`);

const cats = { high: [] as any[], medium: [] as any[], low: [] as any[] };
for (const r of withSugg.rows as any[]) {
  // suggested_fix is in [[Title]] form — extract title
  const sf = String(r.suggested_fix).replace(/^\[\[|\]\]$/g, '');
  const linkSlug = slugify(r.link_text);
  const sfSlug = slugify(sf);
  const foldedLink = normalizedSlug(linkSlug, r.language);
  const foldedSf = normalizedSlug(sfSlug, r.language);
  const rawDist = lev(linkSlug, sfSlug);
  const foldedDist = lev(foldedLink, foldedSf);
  const bestDist = Math.min(rawDist, foldedDist);
  const item = { linkText: r.link_text, fix: sf, dist: bestDist, kb: r.kb_name };
  if (bestDist <= 1) cats.high.push(item);
  else if (bestDist === 2) cats.medium.push(item);
  else cats.low.push(item);
}

console.log('\n=== 3. Confidence classification (by slug-distance after fold) ===');
console.log(`\n  HIGH confidence (dist ≤ 1) — likely correct: ${cats.high.length}`);
for (const x of cats.high.slice(0, 30)) {
  console.log(`    [[${x.linkText}]] → ${x.fix}  (dist=${x.dist}, ${x.kb})`);
}
console.log(`\n  MEDIUM (dist = 2) — inspect before accept: ${cats.medium.length}`);
for (const x of cats.medium.slice(0, 15)) {
  console.log(`    [[${x.linkText}]] → ${x.fix}  (${x.kb})`);
}
console.log(`\n  LOW (dist ≥ 3) — probably false positive: ${cats.low.length}`);
for (const x of cats.low.slice(0, 10)) {
  console.log(`    [[${x.linkText}]] → ${x.fix}  (dist=${x.dist}, ${x.kb})`);
}

// --- 4. No-suggestion findings: any pattern? -----------------------------
const noSugg = await trail.execute(`
  SELECT bl.link_text, COUNT(*) AS n, GROUP_CONCAT(DISTINCT kb.name) AS kbs
  FROM broken_links bl
  JOIN knowledge_bases kb ON kb.id = bl.knowledge_base_id
  WHERE bl.status = 'open' AND bl.suggested_fix IS NULL
  GROUP BY bl.link_text
  ORDER BY n DESC
  LIMIT 15
`);
console.log('\n=== 4. Top findings WITHOUT suggested_fix ===');
for (const r of noSugg.rows as any[]) {
  console.log(`  ${String(r.n).padStart(3)}×  [[${r.link_text}]]  in: ${r.kbs}`);
}

// --- 5. Summary totals ---------------------------------------------------
const summary = await trail.execute(`
  SELECT
    SUM(CASE WHEN suggested_fix IS NOT NULL THEN 1 ELSE 0 END) AS with_sugg,
    SUM(CASE WHEN suggested_fix IS NULL THEN 1 ELSE 0 END) AS without_sugg,
    COUNT(*) AS total
  FROM broken_links WHERE status = 'open'
`);
console.log('\n=== 5. Overall ===');
console.table(summary.rows);
console.log(`\n  Salvage-ready (HIGH confidence): ${cats.high.length}`);
console.log(`  Need curator-review (MEDIUM): ${cats.medium.length}`);
console.log(`  Likely-dismiss (LOW confidence suggestion): ${cats.low.length}`);
console.log(`  No suggestion — need manual work: ${(summary.rows[0] as any).without_sugg}`);
