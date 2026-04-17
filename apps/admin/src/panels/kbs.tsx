import { useCallback, useEffect, useState } from 'preact/hooks';
import type { KnowledgeBase } from '@trail/shared';
import { listKnowledgeBases, ApiError } from '../api';
import { useEvents, onStreamOpen, onFocusRefresh, debounce } from '../lib/event-stream';
import { invalidateKbs } from '../lib/kb-cache';

export function KnowledgeBasesPanel() {
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
        <h1 class="text-2xl font-semibold mb-2">Couldn't load Trails</h1>
        <p class="text-[color:var(--color-fg-muted)]">{error}</p>
      </div>
    );
  }

  if (!kbs) {
    return (
      <div class="page-shell loading-delayed text-[color:var(--color-fg-muted)] text-sm">
        Loading Trails…
      </div>
    );
  }

  if (!kbs.length) {
    return (
      <div class="page-shell text-center">
        <h1 class="text-2xl font-semibold mb-2">No Trails yet</h1>
        <p class="text-[color:var(--color-fg-muted)]">
          Create your first Trail from the engine API. The admin UI will wire up a "Create Trail"
          button in the next session.
        </p>
      </div>
    );
  }

  return (
    <div class="page-shell">
      <header class="mb-8">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">Your Trails</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          Pick a Trail to open its curator queue.
        </p>
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
              <a href={`/kb/${kb.id}/neurons`} class="block px-4 py-3">
                <div class="flex items-baseline justify-between gap-4">
                  <div class="min-w-0">
                    <div class="font-medium">{kb.name}</div>
                    {kb.description ? (
                      <p class="text-sm text-[color:var(--color-fg-muted)] mt-0.5 line-clamp-2">
                        {kb.description}
                      </p>
                    ) : null}
                  </div>
                  <div class="flex items-center gap-3 shrink-0">
                    {pending > 0 ? (
                      <span
                        class="inline-flex items-center justify-center min-w-[1.5rem] h-[1.5rem] px-2 rounded-full text-[11px] font-mono font-semibold bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]"
                        title={`${pending} pending in Queue`}
                        aria-label={`${pending} pending`}
                      >
                        {pending}
                      </span>
                    ) : null}
                    <code class="text-xs text-[color:var(--color-fg-subtle)] font-mono">
                      {kb.slug}
                    </code>
                  </div>
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
