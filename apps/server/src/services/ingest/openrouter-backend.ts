/**
 * F149 Phase 2b — OpenRouter backend.
 *
 * In-process HTTPS client to openrouter.ai's chat-completions API.
 * Dispatches tool-calls to Trail's CandidateQueueAPI directly (no MCP,
 * no subprocess). Supports single-pass ingest via any OpenRouter model;
 * two-pass (translator-drafts → main-expands) is out-of-scope for v1
 * but the field is already plumbed through IngestBackendInput.
 *
 * Cost: requests usage accounting (`usage: {include: true}`) so the
 * response includes actual cost in USD, not an estimated lookup.
 *
 * Tools exposed to the model mirror the CandidateQueueAPI surface:
 * `guide`, `search`, `read`, `write`. Argument shapes match the API's
 * types so the dispatch is a straight passthrough.
 *
 * Chain fallback: on any non-2xx or network error, throws so the
 * runner's chain-loop can advance to the next backend/model step.
 */

import type {
  IngestBackend,
  IngestBackendInput,
  IngestBackendResult,
} from './backend.js';
import type { CandidateQueueAPI } from '@trail/core';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOOL_RESPONSE_BYTES = 50_000;

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    cost?: number;  // present when `usage:{include:true}` is sent
  };
}

export class OpenRouterBackend implements IngestBackend {
  readonly id = 'openrouter' as const;

  async run(input: IngestBackendInput): Promise<IngestBackendResult> {
    if (!input.candidateApi) {
      throw new Error('OpenRouterBackend requires candidateApi in input (runner must pass it)');
    }
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY not set in environment');
    }

    const t0 = Date.now();
    const api = input.candidateApi;

    // Build OpenAI-compatible tool definitions matching CandidateQueueAPI.
    const tools = buildToolDefinitions();

    // System prompt is empty — the compile-prompt (input.prompt) already
    // contains all the instructions Trail needs the model to follow. The
    // initial message goes as `user` so the model responds as assistant.
    const messages: OpenRouterMessage[] = [
      { role: 'user', content: input.prompt },
    ];

    let totalCostUsd = 0;
    let totalTurns = 0;
    const modelTrail: Array<{ turn: number; model: string }> = [];

    for (let turn = 1; turn <= input.maxTurns; turn++) {
      const elapsed = Date.now() - t0;
      if (elapsed > input.timeoutMs) {
        throw new Error(`openrouter timed out after ${Math.round(elapsed / 1000)}s`);
      }

      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://trailmem.com',
          'X-Title': 'trail-ingest',
        },
        body: JSON.stringify({
          model: input.model,
          messages,
          tools,
          temperature: 0.3,
          max_tokens: 4096,
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(Math.max(5_000, input.timeoutMs - elapsed)),
      }).catch((err: unknown) => {
        throw new Error(`openrouter network error on ${input.model}: ${err instanceof Error ? err.message : String(err)}`);
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`openrouter ${response.status} on ${input.model}: ${body.slice(0, 400)}`);
      }

      const data = (await response.json()) as OpenRouterResponse;
      const choice = data.choices[0];
      if (!choice) throw new Error(`openrouter returned no choices for ${input.model}`);

      totalTurns = turn;
      modelTrail.push({ turn, model: input.model });
      if (typeof data.usage?.cost === 'number') {
        totalCostUsd += data.usage.cost;
      }

      // Push assistant message (with any tool-calls) into the convo history.
      messages.push({
        role: 'assistant',
        content: choice.message.content,
        tool_calls: choice.message.tool_calls,
      });

      const toolCalls = choice.message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // Model chose to stop. We're done.
        break;
      }

      // Dispatch each tool call to CandidateQueueAPI; push tool-result
      // messages back into the convo so the model sees them next turn.
      for (const tc of toolCalls) {
        let toolResult: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          toolResult = await dispatchTool(api, tc.function.name, args);
        } catch (err) {
          toolResult = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        }
        // Cap enormous tool outputs so a single read of a huge file
        // doesn't blow out the context budget.
        if (toolResult.length > MAX_TOOL_RESPONSE_BYTES) {
          toolResult = toolResult.slice(0, MAX_TOOL_RESPONSE_BYTES) + '\n\n[truncated at 50K chars]';
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
    }

    return {
      turns: totalTurns,
      durationMs: Date.now() - t0,
      costCents: Math.round(totalCostUsd * 100),
      modelTrail,
    };
  }
}

// ── Tool dispatch ───────────────────────────────────────────────────────

