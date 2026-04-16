#!/usr/bin/env bun
/**
 * Legacy path normaliser — llmwiki stored paths as `/wiki/…`; trail stores
 * them as `/neurons/…`. Keep the import script honest by rewriting on the
 * way in, so re-runs against the old DB don't reintroduce the old namespace.
 */
function normaliseLegacyPath(p: string | null | undefined): string | null {
  if (!p) return null;
  return p.startsWith('/wiki/') ? '/neurons/' + p.slice('/wiki/'.length) : p;
}

/**
 * Port Sanne Andersen's sources + compiled wiki pages from the old
 * /Users/cb/Apps/cbroberg/llmwiki-ts prototype into the running trail engine.
 *
 * Layout of the old system:
 *   DB  → /Users/cb/Apps/cbroberg/llmwiki-ts/data/llmwiki.db (bun:sqlite)
 *   FS  → /Users/cb/Apps/cbroberg/llmwiki-ts/data/<old-kb>/<old-doc>/source.<ext>
 *
 * The old schema has no `kind` column; we distinguish by file extension:
 *   .pdf / .docx / .doc / .pptx → source
 *   .md                         → wiki page (already-compiled)
 *
 * `overview.md` and `log.md` are skipped because the target KB already has
 * auto-seeded versions from F17 Session B's bootstrap path.
 *
 * Ports go to the running trail engine via HTTP so we exercise the real
 * pipeline end-to-end — not direct DB writes:
 *   - sources  → POST /api/v1/knowledge-bases/:id/documents/upload (multipart)
 *                 then PATCH status='ready' without triggering ingest
 *                 (we don't want the MCP to regenerate wiki pages since we are
 *                 also porting the old compiled wiki pages right below)
 *   - wiki     → POST /api/v1/queue/candidates with kind='ingest-summary',
 *                 metadata.op='create', auto-approved via system actor policy
 *
 * Requires: engine running with TRAIL_DEV_AUTH=1 and a seeded session cookie.
 *
 * Usage:
 *   ENGINE=http://localhost:3021 \
 *   SESSION=dev \
 *   TARGET_KB=<new-kb-id-from-the-running-engine> \
 *   bun run scripts/port-sanne-from-llmwiki.ts
 */
import { Database } from 'bun:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const OLD_ROOT = '/Users/cb/Apps/cbroberg/llmwiki-ts';
const OLD_DB = join(OLD_ROOT, 'data', 'llmwiki.db');
const OLD_DATA_ROOT = join(OLD_ROOT, 'data');
const OLD_KB_NAME = 'Sanne Andersen';

const ENGINE = process.env.ENGINE ?? 'http://localhost:3021';
const SESSION = process.env.SESSION ?? 'dev';
const TARGET_KB = process.env.TARGET_KB;

if (!TARGET_KB) {
  console.error('TARGET_KB required. Find it by GET /api/v1/knowledge-bases on the engine.');
  process.exit(1);
}

interface OldDoc {
  id: string;
  kb_id: string;
  user_id: string;
  filename: string;
  title: string | null;
  path: string;
  file_type: string;
  file_size: number;
  page_count: number | null;
  content: string | null;
  tags: string | null;
}

const SOURCE_EXTENSIONS = new Set(['pdf', 'docx', 'doc', 'pptx', 'ppt', 'md', 'txt']);
const WIKI_EXTENSIONS = new Set(['md']);
const SKIP_FILENAMES = new Set(['overview.md', 'log.md']);

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: `session=${SESSION}`, ...extra };
}

async function insertSource(doc: OldDoc): Promise<{ ok: boolean; detail: string }> {
  const ext = (extname(doc.filename) || `.${doc.file_type}`).replace(/^\./, '').toLowerCase();
  // Old disk layout is /data/<user-uuid>/<doc-uuid>/source.<ext>, not
  // /data/<kb-uuid>/... — the old prototype keyed uploads by owner.
  const onDisk = join(OLD_DATA_ROOT, doc.user_id, doc.id, `source.${ext}`);
  if (!existsSync(onDisk)) return { ok: false, detail: `missing file ${onDisk}` };

  const bytes = readFileSync(onDisk);
  const blob = new Blob([new Uint8Array(bytes)], {
    type: ext === 'pdf' ? 'application/pdf' : 'application/octet-stream',
  });

  const form = new FormData();
  form.append('file', blob, doc.filename);
  form.append('path', doc.path || '/');

  const res = await fetch(`${ENGINE}/api/v1/knowledge-bases/${TARGET_KB}/documents/upload`, {
    method: 'POST',
    headers: headers(),
    body: form,
  });
  const body = await res.text();
  return { ok: res.ok, detail: `${res.status} ${body.slice(0, 160)}` };
}

