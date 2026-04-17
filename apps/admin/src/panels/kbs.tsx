import { useCallback, useEffect, useState } from 'preact/hooks';
import type { KnowledgeBase } from '@trail/shared';
import { listKnowledgeBases, updateKnowledgeBase, ApiError } from '../api';
import { useEvents, onStreamOpen, onFocusRefresh, debounce } from '../lib/event-stream';
import { invalidateKbs } from '../lib/kb-cache';
import { t, useLocale } from '../lib/i18n';

export function KnowledgeBasesPanel() {
  useLocale();
  const [kbs, setKbs] = useState<KnowledgeBase[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listKnowledgeBases()
      .then(setKbs)
      .catch((err: ApiError) => setError(err.message));
  }, []);
  // Event-driven refetch must be debounced so bulk actions (reject 22 at
  // once) coalesce into a single fetch. Without this the browser queues
  // 22 fetches and out-of-order HTTP responses can overwrite the correct
  // final state with stale data.
  const reloadDebounced = useCallback(debounce(reload, 100), [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  // A new Trail created by any route (admin UI, bearer API, future CLI)
  // surfaces here live without a reload. Also bust the module-level KB
  // cache so the next useKb(newId) call in TrailNav can resolve it.
  //
  // Candidate events trigger a refetch too so the per-Trail pending badges
  // update live — the server's LIST_SQL recomputes pendingCandidateCount
  // per row, and re-issuing the same query is cheap.
  useEvents((e) => {
    if (e.type === 'kb_created') {
      invalidateKbs();
      reloadDebounced();
    } else if (
      e.type === 'candidate_created' ||
      e.type === 'candidate_approved' ||
      e.type === 'candidate_resolved'
    ) {
      reloadDebounced();
    }
  });
  useEffect(() => onStreamOpen(reload), [reload]);
  useEffect(() => onFocusRefresh(reload), [reload]);

  if (error) {
    return (
      <div class="page-shell">
        <h1 class="text-2xl font-semibold mb-2">{t('common.error')}</h1>
        <p class="text-[color:var(--color-fg-muted)]">{error}</p>
      </div>
    );
  }

  if (!kbs) {
    return (
      <div class="page-shell loading-delayed text-[color:var(--color-fg-muted)] text-sm">
        {t('common.loading')}
      </div>
    );
  }

  if (!kbs.length) {
    return (
      <div class="page-shell text-center">
        <h1 class="text-2xl font-semibold mb-2">{t('kbs.title')}</h1>
        <p class="text-[color:var(--color-fg-muted)]">{t('kbs.empty')}</p>
      </div>
    );
  }

  return (
    <div class="page-shell">
      <header class="mb-8">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">{t('kbs.title')}</h1>
      </header>
      <ul class="space-y-2">
        {kbs.map((kb) => {
          // The LIST_SQL endpoint returns a pendingCandidateCount field the
          // shared KnowledgeBase type doesn't declare; read it defensively.
          const pending = (kb as KnowledgeBase & { pendingCandidateCount?: number })
            .pendingCandidateCount ?? 0;
          return (
            <li
              key={kb.id}
              class="border border-[color:var(--color-border)] rounded-md bg-[color:var(--color-bg-card)]/80 hover:border-[color:var(--color-border-strong)] transition"
            >
              <div class="px-4 py-3">
                <div class="flex items-baseline justify-between gap-4">
                  <a
                    href={`/kb/${kb.id}/neurons`}
                    class="min-w-0 flex-1 hover:opacity-90 transition"
                  >
                    <div class="font-medium">{kb.name}</div>
                    {kb.description ? (
                      <p class="text-sm text-[color:var(--color-fg-muted)] mt-0.5 line-clamp-2">
                        {kb.description}
                      </p>
                    ) : null}
                  </a>
                  <div class="flex items-center gap-3 shrink-0">
                    <LintPolicyToggle kb={kb} onUpdated={reload} />
                    {pending > 0 ? (
                      <span
                        class="inline-flex items-center justify-center min-w-[1.5rem] h-[1.5rem] px-2 rounded-full text-[11px] font-mono font-semibold bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]"
                        title={t('kbs.pendingBadge', { n: pending })}
                        aria-label={t('kbs.pendingBadge', { n: pending })}
                      >
                        {pending}
                      </span>
                    ) : null}
                    <code class="text-xs text-[color:var(--color-fg-subtle)] font-mono">
                      {kb.slug}
                    </code>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Two-button segmented control for flipping a Trail's lint policy
 * between 'trusting' (rejected findings stay dismissed) and 'strict'
 * (rejected findings re-fire on next lint pass). Default is trusting —
 * the opt-in to strict is a deliberate choice for curators who want the
 * extra safety net against wrongful dismissals.
 */
function LintPolicyToggle({
  kb,
  onUpdated,
}: {
  kb: KnowledgeBase;
  onUpdated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const current = kb.lintPolicy ?? 'trusting';

  const flip = async (next: 'trusting' | 'strict'): Promise<void> => {
    if (next === current || busy) return;
    setBusy(true);
    try {
      await updateKnowledgeBase(kb.id, { lintPolicy: next });
      onUpdated();
    } catch {
      // Silent — the refresh below will show current server state if the
      // PATCH landed; if it didn't, the toggle stays where it was.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      class="inline-flex items-center rounded-md border border-[color:var(--color-border)] overflow-hidden text-[10px] font-mono uppercase tracking-wide"
      role="group"
      aria-label={t('kbs.lintPolicy.label')}
    >
      {(['trusting', 'strict'] as const).map((p) => {
        const active = p === current;
        return (
          <button
            key={p}
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              void flip(p);
            }}
            title={t(`kbs.lintPolicy.${p}Hint`)}
            class={
              'px-2 py-1 transition disabled:opacity-50 ' +
              (active
                ? 'bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]'
                : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg)]')
            }
            aria-pressed={active}
          >
            {t(`kbs.lintPolicy.${p}`)}
          </button>
        );
      })}
    </div>
  );
}
