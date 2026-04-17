/**
 * DynamicActionButtons — renders the resolution options a candidate offers.
 *
 * Two shapes:
 *   - Legacy candidates (`actions === null`) get the default Approve/Reject
 *     pair rendered with system strings from the admin's i18n dict.
 *   - Rich candidates (non-null `actions`) render one button per action
 *     plus a per-action "What does this mean?" expander with the LLM-
 *     generated explanation in the user's locale.
 *
 * Locale is tracked via `useLocale()`. For non-EN locales the component
 * fires GET /queue/:id/actions?locale=<loc> to ensure translations are
 * populated, then renders from the fresh data. While the first LLM
 * translation is in flight the EN strings show — no spinner, no blank
 * buttons. A second view in the same locale is cached and instant.
 *
 * Action click → `onResolve(actionId)` — the parent handles the HTTP
 * POST, error toasts, and state reload.
 */
import { useEffect, useState } from 'preact/hooks';
import type { CandidateAction, QueueCandidate } from '@trail/shared';
import { bilingual, t, useLocale } from '../lib/i18n';
import { api } from '../api';

interface Props {
  candidate: QueueCandidate;
  busy: boolean;
  /** Called when the curator clicks an action. Receives the whole action
   *  so the parent can reach into args (e.g. which Neuron to retire). */
  onResolve: (action: CandidateAction) => void;
}

export function DynamicActionButtons({ candidate, busy, onResolve }: Props) {
  const locale = useLocale();
  const [actions, setActions] = useState<CandidateAction[] | null>(
    candidate.actions,
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setActions(candidate.actions);
    setExpanded(null);
  }, [candidate.id, candidate.actions]);

  useEffect(() => {
    // Only fetch translations for rich candidates in a non-EN locale where
    // at least one action is missing the locale string. Legacy candidates
    // (null actions) render via default i18n dict — no LLM call needed.
    if (!candidate.actions || locale === 'en') return;
    const missing = candidate.actions.some((a) => {
      const label = (a.label as Record<string, unknown>)[locale];
      const explanation = (a.explanation as Record<string, unknown>)[locale];
      return typeof label !== 'string' || typeof explanation !== 'string';
    });
    if (!missing) return;

    let cancelled = false;
    api<{ locale: string; actions: CandidateAction[] }>(
      `/api/v1/queue/${encodeURIComponent(candidate.id)}/actions?locale=${locale}`,
    )
      .then((r) => {
        if (!cancelled) setActions(r.actions);
      })
      .catch(() => {
        // Translation failure degrades gracefully — English stays shown.
      });
    return () => {
      cancelled = true;
    };
  }, [candidate.id, candidate.actions, locale]);

  if (candidate.status !== 'pending') return null;

  // Legacy candidate: render system-i18n defaults via t(), so Danish users
  // see "Godkend"/"Afvis" without an LLM call.
  if (!actions) {
    return (
      <div class="flex flex-col gap-2 shrink-0">
        <button
          disabled={busy}
          onClick={() =>
            onResolve({
              id: 'approve',
              effect: 'approve',
              label: { en: 'Approve' },
              explanation: { en: 'Accept this candidate.' },
            })
          }
          class="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-fg)] text-[color:var(--color-bg)] font-medium hover:bg-[color:var(--color-fg)]/90 disabled:opacity-50 transition"
        >
          {busy ? '…' : t('common.approve')}
        </button>
        <button
          disabled={busy}
          onClick={() =>
            onResolve({
              id: 'reject',
              effect: 'reject',
              label: { en: 'Reject' },
              explanation: { en: 'Discard this candidate.' },
            })
          }
          class="px-3 py-1.5 text-sm rounded-md border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)] disabled:opacity-50 transition"
        >
          {t('common.reject')}
        </button>
      </div>
    );
  }

  // Rich candidate: one button per action. The primary styling goes to
  // the first action in the list — producers are responsible for ordering
  // so the most curator-useful choice is first.
  return (
    <div class="flex flex-col gap-1.5 shrink-0 min-w-[180px] max-w-[260px]">
      {actions.map((action, i) => {
        const isPrimary = i === 0;
        const isExpanded = expanded === action.id;
        return (
          <div key={action.id} class="flex flex-col gap-0.5">
            <button
              disabled={busy}
              onClick={() => onResolve(action)}
              class={
                'px-3 py-1.5 text-sm rounded-md font-medium disabled:opacity-50 transition text-left ' +
                (isPrimary
                  ? 'bg-[color:var(--color-fg)] text-[color:var(--color-bg)] hover:bg-[color:var(--color-fg)]/90'
                  : 'border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)]')
              }
            >
              {busy ? '…' : bilingual(action.label, locale)}
            </button>
            <button
              onClick={() => setExpanded(isExpanded ? null : action.id)}
              class="text-[10px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg-muted)] transition px-1 text-left"
            >
              {isExpanded ? `▲ ${t('common.close')}` : `▼ ${t('queue.item.whatDoesThisMean')}`}
            </button>
            {isExpanded ? (
              <div class="text-xs text-[color:var(--color-fg-muted)] leading-relaxed bg-[color:var(--color-bg)] border border-[color:var(--color-border)] rounded-md px-3 py-2 mt-1">
                {bilingual(action.explanation, locale)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
