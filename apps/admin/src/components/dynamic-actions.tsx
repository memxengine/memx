/**
 * DynamicActionButtons — renders the resolution options a candidate offers.
 *
 * Two shapes:
 *   - Legacy candidates (`actions === null`) get the default Approve/Reject
 *     pair rendered with system strings from the admin's i18n dict.
 *   - Rich candidates (non-null `actions`) render one button per action
 *     plus a per-action "What does this mean?" expander with the LLM-
 *     generated explanation in the active locale.
 *
 * Locale-aware strings arrive pre-translated via the parent's
 * `useCandidateBundle()` hook: the parent fetches /queue/:id/translate
 * once per card and hands us the already-populated actions array. That
 * keeps the LLM call off the per-component critical path and avoids two
 * components racing to request the same translation.
 *
 * Width is pinned so expanding an explanation doesn't reflow the rest of
 * the card — see the class list on the action column.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import type { CandidateAction, QueueCandidate } from '@trail/shared';
import { bilingual, t, useLocale } from '../lib/i18n';
import { NeuronLoader } from './neuron-loader';

/**
 * Inline `[[target|display]]` rewriter — same resolution rules as the
 * markdown path in rewriteWikiLinks, but emits Preact nodes so an action
 * explanation can carry real clickable anchors without going through a
 * full markdown render. Returns a mixed array of strings + anchor nodes.
 */
function explanationWithLinks(text: string, kbId: string): Array<VNode | string> {
  const out: Array<VNode | string> = [];
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const target = m[1]!.replace(/\.md$/i, '').split('/').pop()!.trim();
    const display = (m[2] ?? m[1]!).trim();
    const href = `/kb/${encodeURIComponent(kbId)}/neurons/${encodeURIComponent(target)}`;
    out.push(
      <a
        href={href}
        class="underline underline-offset-2 decoration-[color:var(--color-accent)]/60 hover:decoration-[color:var(--color-accent)] text-[color:var(--color-fg)]"
      >
        {display}
      </a>,
    );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface Props {
  candidate: QueueCandidate;
  /** The KB this candidate lives in — used to build wiki-link hrefs in
   *  the explanation bodies. */
  kbId: string;
  /**
   * Pre-localised actions from the parent's translation bundle. Falls
   * back to `candidate.actions` when the parent hasn't fetched a locale
   * yet; falls back to the default Approve/Reject pair when both are
   * null (legacy candidates).
   */
  localisedActions: CandidateAction[] | null;
  busy: boolean;
  /**
   * The actionId the curator actually clicked (when `busy` is true).
   * Used to scope the Neuron-loader animation to the clicked button
   * instead of every button on the row — otherwise all four buttons
   * would animate simultaneously while one LLM call runs.
   */
  busyActionId?: string | null;
  /** Called when the curator clicks an action. Receives the whole action
   *  so the parent can reach into args (e.g. which Neuron to retire). */
  onResolve: (action: CandidateAction) => void;
  /**
   * When true (parent has a RecommendationBadge showing above), the
   * action buttons start collapsed behind a "Show options" toggle. The
   * curator can trust the recommendation without reading the full
   * action list; click-to-expand reveals the original four buttons
   * unchanged. Default false — legacy candidates without a
   * recommendation always show the buttons up front.
   */
  hideable?: boolean;
}

export function DynamicActionButtons({
  candidate,
  kbId,
  localisedActions,
  busy,
  busyActionId,
  onResolve,
  hideable = false,
}: Props) {
  const locale = useLocale();
  const actions = localisedActions ?? candidate.actions;
  const [expanded, setExpanded] = useState<string | null>(null);
  // When a recommendation is visible above the button column, start
  // collapsed — the curator can trust the LLM and move on without
  // reading every alternative. Click "Show options" to expand.
  const [optionsOpen, setOptionsOpen] = useState(!hideable);
  useEffect(() => {
    setOptionsOpen(!hideable);
  }, [hideable, candidate.id]);
  // Re-parse explanation wiki-links only when locale or candidate shifts;
  // the expansion is a lightweight regex walk but useMemo guarantees a
  // stable VNode list across re-renders for Preact's diffing.
  void useMemo;

  // Close the expander when the underlying candidate changes so a row
  // whose DOM node gets re-used for a different candidate doesn't show
  // a stale explanation.
  useEffect(() => {
    setExpanded(null);
  }, [candidate.id]);

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
  //
  // Width is pinned (`w-[280px]`) so the column stays the same size in
  // both closed and expanded states. Without this the explanation body
  // grows the column and every other row on the page reflows — the button
  // the curator was about to click jumps away. Fixed width trades a tiny
  // bit of text wrapping (fine: labels are ≤4 words by design) for a
  // stable layout that never "chases" the mouse.
  // Collapsed state: a single toggle instead of the 4-button list.
  // Curator trusts the recommendation above → single-click accept
  // path stays dominant. Expanding the options is one more click
  // when the curator wants to override or dismiss.
  if (hideable && !optionsOpen) {
    return (
      <button
        onClick={() => setOptionsOpen(true)}
        class="w-full px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border border-dashed border-[color:var(--color-border)] text-[color:var(--color-fg-subtle)] hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg-muted)] transition"
      >
        ▼ {t('queue.item.showOptions', { n: actions.length })}
      </button>
    );
  }

  return (
    <div class="flex flex-col gap-1.5 shrink-0 w-[280px]">
      {hideable ? (
        <button
          onClick={() => setOptionsOpen(false)}
          class="w-full text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg-muted)] transition text-left px-1 py-0.5"
        >
          ▲ {t('queue.item.hideOptions')}
        </button>
      ) : null}
      {actions.map((action, i) => {
        const isPrimary = i === 0;
        const isExpanded = expanded === action.id;
        const isClicked = busy && busyActionId === action.id;
        return (
          <div key={action.id} class="flex flex-col gap-0.5">
            <button
              disabled={busy}
              onClick={() => onResolve(action)}
              class={
                'w-full px-3 py-1.5 text-sm rounded-md font-medium disabled:opacity-50 transition text-left break-words ' +
                (isPrimary
                  ? 'bg-[color:var(--color-fg)] text-[color:var(--color-bg)] hover:bg-[color:var(--color-fg)]/90'
                  : 'border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)]')
              }
            >
              {isClicked ? (
                <NeuronLoader size={32} label={bilingual(action.label, locale) + '…'} />
              ) : busy ? (
                '…'
              ) : (
                bilingual(action.label, locale)
              )}
            </button>
            <button
              onClick={() => setExpanded(isExpanded ? null : action.id)}
              class="w-full text-[10px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg-muted)] transition px-1 text-left"
            >
              {isExpanded ? `▲ ${t('common.close')}` : `▼ ${t('queue.item.whatDoesThisMean')}`}
            </button>
            {isExpanded ? (
              <div class="w-full text-xs text-[color:var(--color-fg-muted)] leading-relaxed bg-[color:var(--color-bg)] border border-[color:var(--color-border)] rounded-md px-3 py-2 mt-1 break-words">
                {explanationWithLinks(bilingual(action.explanation, locale), kbId)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
