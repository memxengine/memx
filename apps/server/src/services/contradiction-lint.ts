/**
 * F19 axis 3 — contradiction detection as a background subscriber.
 *
 * Subscribes to the engine's broadcaster. When a candidate_approved event
 * fires for a wiki-kind resulting document, fetch the new Neuron, find its
 * top-K semantically similar existing Neurons via FTS5, run a Haiku
 * pair-compare, and emit `contradiction-alert` candidates for the curator.
 *
 * Deliberately POST-approval (reactive), not pre-approval (blocking):
 *
 *  - Pre-approval would add 1-3s LLM latency to every auto-approved POST.
 *    Human curators wouldn't notice; bulk buddy F39 ingest would.
 *  - Post-approval matches F19's published semantic ("no contradictions")
 *    because contradiction-alert candidates sit in the queue until a human
 *    decides which side is right. The Neuron is live, but so is the
 *    dispute, which is the correct state.
 *
 * The checker is idempotent via lintFingerprint (see runLint). Re-emitting
 * the same pair skips if a pending/approved alert already exists.
 */
import { documents, queueCandidates, type TrailDatabase } from '@trail/db';
import { and, eq, like, ne } from 'drizzle-orm';
import {
  createCandidate,
  detectContradictions,
  type ContradictionCandidate,
  type ContradictionChecker,
  type LlmContradictionResult,
  type NewNeuron,
} from '@trail/core';
import type { CandidateApprovedEvent } from '@trail/shared';
import { broadcaster } from './broadcast.js';
import { spawnClaude, extractAssistantText } from './claude.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const BACKEND = process.env.TRAIL_CONTRADICTION_BACKEND ?? (ANTHROPIC_API_KEY ? 'api' : 'cli');
const MODEL = process.env.TRAIL_CONTRADICTION_MODEL ?? 'claude-haiku-4-5-20251001';
const TOP_K = Number(process.env.TRAIL_CONTRADICTION_TOPK ?? 5);
const MIN_CONTENT_CHARS = 200; // skip short stubs — too little signal
const CLI_TIMEOUT_MS = Number(process.env.TRAIL_CONTRADICTION_CLI_TIMEOUT_MS ?? 45_000);

const PROMPT = `You are checking whether two passages from a knowledge wiki contradict each other.

Return ONLY a single line of valid JSON matching this TypeScript shape:
  { "contradicts": boolean, "newQuote"?: string, "existingQuote"?: string, "summary"?: string }

Rules:
- A contradiction means the two passages make claims that cannot both be true given standard reading. Differences in focus, phrasing, or coverage are NOT contradictions.
- If contradicts is true, include short direct quotes from each passage (max 200 chars each) showing the conflict.
- If contradicts is false, return {"contradicts": false}. No other fields needed.
- Do not explain your reasoning. Just the JSON.`;

/**
 * Resolve the checker backend once. Exposed so the scheduler (F32.2 full
 * pass) can reuse the same configuration as the reactive subscriber.
 */
export function makeContradictionChecker(): ContradictionChecker {
  return BACKEND === 'api' ? makeAnthropicChecker() : makeCliChecker();
}

export function startContradictionLint(trail: TrailDatabase): () => void {
  const checker = makeContradictionChecker();

  // Rate-limit: only one event being processed at any time. If a second
  // candidate_approved fires while we're busy, queue it; if more than N
  // queue up, drop the oldest (a background lint is nice-to-have, not a
  // critical path).
  //
  // At Sanne-scale, approving 22 orphan Neurons in one batch would trigger
  // 22 events × 5 similars × 1-3s each. Sequentially that's safe; parallel
  // via claude -p would spawn 110 subprocesses at once — not safe.
  const runner = new SerialRunner(trail, checker);

  const unsubscribe = broadcaster.subscribe((event) => {
    if (event.type !== 'candidate_approved') return;
    runner.enqueue(event);
  });

  console.log(`  contradiction-lint: listening (backend=${BACKEND}, model=${MODEL}, top_k=${TOP_K})`);
  return unsubscribe;
}

/**
 * Scan a single Neuron for contradictions against its top-K similar peers.
 * Re-used by the scheduled full pass (F32.2). Idempotent via lintFingerprint;
 * re-scanning the same Neuron produces no duplicate candidates.
 */
