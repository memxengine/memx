#!/usr/bin/env bun
/**
 * trail-save — post a cc-session decision into the `trail-development` KB.
 *
 * Usage:
 *   bun scripts/trail-save.ts "F32.1 split decision" \
 *     --content "chose orphans+stale first; LLM detectors wait for iter 2"
 *
 *   # Or pipe content from stdin:
 *   echo "..." | bun scripts/trail-save.ts "Title here"
 *
 *   # With a custom kind (default: external-feed):
 *   bun scripts/trail-save.ts "Refactor plan" --kind cross-ref-suggestion
 *
 * Flags:
 *   --content <text>   Explicit content (falls back to stdin, then just git context)
 *   --kind <enum>      QueueCandidateKind. Default: external-feed.
 *   --confidence <n>   0-1. Default: 0.7 (below F19 auto-approve threshold so
 *                      it always lands pending for review).
 *   --kb <slug|id>     Target KB. Default: trail-development.
 *   --engine <url>     Engine base. Default: http://127.0.0.1:58021.
 *
 * Auto-captures git context as a tail on the posted content so every
 * decision carries provenance — branch, last 3 commits, current dirty-state.
 *
 * Authentication via TRAIL_INGEST_TOKEN (env → ~/.trail/.env → buddy/.env).
 * Same Bearer-auth path buddy's F39 extractor uses.
 */
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { slugify } from '@trail/shared';

interface Options {
  title: string;
  content?: string;
  kind: string;
  confidence: number;
  kbSlugOrId: string;
  engine: string;
}

function parseArgs(argv: string[]): Options {
  const rest = [...argv];
  let title: string | undefined;
  let content: string | undefined;
  let kind = 'external-feed';
  let confidence = 0.7;
  let kbSlugOrId = 'trail-development';
  let engine = process.env.TRAIL_ENGINE ?? 'http://127.0.0.1:58021';

  while (rest.length) {
    const arg = rest.shift()!;
    switch (arg) {
      case '--content': content = rest.shift(); break;
      case '--kind': kind = rest.shift() ?? kind; break;
      case '--confidence': confidence = Number(rest.shift() ?? confidence); break;
      case '--kb': kbSlugOrId = rest.shift() ?? kbSlugOrId; break;
      case '--engine': engine = rest.shift() ?? engine; break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (title === undefined) title = arg;
        else throw new Error(`Unexpected arg: ${arg}`);
    }
  }

  if (!title) {
    printHelp();
    process.exit(1);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('--confidence must be 0..1');
  }

  return { title, content, kind, confidence, kbSlugOrId, engine };
}

function printHelp(): void {
  console.log(`trail-save — post a session decision into trail-development.

Usage: bun scripts/trail-save.ts "<title>" [options]

Options:
  --content <text>       explicit content (else: stdin, then git context only)
  --kind <enum>          candidate kind (default external-feed)
  --confidence <0-1>     default 0.7 (below auto-approve threshold)
  --kb <slug|id>         default trail-development
  --engine <url>         default http://127.0.0.1:58021
`);
}

function resolveToken(): string {
  if (process.env.TRAIL_INGEST_TOKEN) return process.env.TRAIL_INGEST_TOKEN;
  const candidates = [
    join(homedir(), '.trail', '.env'),
    join(homedir(), 'Apps', 'webhouse', 'buddy', '.env'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const match = text.match(/^TRAIL_INGEST_TOKEN=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  }
  throw new Error(
    'TRAIL_INGEST_TOKEN not found. Export it, or write it to ~/.trail/.env.',
  );
}

function readStdin(): string {
  try {
    const buf = readFileSync(0, 'utf8');
    return buf;
  } catch {
    return '';
  }
}

function gitContext(): string {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const log = run('git', ['log', '--oneline', '-n', '3']);
  const diffStat = run('git', ['diff', '--stat', 'HEAD']);
  const head = run('git', ['rev-parse', 'HEAD']).slice(0, 12);

  const parts = ['\n---\n\n## Git context at save\n'];
  parts.push(`- branch: \`${branch}\``);
  parts.push(`- HEAD: \`${head}\``);
  if (log) parts.push('\n### Recent commits\n\n```\n' + log + '\n```');
  if (diffStat.trim()) parts.push('\n### Uncommitted changes\n\n```\n' + diffStat + '\n```');
  return parts.join('\n');
}

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: process.cwd(), encoding: 'utf8' });
  return r.stdout.trim();
}

async function resolveKb(engine: string, token: string, slugOrId: string): Promise<string> {
  // If it looks like a UUID pass through; else query /knowledge-bases and match by slug.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId)) {
    return slugOrId;
  }
  const res = await fetch(`${engine}/api/v1/knowledge-bases`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`list KBs: ${res.status} ${await res.text()}`);
  const kbs = (await res.json()) as Array<{ id: string; slug: string; name: string }>;
  const match = kbs.find((kb) => kb.slug === slugOrId);
  if (!match) {
    throw new Error(`KB "${slugOrId}" not found. Available: ${kbs.map((k) => k.slug).join(', ')}`);
  }
  return match.id;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const token = resolveToken();
  const kbId = await resolveKb(opts.engine, token, opts.kbSlugOrId);

  // Content resolution: explicit flag > stdin > empty body (git context only).
  let body = opts.content ?? '';
  if (!body && !process.stdin.isTTY) {
    body = readStdin().trim();
  }

  const content = [
    `# ${opts.title}`,
    '',
    body || '_No body — this entry records the git state at a point in the session._',
    gitContext(),
  ].join('\n');

  const slug = slugify(opts.title);
  const metadata = JSON.stringify({
    op: 'create',
    filename: `${slug}.md`,
    path: '/neurons/sessions/trail-dev/',
    source: 'trail-cc',
    sessionDate: new Date().toISOString().slice(0, 10),
  });

  const res = await fetch(`${opts.engine}/api/v1/queue/candidates`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      knowledgeBaseId: kbId,
      kind: opts.kind,
      title: opts.title,
      content,
      metadata,
      confidence: opts.confidence,
    }),
  });

  if (!res.ok) {
    console.error(`POST failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    candidate: { id: string; status: string };
    approval?: { documentId: string };
  };
  const adminBase = (process.env.TRAIL_ADMIN_URL ?? 'http://127.0.0.1:58031').replace(/\/$/, '');
  console.log(`saved → ${data.candidate.id} (${data.candidate.status})`);
  if (data.approval) {
    console.log(`  auto-approved → document ${data.approval.documentId}`);
  } else {
    console.log(`  review in queue: ${adminBase}/kb/${kbId}/queue`);
  }
}

main().catch((err) => {
  console.error('trail-save:', err instanceof Error ? err.message : err);
  process.exit(1);
});
