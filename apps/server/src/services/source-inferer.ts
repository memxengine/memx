/**
 * F90 orphan recovery — LLM-backed Source inferer.
 *
 * When the curator clicks "Auto-link sources" on an orphan-Neuron
 * finding, the route layer runs this inferer BEFORE calling core's
 * `auto-link-sources` effect. Given the orphan Neuron's content and the
 * list of Source documents present in the same KB, the LLM proposes the
 * 1–3 Sources the Neuron most likely draws its claims from.
 *
 * Returns an empty array when:
 *   - no Sources exist in the KB yet
 *   - the Neuron content is empty
 *   - the LLM can't find any plausible match (it returned [])
 *   - the LLM call timed out or failed to parse
 *
 * Callers surface that as a 422 so the curator sees "couldn't auto-link,
 * please link manually" and the candidate stays pending.
 *
 * Design choices:
 *   - CLI subprocess only (no Anthropic API). Matches translation.ts +
 *     contradiction-lint.ts + Max-subscription billing model.
 *   - **FTS5 pre-filter**. Before the LLM call, we hit SQLite FTS5 with
 *     the Neuron's most distinctive terms and keep the top-K Sources by
 *     BM25 rank. Without this the prompt grew linearly in KB size —
 *     1000 Sources × 400-char preview = ~120K tokens, slow and quota-
 *     burning even on Haiku. With the pre-filter the prompt stays ≤ 20
 *     Sources regardless of KB size (~2–5K tokens per call), so latency
 *     and cost are constant in N.
 *   - Best-effort: precision > recall. Better to return [] and let the
 *     curator link manually than to pollute document_references with a
 *     wrong source.
 *   - Source context is the Source's title + first 400 chars of content.
 *   - All user-controlled strings (filename, title) are wrapped with
 *     JSON.stringify in the prompt so quote/backtick/newline payloads
 *     can't break out of their literal and redirect the model.
 */
import { documents, type TrailDatabase } from '@trail/db';
import { and, eq, inArray } from 'drizzle-orm';
import { spawnClaude, extractAssistantText } from './claude.js';

const MODEL = process.env.TRAIL_AUTOLINK_MODEL ?? 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = Number(process.env.TRAIL_AUTOLINK_TIMEOUT_MS ?? 60_000);
const PREVIEW_CHARS = 400;
// Cap on the number of Sources passed to the LLM. At 20 we're ~2–5K
// tokens; the LLM still has plenty of signal to pick 1–3 winners. More
// wouldn't improve precision and costs tokens linearly.
const TOP_K_SOURCES = 20;

interface SourceRow {
  filename: string;
  title: string | null;
  preview: string;
}

/**
 * Propose 1–3 Source filenames for an orphan Neuron. Returns [] when no
 * plausible match exists (either in the KB or per the LLM's judgement).
 */
export async function proposeSourcesForOrphan(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
  neuronContent: string,
): Promise<string[]> {
  if (!neuronContent.trim()) return [];

  const candidates = await selectCandidateSources(trail, tenantId, kbId, neuronContent);
  if (candidates.length === 0) return [];

  const prompt = buildPrompt(neuronContent, candidates);
  const valid = new Set(candidates.map((s) => s.filename));

  try {
    const raw = await spawnClaude(
      [
        '-p',
        prompt,
        '--dangerously-skip-permissions',
        '--max-turns',
        '1',
        '--output-format',
        'json',
        '--model',
        MODEL,
      ],
      { timeoutMs: TIMEOUT_MS },
    );
    const text = extractAssistantText(raw).trim();
    const json = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(json) as unknown;

    if (!Array.isArray(parsed)) return [];
    const proposed: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed) continue;
      if (!valid.has(trimmed)) continue;
      if (proposed.includes(trimmed)) continue;
      proposed.push(trimmed);
      if (proposed.length >= 3) break;
    }
    return proposed;
  } catch (err) {
    console.error('[source-inferer] failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * FTS5-backed pre-filter: pick the TOP_K_SOURCES most topically-relevant
 * sources for this Neuron by BM25 rank. Falls back to "all sources in
 * the KB" when the Neuron has no extractable FTS tokens (very short,
 * symbol-heavy, or otherwise unindexable) — keeps the inferer functional
 * even when pre-filtering can't narrow the candidate set.
 */
async function selectCandidateSources(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
  neuronContent: string,
): Promise<SourceRow[]> {
  const ftsQuery = buildFtsQuery(neuronContent);
  if (ftsQuery) {
    // searchDocuments returns mixed wiki+source hits — filter to sources
    // here. Request extra hits so source filtering leaves us with close
    // to TOP_K after the filter.
    const hits = await trail.searchDocuments(ftsQuery, kbId, tenantId, TOP_K_SOURCES * 3);
    const sourceIds = hits
      .filter((h) => h.kind === 'source')
      .map((h) => h.id)
      .slice(0, TOP_K_SOURCES);
    if (sourceIds.length > 0) {
      return hydrateSources(trail, tenantId, kbId, sourceIds);
    }
  }

  // Fallback: tiny KBs and Neurons with no searchable tokens. Fetch up
  // to TOP_K_SOURCES sources unfiltered, sorted by creation order (no
  // ranking signal so we pick a stable subset).
  const rows = await trail.db
    .select({
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
      content: documents.content,
    })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.knowledgeBaseId, kbId),
        eq(documents.kind, 'source'),
        eq(documents.archived, false),
        eq(documents.status, 'ready'),
      ),
    )
    .limit(TOP_K_SOURCES)
    .all();

  return rows.map(toSourceRow);
}

