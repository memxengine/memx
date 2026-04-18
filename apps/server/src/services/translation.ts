/**
 * Translation service for LLM-generated candidate strings.
 *
 * Every candidate has three bilingual surfaces:
 *   - title: plain string, localised via cached translations.{locale}.title
 *   - content: markdown body, localised via cached translations.{locale}.content
 *   - actions[]: CandidateAction objects with BilingualText label + explanation
 *
 * This module ensures all three are populated for a requested locale. On
 * first view in a non-EN locale we issue ONE LLM call that translates the
 * whole bundle and caches every piece back onto the row. Subsequent views
 * are instant.
 *
 * English is canonical — never translated, never stored in the
 * translations map. Readers fall back to the plain `title`/`content`
 * columns and each action's `label.en`/`explanation.en` for English.
 *
 * Design choices:
 *   - CLI subprocess only (no Anthropic API) — matches the rest of the
 *     stack + Max-subscription billing.
 *   - Best-effort: failures silently fall back to the EN original. A
 *     missing Danish translation is less bad than a spinner stuck
 *     forever on a curator's screen.
 *   - Process-local cache coalesces concurrent (candidateId, locale)
 *     requests so two parallel panel loads share one Claude spawn.
 *   - When translating content with embedded `> source quotes`, the
 *     prompt instructs the model to preserve blockquote bodies verbatim.
 *     That keeps the user's raw source material unchanged while the LLM
 *     framing around it (summaries, "A claim in X appears to conflict…")
 *     flows into the target language.
 */
import { spawnClaude, extractAssistantText } from './claude.js';
import {
  getCandidate,
  persistActionTranslation,
  persistCandidateTranslation,
  resolveActions,
} from '@trail/core';
import type { TrailDatabase } from '@trail/db';
import type { CandidateAction, Locale, QueueCandidate } from '@trail/shared';

const CHAT_MODEL = process.env.TRAIL_TRANSLATE_MODEL ?? 'claude-haiku-4-5-20251001';
// 60s timed out on the bigger contradictions (title + content + 4 actions).
// 120s covers the heaviest bundles observed in practice; change via
// TRAIL_TRANSLATE_TIMEOUT_MS if a locale's payload is even chunkier.
const TRANSLATE_TIMEOUT_MS = Number(process.env.TRAIL_TRANSLATE_TIMEOUT_MS ?? 120_000);

/**
 * Human-readable locale names for the LLM prompt. "Translate to Danish"
 * produces better output than "translate to da". Adding a locale here +
 * one entry in @trail/shared's Locale union is enough; no code changes.
 */
const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  da: 'Danish',
};

// Process-local in-flight cache. Keyed by candidateId+locale.
const inFlight = new Map<string, Promise<TranslationBundle | null>>();

export interface TranslationBundle {
  title: string;
  content: string;
  actions: CandidateAction[];
}

/**
 * Ensure every translatable field on a candidate has a populated entry
 * for the target locale. Runs the LLM once if anything is missing.
 * Returns the bundle in the requested locale or null if the candidate
 * doesn't exist. Falls back to English when translation fails so the
 * caller always gets SOMETHING to render.
 */
export async function ensureCandidateInLocale(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
  locale: Locale,
): Promise<TranslationBundle | null> {
  const candidate = await getCandidate(trail, tenantId, candidateId);
  if (!candidate) return null;

  // EN is canonical — assemble from the primary columns + actions EN fields.
  if (locale === 'en') {
    return {
      title: candidate.title,
      content: candidate.content,
      actions: resolveActions(candidate),
    };
  }

  const cacheKey = `${candidateId}:${locale}`;
  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const job = run(trail, tenantId, candidate, locale).finally(() => {
    inFlight.delete(cacheKey);
  });
  inFlight.set(cacheKey, job);
  return job;
}

async function run(
  trail: TrailDatabase,
  tenantId: string,
  candidate: QueueCandidate,
  locale: Locale,
): Promise<TranslationBundle | null> {
  const actions = resolveActions(candidate);
  const missing = collectMissing(candidate, actions, locale);

  if (missing.title === null && missing.content === null && missing.actions.length === 0) {
    // Everything already cached — assemble from the candidate's existing fields.
    return assembleBundle(candidate, actions, locale);
  }

  const translated = await callLlm(candidate, actions, locale, missing);
  if (!translated) {
    // Fall back to EN rather than throwing — the curator shouldn't lose
    // the entire candidate just because the translator ran out of tokens.
    return {
      title: candidate.title,
      content: candidate.content,
      actions,
    };
  }

  // Persist whatever we got back. Only forward fields the LLM actually
  // returned; nulls mean "model skipped this field" and shouldn't clobber
  // the cache with a blank.
  await persistCandidateTranslation(trail, tenantId, candidate.id, locale, {
    ...(translated.title !== null ? { title: translated.title } : {}),
    ...(translated.content !== null ? { content: translated.content } : {}),
  });
  for (const ta of translated.actions) {
    await persistActionTranslation(trail, tenantId, candidate.id, ta.actionId, locale, {
      label: ta.label,
      explanation: ta.explanation,
    });
  }

  // Re-fetch with the fresh values so callers see the final merged shape.
  const refreshed = await getCandidate(trail, tenantId, candidate.id);
  if (!refreshed) return null;
  return assembleBundle(refreshed, resolveActions(refreshed), locale);
}

interface MissingSet {
  title: string | null;
  content: string | null;
  actions: CandidateAction[];
}

