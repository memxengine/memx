/**
 * Translation service for LLM-generated candidate strings.
 *
 * Candidate actions carry their label + explanation as BilingualText
 * {en, da?}. Producers (contradiction-lint, orphan/stale) generate the EN
 * text because English is the LLM's native tongue and output quality is
 * highest there. Danish (and future locales) are filled lazily on first
 * view in that language, then cached back into the candidate row so the
 * next view renders instantly.
 *
 * A single LLM call covers all pending translations for a candidate in
 * one prompt — cheaper than N calls, and keeps the tone consistent across
 * the action set. The result is persisted via core's
 * persistActionTranslation helper.
 *
 * Design choices:
 *   - CLI subprocess only (no Anthropic API) — matches the rest of the
 *     stack + Max-subscription billing.
 *   - Best-effort: failures silently fall back to the EN original. A
 *     missing Danish translation is less bad than a spinner stuck
 *     forever on a curator's screen.
 *   - Process-local cache avoids repeated LLM calls for the same
 *     (candidateId, locale) during transient races where two panels
 *     both request the translation at once.
 */
import { spawnClaude, extractAssistantText } from './claude.js';
import { getCandidate, persistActionTranslation, resolveActions } from '@trail/core';
import type { TrailDatabase } from '@trail/db';
import type { CandidateAction, Locale } from '@trail/shared';

const CHAT_MODEL = process.env.TRAIL_TRANSLATE_MODEL ?? 'claude-haiku-4-5-20251001';
const TRANSLATE_TIMEOUT_MS = Number(process.env.TRAIL_TRANSLATE_TIMEOUT_MS ?? 45_000);

/**
 * Human-readable names for locales we support. Used to instruct the LLM
 * what to produce — "translate to Danish" is clearer than "translate to
 * da". Adding a locale = one entry here, no code changes elsewhere.
 */
const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  da: 'Danish',
};

// Process-local in-flight cache. Keyed by candidateId+locale. Two
// concurrent requests for the same translation share one Claude spawn.
const inFlight = new Map<string, Promise<CandidateAction[] | null>>();

/**
 * Ensure every action's `label` and `explanation` have a non-empty entry
 * for the target locale. Runs the LLM if anything is missing; returns the
 * (possibly updated) actions list. Returns null if the candidate has no
 * actions or the translation failed — caller falls back to English.
 */
export async function ensureActionsInLocale(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
  locale: Locale,
): Promise<CandidateAction[] | null> {
  if (locale === 'en') {
    // EN is canonical — never needs translation.
    const candidate = await getCandidate(trail, tenantId, candidateId);
    return candidate ? resolveActions(candidate) : null;
  }

  const cacheKey = `${candidateId}:${locale}`;
  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const job = run(trail, tenantId, candidateId, locale).finally(() => {
    inFlight.delete(cacheKey);
  });
  inFlight.set(cacheKey, job);
  return job;
}

async function run(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
  locale: Locale,
): Promise<CandidateAction[] | null> {
  const candidate = await getCandidate(trail, tenantId, candidateId);
  if (!candidate?.actions) return null;

  const actions = candidate.actions;
  const missing = actions.filter((a) => needsTranslation(a, locale));
  if (missing.length === 0) return actions;

  const translated = await translateActions(missing, locale);
  if (!translated) return actions; // LLM failed, return what we have

  // Persist each translation back; the helper merges into the JSON column.
  for (const { actionId, label, explanation } of translated) {
    await persistActionTranslation(trail, tenantId, candidateId, actionId, locale, {
      label,
      explanation,
    });
  }

  // Re-fetch with the new values so callers see the final merged shape.
  const refreshed = await getCandidate(trail, tenantId, candidateId);
  return refreshed ? resolveActions(refreshed) : null;
}

function needsTranslation(a: CandidateAction, locale: Locale): boolean {
  const label = (a.label as Record<string, unknown>)[locale];
  const explanation = (a.explanation as Record<string, unknown>)[locale];
  return typeof label !== 'string' || typeof explanation !== 'string';
}

interface TranslatedAction {
  actionId: string;
  label: string;
  explanation: string;
}

async function translateActions(
  actions: CandidateAction[],
  locale: Locale,
): Promise<TranslatedAction[] | null> {
  const localeName = LOCALE_NAMES[locale] ?? locale;

  // One prompt, all actions. Tells Claude exactly which ids to include
  // and what shape to return — the JSON parser downstream is strict.
  const payload = actions.map((a) => ({
    id: a.id,
    label: a.label.en,
    explanation: a.explanation.en,
  }));

  const prompt = `You translate curator-facing queue action text from English to ${localeName}.
The strings describe what happens when a knowledge-base curator clicks a
resolution button. Translate naturally — no literal word-for-word — and
keep the tone friendly but precise. Preserve **bold**, [[wiki-links]] and
"quoted names" verbatim. Keep the translated label a short button text
(1-4 words).

Return ONLY a JSON array of objects, one per input, in this exact shape
and order:

[{"id":"<same id>","label":"<translated>","explanation":"<translated>"}]

Input:
${JSON.stringify(payload, null, 2)}`;

  const args = [
    '-p',
    prompt,
    '--dangerously-skip-permissions',
    '--max-turns',
    '1',
    '--output-format',
    'json',
    '--model',
    CHAT_MODEL,
  ];

  try {
    const raw = await spawnClaude(args, { timeoutMs: TRANSLATE_TIMEOUT_MS });
    const text = extractAssistantText(raw).trim();
    const json = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: TranslatedAction[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const r = row as { id?: unknown; label?: unknown; explanation?: unknown };
      if (typeof r.id !== 'string') continue;
      if (typeof r.label !== 'string') continue;
      if (typeof r.explanation !== 'string') continue;
      out.push({ actionId: r.id, label: r.label, explanation: r.explanation });
    }
    return out.length > 0 ? out : null;
  } catch (err) {
    console.error('[translation] failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