async function dispatchTool(
  api: CandidateQueueAPI,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'guide': {
      const r = await api.guide();
      return formatGuide(r);
    }
    case 'search': {
      const r = await api.search({
        knowledge_base: typeof args.knowledge_base === 'string' ? args.knowledge_base : undefined,
        mode: args.mode === 'search' ? 'search' : 'list',
        query: typeof args.query === 'string' ? args.query : undefined,
        path: typeof args.path === 'string' ? args.path : '*',
        kind: args.kind === 'source' || args.kind === 'wiki' || args.kind === 'any' ? args.kind : 'any',
      });
      return formatSearch(r);
    }
    case 'read': {
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) return 'Error: path is required';
      const r = await api.read({
        knowledge_base: typeof args.knowledge_base === 'string' ? args.knowledge_base : undefined,
        path,
      });
      return formatRead(r);
    }
    case 'write': {
      const command = args.command as 'create' | 'str_replace' | 'append';
      if (command !== 'create' && command !== 'str_replace' && command !== 'append') {
        return `Error: unknown command "${String(command)}"; expected create|str_replace|append`;
      }
      const r = await api.write({
        knowledge_base: typeof args.knowledge_base === 'string' ? args.knowledge_base : undefined,
        command,
        path: typeof args.path === 'string' ? args.path : undefined,
        title: typeof args.title === 'string' ? args.title : undefined,
        content: typeof args.content === 'string' ? args.content : undefined,
        tags: typeof args.tags === 'string' ? args.tags : undefined,
        old_text: typeof args.old_text === 'string' ? args.old_text : undefined,
        new_text: typeof args.new_text === 'string' ? args.new_text : undefined,
      });
      return formatWrite(r);
    }
    default:
      return `Error: unknown tool "${name}" (expected guide|search|read|write)`;
  }
}

// ── Formatters: structured API result → plain text the model reads ──────

function formatGuide(r: Awaited<ReturnType<CandidateQueueAPI['guide']>>): string {
  let out = `# trail — How It Works\n\nThree layers:\n1. **Sources** (immutable raw inputs)\n2. **Wiki** at /neurons/ (compiled markdown + [[wiki-links]])\n3. **Schema** (conventions)\n\n## Tools\n- guide — this message\n- search — list or FTS a KB\n- read — fetch single doc or glob\n- write — create / str_replace / append wiki pages\n\n## Knowledge bases for ${r.tenantName}\n`;
  if (r.kbs.length === 0) {
    out += '\nNo knowledge bases yet.\n';
  } else {
    for (const kb of r.kbs) {
      out += `\n- **${kb.name}** (\`${kb.slug}\`) — ${kb.sourceCount} sources, ${kb.wikiPageCount} wiki pages`;
      if (kb.description) out += `\n  ${kb.description}`;
    }
  }
  return out;
}

function formatSearch(r: Awaited<ReturnType<CandidateQueueAPI['search']>>): string {
  if (!r.ok) {
    if (r.error === 'kb-not-found') return `KB "${r.kbInput ?? '(default)'}" not found.`;
    if (r.error === 'search-mode-requires-query') return 'Search query required for search mode.';
    return 'Unknown error';
  }
  if (r.mode === 'search') {
    let out = `## Search results for "${r.query}" in ${r.kbName}\n\n`;
    if (r.docs.length === 0 && r.chunks.length === 0) return out + 'No results found.\n';
    out += `### Documents (${r.docs.length})\n`;
    for (const d of r.docs) {
      const prefix = d.seqId ? `\`${d.seqId}\` ` : '';
      out += `- ${prefix}[${d.kind}] \`${d.path}${d.filename}\` — ${d.title ?? d.filename}\n`;
    }
    out += `\n### Chunks (${r.chunks.length})\n`;
    for (const c of r.chunks) {
      out += `- chunk #${c.chunkIndex}: ${c.content.slice(0, 200)}...\n`;
    }
    return out;
  }
  // list mode
  let out = `## ${r.kbName} — ${r.docs.length} documents\n\n`;
  for (const d of r.docs) {
    const icon = d.status === 'ready' ? '✓' : d.status === 'processing' ? '⏳' : '•';
    const prefix = d.seqId ? `\`${d.seqId}\` ` : '';
    out += `${icon} ${prefix}[${d.kind}] \`${d.path}${d.filename}\` — ${d.title ?? d.filename} (${d.fileType})\n`;
  }
  return out;
}

