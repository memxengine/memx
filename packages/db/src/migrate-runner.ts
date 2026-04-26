/**
 * Custom hash-based migration runner.
 *
 * Replaces drizzle-orm/libsql/migrator's stock `migrate()` function.
 * The stock implementation has two failure modes that bit us in
 * production (April 2026):
 *
 *   1. **Timestamp-only ordering.** Stock uses
 *      `created_at < migration.folderMillis` to decide which migrations
 *      to apply. Once any migration with an artificial-future `when`
 *      lands in `__drizzle_migrations`, every legitimate later migration
 *      with a smaller real-time `when` is silently skipped. We hit this
 *      because 16-20 had hand-edited future `when` values; 21+22 created
 *      via real `Date.now()` slipped under that ceiling and were never
 *      applied — even though they appeared in the journal.
 *
 *   2. **Whole-file execution.** Stock executes each migration's `sql`
 *      array element via `db.run()`. The array comes from splitting on
 *      `--> statement-breakpoint`. A migration without breakpoint markers
 *      is treated as ONE statement; libSQL's `execute` only runs the
 *      first SQL statement in a semicolon-separated string and silently
 *      ignores the rest. Migration 0022 had no breakpoints; only the
 *      first table got created, but the hash was inserted into
 *      `__drizzle_migrations` so future runs treated it as "applied".
 *
 * This runner fixes both:
 *
 *   - **Hash-based skip.** Iterate journal entries in `idx` order. For
 *     each, check if its hash is in `__drizzle_migrations`. If yes,
 *     skip — regardless of `when` ordering. If no, apply.
 *
 *   - **Split-then-execute every statement.** Split by
 *     `--> statement-breakpoint` first; if no breakpoints found, fall
 *     back to splitting by `;` at top-level (respects strings). Each
 *     non-empty statement runs as its own `execute`. Multi-table
 *     migrations Just Work.
 *
 *   - **Idempotent record.** The hash insert is the LAST step of each
 *     migration, only after every statement succeeds. A partial-apply
 *     bug like 0022's would now leave the migration unrecorded — next
 *     boot retries it.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Client as LibSqlClient } from '@libsql/client';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export async function runMigrationsByHash(
  client: LibSqlClient,
  migrationsFolder: string,
): Promise<void> {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    throw new Error(`Migration journal missing: ${journalPath}`);
  }
  const journal: Journal = JSON.parse(readFileSync(journalPath, 'utf8'));

  // Ensure tracking table exists. Same shape as drizzle's stock so the
  // table stays interoperable if anyone ever falls back to drizzle's
  // migrator (e.g. for inspection).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);

  const appliedRows = await client.execute(
    `SELECT hash FROM __drizzle_migrations`,
  );
  const applied = new Set(
    (appliedRows.rows as unknown as Array<{ hash: string }>).map((r) => r.hash),
  );

  // Sort by idx, NOT by when. The when field is unreliable — it's been
  // hand-edited in this repo's history, and even on a clean repo it
  // depends on wall-clock at generation time, which doesn't reflect
  // dependency order. The journal's idx is the canonical sequence.
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  for (const entry of entries) {
    const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) {
      throw new Error(`Migration SQL file missing: ${sqlPath}`);
    }
    const sql = readFileSync(sqlPath, 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');

    if (applied.has(hash)) continue;

    const statements = splitStatements(sql);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      await client.execute(trimmed);
    }

    // Hash insert is LAST. A failed mid-migration leaves the record
    // missing so a retry runs the file again — idempotent DDL like
    // CREATE TABLE IF NOT EXISTS handles this; non-idempotent DDL
    // (ALTER TABLE ADD COLUMN without IF-NOT-EXISTS) needs the migration
    // author to make it idempotent.
    await client.execute({
      sql: `INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`,
      args: [hash, entry.when],
    });
  }
}

/**
 * Split a migration's SQL into individual statements.
 *
 * Two paths:
 *
 *   - **drizzle-kit emissions** (have `--> statement-breakpoint`):
 *     split on that marker only. drizzle-kit emits exactly ONE statement
 *     per chunk, so each chunk is libsql-safe as-is. We do NOT also
 *     split on `;` because comment text containing `;` (e.g. "useful
 *     out of the box; curators...") would slice the comment in half
 *     and present the tail as a fake statement.
 *
 *   - **breakpoint-less migrations** (e.g. 0022): split on `;` at the
 *     top level via a tiny tokenizer that respects `--` line comments
 *     and `'...'` string literals. Each `;` outside a comment / string
 *     is a real statement boundary.
 *
 * Comment-only chunks (header docs) are filtered out so they don't
 * trip libsql's "SQLITE_OK: not an error" on an empty parse.
 */
function splitStatements(sql: string): string[] {
  const chunks = sql.includes('--> statement-breakpoint')
    ? sql.split('--> statement-breakpoint')
    : splitBySemicolonTopLevel(sql);
  const out: string[] = [];
  for (const chunk of chunks) {
    if (hasExecutableSql(chunk)) {
      out.push(chunk.trim());
    }
  }
  return out;
}

function splitBySemicolonTopLevel(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    // Line comment — copy through to newline so any `;` inside is preserved.
    if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? sql.length : eol + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    // Single-quoted string — copy through to closing quote (doubled-up
    // '' is the SQL escape for a literal quote, handled by the inner loop).
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < sql.length) {
        const c2 = sql[i]!;
        buf += c2;
        i++;
        if (c2 === "'") {
          if (sql[i] === "'") {
            buf += sql[i];
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    // Statement boundary.
    if (ch === ';') {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function hasExecutableSql(chunk: string): boolean {
  for (const line of chunk.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    if (t.startsWith('--')) continue;
    return true;
  }
  return false;
}
