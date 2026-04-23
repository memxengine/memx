import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export interface SimulatedKB {
  rootDir: string;
  sourceFile: string;
  sourceContent: string;
}

export function createSimulatedKB(rootDir: string, sourceFile: string, sourceContent: string): SimulatedKB {
  return { rootDir, sourceFile, sourceContent };
}

export async function initKB(kb: SimulatedKB): Promise<void> {
  await mkdir(join(kb.rootDir, '/neurons/sources'), { recursive: true });
  await mkdir(join(kb.rootDir, '/neurons/concepts'), { recursive: true });
  await mkdir(join(kb.rootDir, '/neurons/entities'), { recursive: true });
  await writeFile(join(kb.rootDir, '/neurons/overview.md'), `---\ntitle: Overview\ntags: []\ndate: ${new Date().toISOString().slice(0, 10)}\nsources: []\n---\n\n# Knowledge Base Overview\n\nThis knowledge base is empty.\n`);
  await writeFile(join(kb.rootDir, '/neurons/log.md'), `---\ntitle: Ingest Log\ntags: []\ndate: ${new Date().toISOString().slice(0, 10)}\nsources: []\n---\n\n# Ingest Log\n`);
  await writeFile(join(kb.rootDir, '/neurons/glossary.md'), `---\ntitle: Glossary\ntags: []\ndate: ${new Date().toISOString().slice(0, 10)}\nsources: []\n---\n\n# Glossary\n`);
  await mkdir(join(kb.rootDir, dirname(kb.sourceFile)), { recursive: true });
  await writeFile(join(kb.rootDir, kb.sourceFile), kb.sourceContent);
}

export async function cleanupKB(kb: SimulatedKB): Promise<void> {
  await rmDir(kb.rootDir);
}

async function rmDir(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rmDir(fullPath);
    } else {
      await unlink(fullPath);
    }
  }
  await unlink(dir).catch(() => {});
}

export function buildToolDefinitions() {
  return [
    {
      type: 'function' as const,
      function: {
        name: 'read',
        description: 'Read a file from the knowledge base. Returns the full content of the file at the given path.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file (e.g. "/neurons/overview.md" or "/sources/book.pdf.md")',
            },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'list_files',
        description: 'List/search files in the knowledge base. Use mode="list" to see all wiki files, or provide a query to search.',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['list'],
              description: 'Search mode. Use "list" to list all wiki files.',
            },
            kind: {
              type: 'string',
              enum: ['wiki', 'source'],
              description: 'Kind of files to list.',
            },
            query: {
              type: 'string',
              description: 'Search query text.',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'write',
        description: 'Write or modify a file in the knowledge base. Supports create, str_replace, and append operations.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              enum: ['create', 'str_replace', 'append'],
              description: 'Write command: "create" a new file, "str_replace" to find and replace text, "append" to add content.',
            },
            path: {
              type: 'string',
              description: 'Directory path for new files (e.g. "/neurons/concepts/")',
            },
            title: {
              type: 'string',
              description: 'File title or full path for str_replace/append (e.g. "/neurons/concepts/akupunktur.md")',
            },
            content: {
              type: 'string',
              description: 'Content to write, append, or replace with.',
            },
            old_str: {
              type: 'string',
              description: 'For str_replace: the exact text to find and replace.',
            },
            filename: {
              type: 'string',
              description: 'Filename for new files (auto-generated from title if not provided).',
            },
          },
          required: ['command'],
        },
      },
    },
  ];
}

export function createToolExecutor(kb: SimulatedKB) {
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case 'read':
        return toolRead(kb, args);
      case 'list_files':
        return toolSearch(kb, args);
      case 'write':
        return toolWrite(kb, args);
      default:
        return `Unknown tool: ${name}`;
    }
  };
}

async function toolRead(kb: SimulatedKB, args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? '');
  if (!path) return 'Error: path is required';
  const fullPath = join(kb.rootDir, path);
  try {
    const content = await readFile(fullPath, 'utf-8');
    return content;
  } catch {
    return `Error: File not found at ${path}`;
  }
}