async function hydrateSources(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
  ids: string[],
): Promise<SourceRow[]> {
  const rows = await trail.db
    .select({
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
      content: documents.content,
    })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.knowledgeBaseId, kbId),
        eq(documents.kind, 'source'),
        eq(documents.archived, false),
        inArray(documents.id, ids),
      ),
    )
    .all();

  // Preserve BM25 rank order — the `ids` array is already ranked. Build
  // a lookup then reassemble in the original order.
  const byId = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byId.set(r.id, r);
  const ordered: SourceRow[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) ordered.push(toSourceRow(r));
  }
  return ordered;
}

function toSourceRow(r: { filename: string; title: string | null; content: string | null }): SourceRow {
  return {
    filename: r.filename,
    title: r.title,
    preview: (r.content ?? '').slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Build an FTS5 MATCH expression from the Neuron's title + leading
 * content. Picks 5+ character tokens, lowercased, deduped, as OR'd
 * prefix terms. Mirrors contradiction-lint.buildSearchQuery so BM25
 * behaviour is consistent across both detectors.
 */
function buildFtsQuery(content: string): string {
  const seed = content.slice(0, 800);
  const terms = Array.from(
    new Set(
      seed
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 5),
    ),
  ).slice(0, 8);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

function buildPrompt(neuronContent: string, sources: SourceRow[]): string {
  const sourceList = sources
    .map((s) => {
      const safeName = JSON.stringify(s.filename);
      const safeTitle = JSON.stringify(s.title ?? s.filename.replace(/\.\w+$/, ''));
      const safePreview = JSON.stringify(s.preview || '(no preview available)');
      return `- name=${safeName} title=${safeTitle} preview=${safePreview}`;
    })
    .join('\n');

  // Neuron content is wrapped in a pseudo-JSON-string too so any
  // quote/backtick payload inside a curator-approved Neuron body can't
  // break prompt structure. 3000-char cap bounds prompt size against
  // pathological inputs.
  const safeContent = JSON.stringify(neuronContent.slice(0, 3000));

  return `You are linking provenance for a Neuron (compiled wiki page) in a knowledge base. The Neuron has no recorded Source citations. Below is the Neuron content (as a JSON string), followed by candidate Source documents that the search engine pre-selected as topically closest (also as JSON strings).

Your task: identify the 1–3 Sources the Neuron's claims most likely came from. Precision matters more than recall — if no Source is clearly topical to the Neuron, return [].

Hard rules:
- Only pick Sources whose topic is clearly relevant to the Neuron's content.
- Never invent a filename. Only return filenames that appear VERBATIM in the \`name\` fields below.
- Return ONLY a JSON array of filename strings. No prose, no explanation, no markdown fence.
- Empty is a valid answer: \`[]\`.

=== Neuron content ===
${safeContent}

=== Candidate Sources ===
${sourceList}

Return the JSON array now.`;
}
