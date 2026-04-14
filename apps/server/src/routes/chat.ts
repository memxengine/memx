import { Hono } from 'hono';
import { db, knowledgeBases, searchChunks, searchDocuments } from '@memx/db';
import { eq } from 'drizzle-orm';
import { requireAuth, getTenant } from '../middleware/auth.js';
import { spawnClaude, extractAssistantText } from '../services/claude.js';
import { ChatRequestSchema } from '@memx/shared';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const CHAT_MODEL = process.env.CHAT_MODEL ?? 'claude-haiku-4-5-20251001';
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS ?? 30_000);

export const chatRoutes = new Hono();

chatRoutes.use('*', requireAuth);

chatRoutes.post('/chat', async (c) => {
  const tenant = getTenant(c);
  const body = ChatRequestSchema.parse(await c.req.json());

  const kbs = body.knowledgeBaseId
    ? db
        .select({ id: knowledgeBases.id, name: knowledgeBases.name })
        .from(knowledgeBases)
        .where(eq(knowledgeBases.id, body.knowledgeBaseId))
        .all()
        .filter(() => true) // tenant check below
    : db
        .select({ id: knowledgeBases.id, name: knowledgeBases.name })
        .from(knowledgeBases)
        .where(eq(knowledgeBases.tenantId, tenant.id))
        .all();

  if (kbs.length === 0) {
    return c.json({ answer: 'No knowledge bases found for this tenant. Create a wiki first and add sources.' });
  }

  const { context, citations } = retrieveContext(body.message, kbs.map((kb) => kb.id), tenant.id);

  if (!context.trim()) {
    return c.json({
      answer:
        'Jeg fandt ingen relevante wiki-sider for dit spørgsmål. Prøv at omformulere eller tilføj flere kilder.',
      citations: [],
    });
  }

  const systemPrompt = `You are a knowledgeable assistant. Answer the user's question based ONLY on the wiki context provided below. Do not make up information.

## Wiki Context
${context}

## Instructions
- Answer in the same language as the question
- Be concise (max 300 words)
- Use **bold** for key terms
- Reference wiki pages with [[page-name]] links where relevant
- If the context doesn't contain enough information, say so honestly`;

  // Dev default: claude -p subprocess. Prod will flip to direct API once stable.
  if (ANTHROPIC_API_KEY && process.env.MEMX_CHAT_BACKEND === 'api') {
    try {
      const answer = await callAnthropicAPI(systemPrompt, body.message);
      return c.json({ answer, citations });
    } catch (err) {
      console.error('[chat] API error, falling back to CLI:', (err as Error).message);
    }
  }

  const args = [
    '-p',
    `${systemPrompt}\n\n## User Question\n${body.message}`,
    '--dangerously-skip-permissions',
    '--max-turns',
    '1',
    '--output-format',
    'json',
    ...(CHAT_MODEL ? ['--model', CHAT_MODEL] : []),
  ];

  try {
    const raw = await spawnClaude(args, { timeoutMs: CHAT_TIMEOUT_MS });
    const answer = extractAssistantText(raw);
    return c.json({ answer, citations });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[chat] Error:', msg);
    return c.json({ error: msg }, 500);
  }
});

async function callAnthropicAPI(system: string, userMessage: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CHAT_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
  return data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

interface Citation {
  documentId: string;
  path: string;
  filename: string;
}

function retrieveContext(
  query: string,
  kbIds: string[],
  tenantId: string,
): { context: string; citations: Citation[] } {
  const chunks: string[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  const MAX_CHARS = 30_000;
  const PER_KB_CHUNKS = 8;
  const PER_KB_DOCS = 4;

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return { context: '', citations: [] };

  for (const kbId of kbIds) {
    if (totalChars >= MAX_CHARS) break;

    const chunkHits = searchChunks(ftsQuery, kbId, tenantId, PER_KB_CHUNKS);
    for (const hit of chunkHits) {
      if (totalChars >= MAX_CHARS) break;
      const header = hit.headerBreadcrumb ? `[${hit.headerBreadcrumb}] ` : '';
      const text = `### chunk ${header}\n${hit.content.slice(0, 2500)}`;
      chunks.push(text);
      totalChars += text.length;
      if (!seen.has(hit.documentId)) {
        seen.add(hit.documentId);
      }
    }

    const docHits = searchDocuments(ftsQuery, kbId, tenantId, PER_KB_DOCS);
    for (const hit of docHits) {
      if (hit.kind !== 'wiki') continue;
      if (totalChars >= MAX_CHARS) break;
      if (!seen.has(hit.id)) {
        seen.add(hit.id);
        citations.push({ documentId: hit.id, path: hit.path, filename: hit.filename });
      }
    }
  }

  return { context: chunks.join('\n\n---\n\n'), citations };
}

function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return terms.join(' OR ');
}