export async function scanDocForContradictions(
  trail: TrailDatabase,
  documentId: string,
  checker: ContradictionChecker,
): Promise<void> {
  // Fabricate a CandidateApprovedEvent shape so we can reuse runForEvent as
  // the single code path — every field the runner actually reads (documentId)
  // is populated; the rest are scaffolding for the event union.
  await runForEvent(
    trail,
    {
      type: 'candidate_approved',
      tenantId: '',
      kbId: '',
      candidateId: '',
      documentId,
      autoApproved: false,
    },
    checker,
  );
}

class SerialRunner {
  private queue: CandidateApprovedEvent[] = [];
  private running = false;
  private readonly maxQueue = 64;

  constructor(
    private readonly trail: TrailDatabase,
    private readonly check: ContradictionChecker,
  ) {}

  enqueue(event: CandidateApprovedEvent): void {
    if (this.queue.length >= this.maxQueue) {
      // Drop oldest — the newest events are the most likely to still matter.
      this.queue.shift();
    }
    this.queue.push(event);
    this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        try {
          await runForEvent(this.trail, event, this.check);
        } catch (err) {
          console.error('[contradiction-lint] unhandled error:', err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

async function runForEvent(
  trail: TrailDatabase,
  event: CandidateApprovedEvent,
  check: ContradictionChecker,
): Promise<void> {
  const doc = await trail.db
    .select({
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
      content: documents.content,
      kind: documents.kind,
      tenantId: documents.tenantId,
      knowledgeBaseId: documents.knowledgeBaseId,
      userId: documents.userId,
    })
    .from(documents)
    .where(eq(documents.id, event.documentId))
    .get();

  if (!doc || doc.kind !== 'wiki' || !doc.content) return;
  if (doc.content.length < MIN_CONTENT_CHARS) return;

  const similars = await findSimilarNeurons(trail, doc);
  if (similars.length === 0) return;

  const neuron: NewNeuron = {
    documentId: doc.id,
    filename: doc.filename,
    title: doc.title,
    content: doc.content,
  };

  const findings = await detectContradictions(neuron, similars, check);
  if (findings.length === 0) return;

  // Emit each finding as a contradiction-alert candidate. Actor kind='system'
  // keeps createdBy null so F19 policy evaluates it like any other pipeline
  // write. `contradiction-alert` is NOT in TRUSTED_KINDS — even at confidence
  // 0.75 it lands pending, which is exactly what we want: a human adjudicates
  // contradictions, not a policy.
  for (const f of findings) {
    const existingFp = await hasExistingFingerprint(trail, doc.knowledgeBaseId, doc.tenantId, f.fingerprint);
    if (existingFp) continue;

    try {
      const { candidate, approval } = await createCandidate(
        trail,
        doc.tenantId,
        {
          knowledgeBaseId: doc.knowledgeBaseId,
          kind: f.kind,
          title: f.title,
          content: f.content,
          metadata: JSON.stringify({ op: 'create', source: 'contradiction-lint', lintFingerprint: f.fingerprint, ...f.details }),
          confidence: f.confidence,
        },
        { id: 'system:contradiction-lint', kind: 'system' },
      );
      // Broadcast so admin badges + panels react the same way they do to a
      // human POST /queue/candidates. Bypassing the broadcaster means
      // silent writes — the badge stays stuck at its old value until the
      // next reconnect or focus refresh.
      broadcaster.emit({
        type: 'candidate_created',
        tenantId: candidate.tenantId,
        kbId: candidate.knowledgeBaseId,
        candidateId: candidate.id,
        kind: candidate.kind,
        title: candidate.title,
        status: approval ? 'approved' : 'pending',
        autoApproved: !!approval,
        confidence: candidate.confidence,
        createdBy: candidate.createdBy,
      });
      if (approval) {
        broadcaster.emit({
          type: 'candidate_approved',
          tenantId: candidate.tenantId,
          kbId: candidate.knowledgeBaseId,
          candidateId: candidate.id,
          documentId: approval.documentId,
          autoApproved: true,
        });
      }
    } catch (err) {
      console.error('[contradiction-lint] failed to emit candidate:', err);
    }
  }

  console.log(`[contradiction-lint] "${doc.filename}": ${findings.length} contradiction${findings.length === 1 ? '' : 's'} emitted`);
}

async function findSimilarNeurons(
  trail: TrailDatabase,
  doc: { id: string; title: string | null; content: string | null; knowledgeBaseId: string; tenantId: string },
): Promise<ContradictionCandidate[]> {
  // Pre-filter via FTS5 — take the longest non-trivial terms from the new
  // Neuron's title + leading content as the query. Avoids O(n²) pair-compare
  // across the whole KB. Top-K closest Neurons are passed to the LLM.
  const query = buildSearchQuery(doc.title, doc.content ?? '');
  if (!query) return [];

  const hits = await trail.searchDocuments(query, doc.knowledgeBaseId, doc.tenantId, TOP_K + 1);
  const wikiHits = hits.filter((h) => h.kind === 'wiki' && h.id !== doc.id).slice(0, TOP_K);
  if (wikiHits.length === 0) return [];

  // Fetch full content for each hit — searchDocuments returns highlight
  // snippets only, and the LLM needs the body to reason about the claim.
  const results: ContradictionCandidate[] = [];
  for (const hit of wikiHits) {
    const row = await trail.db
      .select({
        id: documents.id,
        filename: documents.filename,
        title: documents.title,
        content: documents.content,
      })
      .from(documents)
      .where(and(eq(documents.id, hit.id), ne(documents.kind, 'source')))
      .get();
    if (!row || !row.content || row.content.length < MIN_CONTENT_CHARS) continue;
    results.push({
      documentId: row.id,
      filename: row.filename,
      title: row.title,
      content: row.content,
    });
  }
  return results;
}

function buildSearchQuery(title: string | null, content: string): string {
  // Pick meaningful tokens: 5+ char words from title + first 500 chars of
  // content, lowercased, deduped. OR them together as FTS5 prefix terms.
  const seed = `${title ?? ''} ${content.slice(0, 500)}`;
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

async function hasExistingFingerprint(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  fingerprint: string,
): Promise<boolean> {
  const row = await trail.db
    .select({ id: queueCandidates.id })
    .from(queueCandidates)
    .where(
      and(
        eq(queueCandidates.knowledgeBaseId, kbId),
        eq(queueCandidates.tenantId, tenantId),
        like(queueCandidates.metadata, `%"lintFingerprint":"${fingerprint}"%`),
      ),
    )
    .get();
  return !!row;
}

function makeCliChecker(): ContradictionChecker {
  return async (newContent, existingContent): Promise<LlmContradictionResult> => {
    const prompt = [
      PROMPT,
      '',
      '## New passage',
      newContent.slice(0, 4000),
      '',
      '## Existing passage',
      existingContent.slice(0, 4000),
    ].join('\n');

    const args = [
      '-p',
      prompt,
      '--dangerously-skip-permissions',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      '--model',
      MODEL,
    ];

    try {
      const raw = await spawnClaude(args, { timeoutMs: CLI_TIMEOUT_MS });
      const text = extractAssistantText(raw).trim();
      const json = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const parsed = JSON.parse(json) as LlmContradictionResult;
      if (typeof parsed.contradicts !== 'boolean') {
        return { contradicts: false };
      }
      return parsed;
    } catch {
      return { contradicts: false };
    }
  };
}

function makeAnthropicChecker(): ContradictionChecker {
  return async (newContent, existingContent): Promise<LlmContradictionResult> => {
    const body = {
      model: MODEL,
      max_tokens: 300,
      system: PROMPT,
      messages: [
        {
          role: 'user' as const,
          content: [
            '## New passage',
            newContent.slice(0, 4000),
            '',
            '## Existing passage',
            existingContent.slice(0, 4000),
          ].join('\n'),
        },
      ],
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
    const text = data.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim();

    // Model sometimes wraps its answer in code fences; strip them before parse.
    const json = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    try {
      const parsed = JSON.parse(json) as LlmContradictionResult;
      if (typeof parsed.contradicts !== 'boolean') {
        throw new Error('missing contradicts:boolean');
      }
      return parsed;
    } catch {
      // Malformed → treat as "no signal" so the next pair gets evaluated.
      return { contradicts: false };
    }
  };
}
