/**
 * F96 — LLM-backed action recommender.
 *
 * For every pending candidate, runs a single Haiku call that:
 *   1. Reads the candidate title + content + metadata + its actions.
 *   2. Picks the action id the LLM believes fits best.
 *   3. Writes a 1-3 sentence reasoning for why.
 *   4. Stamps it back into `candidate.metadata.recommendation`.
 *
 * Goal: cut the curator's cognitive load when reviewing long queues of
 * similar-looking findings (40+ orphans, 20+ contradictions). Each card
 * gets a "💡 Anbefalet" badge on one action + a one-liner reasoning so
 * the curator can scan + click + move on instead of reading every
 * alternative.
 *
 * Subscribes to `candidate_created` events — fires async so
 * createCandidate returns fast. Result arrives seconds later via the
 * same SSE bus the admin already listens on. Existing candidates
 * without a recommendation still render fine (the UI degrades
 * gracefully).
 *
 * Cost per call: ~2-3K input tokens + ~100 output tokens = ~$0.003 on
 * Haiku 4.5. 1000 candidates ≈ $3. Cached forever on the candidate
 * row — never re-runs unless the content changes materially.
 *
 * Skip rules:
 *   - candidate.status !== 'pending' (already resolved, no point)
 *   - candidate.actions.length < 2 (no choice to recommend between)
 *   - candidate already has metadata.recommendation (idempotent)
 */
import { queueCandidates, knowledgeBases, type TrailDatabase } from '@trail/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { CandidateAction, CandidateRecommendation } from '@trail/shared';
import { spawnClaude, extractAssistantText } from './claude.js';
import { broadcaster } from './broadcast.js';

const MODEL = process.env.TRAIL_RECOMMENDER_MODEL ?? 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = Number(process.env.TRAIL_RECOMMENDER_TIMEOUT_MS ?? 45_000);

/**
 * One-shot backfill: walk every pending candidate missing a
 * recommendation and generate one. Runs sequentially so we don't
 * stampede the Claude CLI subprocess. Logs a running counter so you
 * can tail the engine log and see progress. Scheduled with a delay
 * from boot so it doesn't compete with normal traffic during startup.
 */
export async function backfillRecommendations(trail: TrailDatabase): Promise<void> {
  const rows = await trail.db
    .select({
      id: queueCandidates.id,
      tenantId: queueCandidates.tenantId,
      metadata: queueCandidates.metadata,
      actions: queueCandidates.actions,
    })
    .from(queueCandidates)
    .where(
      and(
        eq(queueCandidates.status, 'pending'),
        isNotNull(queueCandidates.actions),
      ),
    )
    .all();

  const eligible = rows.filter((r) => {
    const md = parseMetadata(r.metadata);
    return !md.recommendation;
  });

  if (eligible.length === 0) return;
  console.log(
    `  action-recommender: backfill starting — ${eligible.length} pending candidate${eligible.length === 1 ? '' : 's'} without a recommendation`,
  );

  let done = 0;
  let failed = 0;
  for (const r of eligible) {
    try {
      await recommend(trail, r.tenantId, r.id);
      done += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[action-recommender] backfill ${r.id.slice(0, 12)} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    if (done > 0 && done % 10 === 0) {
      console.log(`  action-recommender: backfill ${done}/${eligible.length}…`);
    }
  }
  console.log(
    `  action-recommender: backfill complete — ${done} done${failed > 0 ? `, ${failed} failed` : ''}`,
  );
}

export function startActionRecommender(trail: TrailDatabase): () => void {
  const unsubscribe = broadcaster.subscribe((event) => {
    if (event.type !== 'candidate_created') return;
    // Auto-approved candidates skip the queue entirely — no curator will
    // ever see them, so no recommendation is needed.
    if (event.status !== 'pending') return;
    if (!event.candidateId) return;

    recommend(trail, event.tenantId, event.candidateId).catch((err) => {
      console.error('[action-recommender] failed:', err instanceof Error ? err.message : err);
    });
  });
  console.log('  action-recommender: listening');
  return unsubscribe;
}

async function recommend(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
): Promise<void> {
  const row = await trail.db
    .select()
    .from(queueCandidates)
    .where(eq(queueCandidates.id, candidateId))
    .get();
  if (!row || row.tenantId !== tenantId) return;
  if (row.status !== 'pending') return;

  const existing = parseMetadata(row.metadata);
  if (existing.recommendation) return; // idempotent

  const actions = parseActions(row.actions);
  if (!actions || actions.length < 2) return;

  // Each Trail carries its own `language` setting (default 'da'). The
  // recommender generates its reasoning in that language so curators
  // see it natively — no per-view translation round-trip, just one
  // Haiku call tuned to the Trail the curator works in.
  const kb = await trail.db
    .select({ language: knowledgeBases.language })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, row.knowledgeBaseId))
    .get();
  const language = kb?.language ?? 'da';

  const prompt = buildPrompt(row, actions, language);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return;
  }
  const rec = coerceRecommendation(parsed, actions);
  if (!rec) return;

  const nextMetadata = { ...existing, recommendation: rec };
  await trail.db
    .update(queueCandidates)
    .set({ metadata: JSON.stringify(nextMetadata) })
    .where(eq(queueCandidates.id, candidateId))
    .run();

  // Re-emit as candidate_created so the admin's panel re-fetches and
  // renders the recommendation without needing a separate channel.
  broadcaster.emit({
    type: 'candidate_created',
    tenantId: row.tenantId,
    kbId: row.knowledgeBaseId,
    candidateId: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    autoApproved: false,
    confidence: row.confidence,
    createdBy: row.createdBy,
  });
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  da: 'Danish',
};