async function insertWikiAsCandidate(doc: OldDoc): Promise<{ ok: boolean; detail: string }> {
  if (!doc.content || !doc.content.trim()) return { ok: false, detail: 'empty content' };

  // Strip .md from filename for the metadata — approveCandidate re-appends it.
  const filenameStem = doc.filename.replace(/\.md$/i, '');

  // Step 1: create the candidate. HTTP-endpoint marks the caller as
  // actor.kind='user', so shouldAutoApprove returns false and the candidate
  // stays pending. (System-actor auto-approval would need direct @trail/core
  // access — we deliberately go through the real HTTP pipeline to exercise
  // the same write path a future admin-UI port button would use.)
  const createRes = await fetch(`${ENGINE}/api/v1/queue/candidates`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      knowledgeBaseId: TARGET_KB,
      kind: 'ingest-summary',
      title: doc.title ?? filenameStem,
      content: doc.content,
      metadata: JSON.stringify({
        op: 'create',
        filename: filenameStem,
        path: normaliseLegacyPath(doc.path) || '/neurons/',
        tags: doc.tags ?? null,
      }),
      confidence: 1,
    }),
  });
  if (!createRes.ok) {
    return { ok: false, detail: `create ${createRes.status} ${(await createRes.text()).slice(0, 160)}` };
  }
  const created = (await createRes.json()) as {
    candidate: { id: string };
    approval?: { documentId: string };
  };
  if (created.approval) {
    return { ok: true, detail: `auto-approved, doc=${created.approval.documentId}` };
  }

  // Step 2: approve as curator (same dev user). Produces the wiki document,
  // the wiki_events row, and the source_candidate_id back-pointer just like
  // a human curator click in the admin UI.
  const approveRes = await fetch(
    `${ENGINE}/api/v1/queue/${created.candidate.id}/approve`,
    {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        filename: filenameStem,
        path: normaliseLegacyPath(doc.path) || '/neurons/',
        notes: 'Ported from llmwiki-ts',
      }),
    },
  );
  if (!approveRes.ok) {
    return { ok: false, detail: `approve ${approveRes.status} ${(await approveRes.text()).slice(0, 160)}` };
  }
  const approved = (await approveRes.json()) as { documentId: string; wikiEventId: string };
  return { ok: true, detail: `approved, doc=${approved.documentId}, event=${approved.wikiEventId}` };
}

async function main() {
  console.log(`Porting "${OLD_KB_NAME}" → ${ENGINE} (KB ${TARGET_KB})\n`);

  // bun:sqlite readonly mode trips on this file's permissions; open read-write
  // (we never mutate, just SELECT). The engine doesn't hold this file so there
  // is no concurrent-access concern.
  const old = new Database(OLD_DB);
  const kbRow = old
    .prepare('SELECT id FROM knowledge_bases WHERE name = ?')
    .get(OLD_KB_NAME) as { id: string } | undefined;
  if (!kbRow) {
    console.error(`No KB named "${OLD_KB_NAME}" in old DB.`);
    process.exit(1);
  }
  const docs = old
    .prepare(
      `SELECT id, knowledge_base_id as kb_id, user_id, filename, title, path, file_type,
              file_size, page_count, content, tags
         FROM documents
        WHERE knowledge_base_id = ?
        ORDER BY created_at`,
    )
    .all(kbRow.id) as OldDoc[];

  console.log(`Found ${docs.length} docs in old KB. Routing by extension…\n`);

  let ported = 0;
  let skipped = 0;
  let failed: Array<{ doc: OldDoc; detail: string }> = [];

  for (const d of docs) {
    const ext = (extname(d.filename) || `.${d.file_type}`).replace(/^\./, '').toLowerCase();
    const label = `${d.filename.padEnd(56)}`;

    if (SKIP_FILENAMES.has(d.filename)) {
      console.log(`  skip  ${label}  (auto-seeded by F17)`);
      skipped++;
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(ext)) {
      console.log(`  skip  ${label}  (unrecognised extension .${ext})`);
      skipped++;
      continue;
    }

    // Sources: .pdf, .docx, etc. + .md files that are NOT recognisable wiki
    //          pages (short, no frontmatter — tricky; we use a heuristic
    //          below instead). For Sanne's data the split is cleaner: PDFs
    //          are sources, .md files in the old DB are all compiled wiki.
    const isWiki = WIKI_EXTENSIONS.has(ext);

    try {
      const result = isWiki
        ? await insertWikiAsCandidate(d)
        : await insertSource(d);
      if (result.ok) {
        console.log(`  ok    ${label}  ${isWiki ? 'wiki' : 'source'} — ${result.detail}`);
        ported++;
      } else {
        console.log(`  FAIL  ${label}  ${result.detail}`);
        failed.push({ doc: d, detail: result.detail });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ERR   ${label}  ${msg}`);
      failed.push({ doc: d, detail: msg });
    }
  }

  old.close();

  console.log(`\nDone. ${ported} ported, ${skipped} skipped, ${failed.length} failed.`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.doc.filename}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
