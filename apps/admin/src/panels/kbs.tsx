import { useCallback, useEffect, useState } from 'preact/hooks';
import type { KnowledgeBase } from '@trail/shared';
import { listKnowledgeBases, ApiError } from '../api';
import { useEvents, onStreamOpen } from '../lib/event-stream';
import { invalidateKbs } from '../lib/kb-cache';

export function KnowledgeBasesPanel() {
  const [kbs, setKbs] = useState<KnowledgeBase[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listKnowledgeBases()
      .then(setKbs)
      .catch((err: ApiError) => setError(err.message));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // A new Trail created by any route (admin UI, bearer API, future CLI)
  // surfaces here live without a reload. Also bust the module-level KB
  // cache so the next useKb(newId) call in TrailNav can resolve it.
  useEvents((e) => {
    if (e.type === 'kb_created') {
      invalidateKbs();
      reload();
    }
  });
  useEffect(() => onStreamOpen(reload), [reload]);

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
        {kbs.map((kb) => (
          <li
            key={kb.id}
            class="border border-[color:var(--color-border)] rounded-md bg-[color:var(--color-bg-card)]/80 hover:border-[color:var(--color-border-strong)] transition"
          >
            <a href={`/kb/${kb.id}/neurons`} class="block px-4 py-3">
              <div class="flex items-baseline justify-between gap-4">
                <div>
                  <div class="font-medium">{kb.name}</div>
                  {kb.description ? (
                    <p class="text-sm text-[color:var(--color-fg-muted)] mt-0.5 line-clamp-2">
                      {kb.description}
                    </p>
                  ) : null}
                </div>
                <code class="text-xs text-[color:var(--color-fg-subtle)] font-mono">
                  {kb.slug}
                </code>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