function buildPrompt(
  row: { title: string; content: string; kind: string; metadata: string | null },
  actions: CandidateAction[],
  language: string,
): string {
  const actionList = actions
    .map(
      (a) =>
        `  - ${JSON.stringify(a.id)}: ${JSON.stringify(a.label.en)}\n    effect=${JSON.stringify(a.effect)}\n    when: ${JSON.stringify(a.explanation.en)}`,
    )
    .join('\n');

  const languageName = LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES.en;

  return `You are advising a knowledge-base curator about which action to take on a pending candidate in their queue.

Given the candidate below and its available actions, pick the ONE action id that best fits based on the content. Provide a 1-3 sentence reasoning explaining WHY this action is the right call. Include a confidence score 0-1 reflecting how sure you are.

Hard rules:
- The \`recommendedActionId\` MUST match one of the action ids verbatim. Never invent a new id.
- The \`reasoning\` MUST be written in ${languageName}. Natural prose, no jargon, addressed to the curator, max 300 characters.
- Product terms stay as English loan-words in ${languageName}: "Neuron", "Trail", "Source", "frontmatter", "lint" — don't translate these.
- The \`confidence\` must be a number between 0 and 1.
- Return ONLY a JSON object. No prose around it. No markdown fence.

Candidate kind: ${JSON.stringify(row.kind)}
Candidate title: ${JSON.stringify(row.title)}
Candidate content (truncated to 2000 chars):
${JSON.stringify(row.content.slice(0, 2000))}

Available actions:
${actionList}

Return format:
{
  "recommendedActionId": "<one of the ids above>",
  "confidence": <0-1>,
  "reasoning": "<plain-language justification in ${languageName}>"
}`;
}

function coerceRecommendation(
  raw: unknown,
  actions: CandidateAction[],
): CandidateRecommendation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const actionId = obj.recommendedActionId;
  if (typeof actionId !== 'string') return null;
  if (!actions.some((a) => a.id === actionId)) return null; // hallucination guard
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : null;
  if (confidence === null || confidence < 0 || confidence > 1) return null;
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.slice(0, 1000) : null;
  if (!reasoning) return null;
  return {
    recommendedActionId: actionId,
    confidence,
    reasoning,
    generatedAt: new Date().toISOString(),
  };
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function parseActions(raw: string | null): CandidateAction[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as CandidateAction[];
  } catch {
    // fall through
  }
  return null;
}
