import { createLibsqlDatabase, knowledgeBases, brokenLinks, documents } from '@trail/db';
import { eq, and, sql } from 'drizzle-orm';
import { join } from 'node:path';
import { homedir } from 'node:os';

const trail = await createLibsqlDatabase({ path: join(homedir(), 'Apps/broberg/trail/data/trail.db') });

// Total broken_links by KB
const byKb = await trail.execute(`
  SELECT kb.name, kb.slug, kb.language,
         COUNT(bl.id) AS open_findings
  FROM knowledge_bases kb
  LEFT JOIN broken_links bl ON bl.knowledge_base_id = kb.id AND bl.status = 'open'
  GROUP BY kb.id
  ORDER BY open_findings DESC, kb.name
`);
console.log('\n=== F148 smoke: open broken_links per KB ===');
console.table(byKb.rows);

// Sample findings with suggested_fix
const sample = await trail.execute(`
  SELECT d.title AS from_title, bl.link_text, bl.suggested_fix, bl.status
  FROM broken_links bl
  JOIN documents d ON d.id = bl.from_document_id
  WHERE bl.status = 'open'
  ORDER BY bl.suggested_fix IS NULL, bl.reported_at DESC
  LIMIT 10
`);
console.log('\n=== Sample 10 findings (sorted: has-suggestion first) ===');
for (const r of sample.rows as any[]) {
  console.log(`  ${r.from_title?.slice(0, 40).padEnd(40)} [[${r.link_text}]] → ${r.suggested_fix ?? '(no suggestion)'}`);
}

// Verify development-tester exists
const dt = await trail.db.select().from(knowledgeBases).where(eq(knowledgeBases.slug, 'development-tester')).get();
console.log('\n=== /kb/development-tester/neurons ===');
console.log(dt ? `KB "${dt.name}" exists (language=${dt.language})` : 'NOT FOUND');
if (dt) {
  const dtFindings = await trail.db.select({ count: sql`COUNT(*)` }).from(brokenLinks).where(and(eq(brokenLinks.knowledgeBaseId, dt.id), eq(brokenLinks.status, 'open'))).get();
  console.log(`  Open findings: ${dtFindings?.count}`);
}