function collectMissing(
  candidate: QueueCandidate,
  actions: CandidateAction[],
  locale: Locale,
): MissingSet {
  const cache = candidate.translations?.[locale];
  return {
    title: typeof cache?.title === 'string' ? null : candidate.title,
    content: typeof cache?.content === 'string' ? null : candidate.content,
    actions: actions.filter((a) => {
      const lbl = (a.label as Record<string, unknown>)[locale];
      const exp = (a.explanation as Record<string, unknown>)[locale];
      return typeof lbl !== 'string' || typeof exp !== 'string';
    }),
  };
}

function assembleBundle(
  candidate: QueueCandidate,
  actions: CandidateAction[],
  locale: Locale,
): TranslationBundle {
  const cache = candidate.translations?.[locale];
  return {
    title: typeof cache?.title === 'string' ? cache.title : candidate.title,
    content: typeof cache?.content === 'string' ? cache.content : candidate.content,
    actions,
  };
}

interface TranslatedAction {
  actionId: string;
  label: string;
  explanation: string;
}

interface LlmResult {
  title: string | null;
  content: string | null;
  actions: TranslatedAction[];
}

async function callLlm(
  candidate: QueueCandidate,
  actions: CandidateAction[],
  locale: Locale,
  missing: MissingSet,
): Promise<LlmResult | null> {
  const localeName = LOCALE_NAMES[locale] ?? locale;

  // Build an input object that mirrors the expected output shape. Keeps
  // the prompt compact and gives Claude a template to fill in.
  const actionPayload = missing.actions.map((a) => ({
    id: a.id,
    label: a.label.en,
    explanation: a.explanation.en,
  }));

  const input = {
    ...(missing.title !== null ? { title: missing.title } : {}),
    ...(missing.content !== null ? { content: missing.content } : {}),
    ...(actionPayload.length > 0 ? { actions: actionPayload } : {}),
  };

  const prompt = `You translate curator-facing text from English to ${localeName}.
This is text a human curator reads while deciding whether to accept a
change to their knowledge base. Translate naturally — no literal word-for-
word — and keep a friendly, precise tone.

Hard rules:
- Preserve all **bold**, *italic*, [[wiki-links]], \`inline code\`, and
  markdown headings exactly.
- Preserve "quoted names" and filenames (e.g. \`overview.md\`) verbatim.
- Inside blockquotes (lines starting with "> "), leave the quoted body
  untranslated — it's verbatim source material. Translate only the
  framing sentence that precedes the blockquote if any.
- Keep each action \`label\` a short button text (1-4 words).
- Trail-specific glossary (apply when translating to Danish):
  - "lint pass" / "lint run" → "lint-kørsel" (never "lint-køre", never "lint-pass")
  - "Neuron" → "Neuron" (do NOT translate; it is a product term)
  - "Trail" / "Trails" → "Trail" / "Trails" (do NOT translate; product name)
  - "Source" (when referring to a source document) → "Kilde"
  - "frontmatter" → "frontmatter" (keep English; technical term)
  - "curator" → "kurator"
  - "link" / "linking" (as verb) → "link" / "linke" / "linket" (do NOT translate to "forbind")
  - "Auto-link sources" → "Auto-link kilder" (never "Auto-forbind")
  - "Link manually" → "Link manuelt" (never "Forbind manuelt")
  - "false positive" → "falsk alarm" (plain-language, never "falskt positiv")
  - "Approve" → "Godkend"
  - "Dismiss" / "Reject" → "Afvis"
  - "Archive" → "Arkivér"
  - "Retire" (as in retire a Neuron from circulation) → "Arkivér" (NEVER "Pensionér"
    — that sounds like a person retiring from work, misleading)
  - "Retire new" → "Arkivér ny"
  - "Retire existing" → "Arkivér eksisterende"
  - "Reconcile" (as in resolve a contradiction by writing a merged Neuron) →
    "Forlig" (NEVER "Afstem" or "Forene" — those suggest voting or simple concat)
  - "Merge into new" → "Sammenfat i ny"
  - "Flag source" → "Markér kilde"
  - "Mark still relevant" → "Bekræft stadig gældende"

Return ONLY a JSON object with the same keys as the input. For actions,
return them as an array in the same order:

{
${missing.title !== null ? '  "title": "<translated>",\n' : ''}${missing.content !== null ? '  "content": "<translated>",\n' : ''}${actionPayload.length > 0 ? '  "actions": [{"id":"<same id>","label":"<translated>","explanation":"<translated>"}]\n' : ''}}

Input:
${JSON.stringify(input, null, 2)}`;

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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;

    const result: LlmResult = {
      title: typeof obj.title === 'string' ? obj.title : null,
      content: typeof obj.content === 'string' ? obj.content : null,
      actions: [],
    };

    if (Array.isArray(obj.actions)) {
      for (const row of obj.actions) {
        if (!row || typeof row !== 'object') continue;
        const r = row as { id?: unknown; label?: unknown; explanation?: unknown };
        if (typeof r.id !== 'string') continue;
        if (typeof r.label !== 'string') continue;
        if (typeof r.explanation !== 'string') continue;
        result.actions.push({ actionId: r.id, label: r.label, explanation: r.explanation });
      }
    }
    // Avoid unused-variable warning on `candidate`: the LLM doesn't need
    // additional fields today, but future prompts (e.g. citing kind-specific
    // tone guidelines) will key off it. Touch-and-go.
    void candidate;
    return result;
  } catch (err) {
    console.error('[translation] failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Back-compat alias for any caller that still imported the old action-only
// entrypoint. Delete after the admin migrates to ensureCandidateInLocale.
export async function ensureActionsInLocale(
  trail: TrailDatabase,
  tenantId: string,
  candidateId: string,
  locale: Locale,
): Promise<CandidateAction[] | null> {
  const bundle = await ensureCandidateInLocale(trail, tenantId, candidateId, locale);
  return bundle?.actions ?? null;
}