function formatRead(r: Awaited<ReturnType<CandidateQueueAPI['read']>>): string {
  if (!r.ok) {
    if (r.error === 'kb-not-found') return `KB "${r.kbInput ?? '(default)'}" not found.`;
    return `Document "${r.pathArg}" not found in ${r.kbName}.`;
  }
  if (r.kind === 'single') {
    const seqPrefix = r.doc.seqId ? `<!-- ${r.doc.seqId} -->\n` : '';
    return seqPrefix + (r.doc.content || '_No content_');
  }
  // glob
  if (r.docs.length === 0) return 'No documents match.';
  let out = '';
  for (const d of r.docs) {
    const header = d.seqId ? `\n\n---\n## ${d.path}${d.filename}  \`${d.seqId}\`\n\n` : `\n\n---\n## ${d.path}${d.filename}\n\n`;
    out += header + (d.content || '_No content_');
  }
  if (r.truncatedAt !== null) {
    out += `\n\n---\n_Truncated: ${r.docs.length - r.truncatedAt} more documents not shown._\n`;
  }
  return out;
}

function formatWrite(r: Awaited<ReturnType<CandidateQueueAPI['write']>>): string {
  if (!r.ok) {
    switch (r.error) {
      case 'kb-not-found': return `KB "${r.kbInput ?? '(default)'}" not found.`;
      case 'title-required': return 'Title required for create.';
      case 'locate-failed': return `Error: ${r.hint}`;
      case 'old-text-not-found': return `old_text not found in ${r.target}.`;
      case 'old-text-ambiguous': return `old_text found ${r.occurrences} times in ${r.target} — must be unique. Add more surrounding context.`;
      case 'doc-not-found': return `Document "${r.target}" not found in ${r.kbName}.`;
      case 'missing-fields': return `Error: ${r.hint}`;
      case 'unknown-command': return `Unknown command: ${r.command}`;
    }
  }
  if (r.command === 'create') {
    return r.approved
      ? `Created \`${r.path}${r.filename}\` — "${r.title}"`
      : `Create queued for curator review.`;
  }
  if (r.command === 'str_replace' || r.command === 'append') {
    const verb = r.command === 'str_replace' ? 'Updated' : 'Appended to';
    return r.approved
      ? `${verb} \`${r.path}${r.filename}\` (v${r.newVersion})`
      : `${r.command === 'append' ? 'Append' : 'Update'} queued for curator review on ${r.path}${r.filename}.`;
  }
  return 'Write completed.';
}

// ── Tool definitions (OpenAI-compatible function-calling schema) ────────

function buildToolDefinitions() {
  return [
    {
      type: 'function' as const,
      function: {
        name: 'guide',
        description: "List the tenant's knowledge bases and explain how trail works. Call this first when you're unsure which KB to write to.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'search',
        description: 'Browse or FTS-search documents in a knowledge base. Use mode="list" for a file-tree (default); mode="search" for keyword FTS.',
        parameters: {
          type: 'object',
          properties: {
            knowledge_base: { type: 'string', description: 'Name, slug, or id of the KB. Omit to use the active KB from context.' },
            mode: { type: 'string', enum: ['list', 'search'], description: 'list = file tree, search = FTS.' },
            query: { type: 'string', description: 'Search query (required for search mode).' },
            path: { type: 'string', description: 'Path filter glob (e.g. "/neurons/*").' },
            kind: { type: 'string', enum: ['source', 'wiki', 'any'], description: 'Filter by document kind.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'read',
        description: 'Read document content from a knowledge base. Accepts a single path or a glob (e.g. "/neurons/*.md"). For large files, a 120K-char cap applies.',
        parameters: {
          type: 'object',
          properties: {
            knowledge_base: { type: 'string', description: 'Name, slug, or id of the KB.' },
            path: { type: 'string', description: 'Full path (e.g. "/neurons/overview.md") or glob (e.g. "/neurons/*.md").' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'write',
        description: 'Create or edit wiki pages via the Curation Queue. Supports create / str_replace / append.',
        parameters: {
          type: 'object',
          properties: {
            knowledge_base: { type: 'string', description: 'Name, slug, or id of the KB.' },
            command: { type: 'string', enum: ['create', 'str_replace', 'append'], description: 'create = new wiki page; str_replace = find/replace; append = add to end.' },
            path: { type: 'string', description: 'Directory path for create (default "/neurons/"). Ignored for str_replace/append — use `title` for the full doc path.' },
            title: { type: 'string', description: 'For create: the new page title. For str_replace/append: the full document path (e.g. "/neurons/overview.md").' },
            content: { type: 'string', description: 'Content for create or append.' },
            tags: { type: 'string', description: 'Comma-separated tags (create only).' },
            old_text: { type: 'string', description: 'Text to find (str_replace only).' },
            new_text: { type: 'string', description: 'Replacement text (str_replace only).' },
          },
          required: ['command'],
        },
      },
    },
  ];
}
