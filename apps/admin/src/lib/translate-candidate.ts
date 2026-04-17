/**
 * `useCandidateBundle` — returns title + content + actions in the active
 * locale. For EN locale the bundle is assembled synchronously from the
 * candidate's primary columns. For any non-EN locale the hook fetches
 * GET /queue/:id/translate?locale=<loc> in the background; the initial
 * render shows EN so the curator always sees something, and the DA/etc.
 * text swaps in when it lands (first view) or immediately (cached).
 *
 * Fallback rule: when the server translation fails or times out, the
 * bundle keeps pointing at EN fields so the UI still renders — there's
 * no error toast, no spinner. A half-translated card is better than no
 * card.
 */
import { useEffect, useState } from 'preact/hooks';
import type { CandidateAction, QueueCandidate } from '@trail/shared';
import { api } from '../api';
import { useLocale } from './i18n';

export interface LocalisedBundle {
  title: string;
  content: string;
  actions: CandidateAction[] | null;
}

export function useCandidateBundle(candidate: QueueCandidate): LocalisedBundle {
  const locale = useLocale();
  const cachedTitle = candidate.translations?.[locale]?.title;
  const cachedContent = candidate.translations?.[locale]?.content;

  // Initial state uses whatever's cached on the candidate. EN reads plain
  // title/content; DA reads from translations.da if present, else falls
  // back to EN. The async effect below fills in the gaps.
  const [bundle, setBundle] = useState<LocalisedBundle>(() => ({
    title: locale === 'en' ? candidate.title : cachedTitle ?? candidate.title,
    content: locale === 'en' ? candidate.content : cachedContent ?? candidate.content,
    actions: candidate.actions,
  }));

  useEffect(() => {
    // Reset state whenever the underlying candidate changes — otherwise
    // a row whose id re-uses a DOM node from a prior candidate would show
    // stale translations for a frame.
    setBundle({
      title: locale === 'en' ? candidate.title : cachedTitle ?? candidate.title,
      content: locale === 'en' ? candidate.content : cachedContent ?? candidate.content,
      actions: candidate.actions,
    });

    if (locale === 'en') return; // EN needs no server hit

    // Decide whether a fetch is warranted. Fetch when ANY translatable
    // field is missing for this locale: title, content, or any action's
    // label/explanation. This lets us batch the LLM call so one request
    // covers the whole card.
    const needsTitle = cachedTitle === undefined;
    const needsContent = cachedContent === undefined;
    const needsActions = (candidate.actions ?? []).some((a) => {
      const lbl = (a.label as Record<string, unknown>)[locale];
      const exp = (a.explanation as Record<string, unknown>)[locale];
      return typeof lbl !== 'string' || typeof exp !== 'string';
    });
    if (!needsTitle && !needsContent && !needsActions) return;

    let cancelled = false;
    api<{ locale: string; title: string; content: string; actions: CandidateAction[] }>(
      `/api/v1/queue/${encodeURIComponent(candidate.id)}/translate?locale=${locale}`,
    )
      .then((r) => {
        if (cancelled) return;
        setBundle({ title: r.title, content: r.content, actions: r.actions });
      })
      .catch(() => {
        // Translation failed: keep whatever we had (EN fallback is fine).
      });
    return () => {
      cancelled = true;
    };
  }, [candidate.id, candidate.title, candidate.content, candidate.translations, candidate.actions, locale, cachedTitle, cachedContent]);

  return bundle;
}