async function toolSearch(kb: SimulatedKB, args: Record<string, unknown>): Promise<string> {
  const mode = String(args.mode ?? args.kind ?? 'list');
  const neuronsDir = join(kb.rootDir, 'neurons');
  const results: Array<{ path: string; title: string; kind: string }> = [];

  async function walkDir(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walkDir(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.md')) {
        const title = entry.name.replace(/\.md$/, '').replace(/-/g, ' ');
        results.push({ path: `/neurons/${prefix}${entry.name}`, title, kind: 'wiki' });
      }
    }
  }

  await walkDir(neuronsDir, '');

  if (mode === 'source' || args.kind === 'source') {
    const sourcesDir = join(kb.rootDir, dirname(kb.sourceFile));
    let entries;
    try {
      entries = await readdir(sourcesDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        results.push({ path: `${dirname(kb.sourceFile)}/${entry.name}`, title: entry.name, kind: 'source' });
      }
    }
  }

  return JSON.stringify({ files: results, total: results.length }, null, 2);
}

async function toolWrite(kb: SimulatedKB, args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? '');
  const content = String(args.content ?? '');

  switch (command) {
    case 'create': {
      const dirPath = String(args.path ?? '/neurons/');
      const title = String(args.title ?? 'untitled');
      let filename = String(args.filename ?? '');
      if (!filename) {
        filename = title
          .replace(/^\/neurons\/(sources|concepts|entities)\//, '')
          .replace(/\.md$/, '')
          .toLowerCase()
          .replace(/[^a-z0-9æøåäö]+/g, '-')
          .replace(/^-|-$/g, '') + '.md';
      }
      const dir = dirPath.startsWith('/neurons/')
        ? join(kb.rootDir, dirPath)
        : join(kb.rootDir, '/neurons/', dirPath);
      await mkdir(dir, { recursive: true });
      const fullPath = join(dir, filename);
      await writeFile(fullPath, content, 'utf-8');
      return `Created ${dirPath}${filename}`;
    }
    case 'str_replace': {
      const title = String(args.title ?? '');
      const oldStr = String(args.old_str ?? '');
      if (!title || !oldStr) return 'Error: title and old_str are required for str_replace';
      const relPath = title.startsWith('/') ? title : `/neurons/${title}`;
      const fullPath = join(kb.rootDir, relPath);
      try {
        let existing = await readFile(fullPath, 'utf-8');
        if (!existing.includes(oldStr)) {
          const fuzzy = oldStr.trim();
          const existingTrimmed = existing;
          const idx = existingTrimmed.indexOf(fuzzy);
          if (idx === -1) {
            return `Error: old_str not found in ${relPath}. The exact text to replace was not found in the file.`;
          }
          existing = existing.substring(0, idx) + content + existing.substring(idx + fuzzy.length);
        } else {
          existing = existing.replace(oldStr, content);
        }
        await writeFile(fullPath, existing, 'utf-8');
        return `Updated ${relPath}`;
      } catch {
        return `Error: File not found at ${relPath}`;
      }
    }
    case 'append': {
      const title = String(args.title ?? '');
      if (!title) return 'Error: title is required for append';
      const relPath = title.startsWith('/') ? title : `/neurons/${title}`;
      const fullPath = join(kb.rootDir, relPath);
      try {
        const existing = await readFile(fullPath, 'utf-8');
        await writeFile(fullPath, existing + '\n' + content, 'utf-8');
        return `Appended to ${relPath}`;
      } catch {
        return `Error: File not found at ${relPath}`;
      }
    }
    default:
      return `Error: Unknown command "${command}"`;
  }
}

export async function collectKBOutput(kb: SimulatedKB): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  const neuronsDir = join(kb.rootDir, 'neurons');

  async function walkAndCollect(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walkAndCollect(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.md')) {
        const content = await readFile(join(dir, entry.name), 'utf-8');
        output[`/neurons/${prefix}${entry.name}`] = content;
      }
    }
  }

  await walkAndCollect(neuronsDir, '');
  return output;
}
