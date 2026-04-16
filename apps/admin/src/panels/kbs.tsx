import { useEffect, useState } from 'preact/hooks';
import type { KnowledgeBase } from '@trail/shared';
import { listKnowledgeBases, ApiError } from '../api';

export function KnowledgeBasesPanel() {
  const [kbs, setKbs] = useState<KnowledgeBase[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listKnowledgeBases()
      .then(setKbs)
      .catch((err: ApiError) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div class="max-w-3xl mx-auto py-12 px-6">
        <h1 class="text-2xl font-semibold mb-2">Couldn't load knowledge bases</h1>
        <p class="text-[color:var(--color-fg-muted)]">{error}</p>
      </div>
    );
  }

  if (!kbs) {
    return (
      <div class="loading-delayed p-8 text-[color:var(--color-fg-muted)] text-sm">
        Loading Trails…
      </div>
    );
  }

  if (!kbs.length) {
    return (
      <div class="max-w-3xl mx-auto py-16 px-6 text-center">
        <h1 class="text-2xl font-semibold mb-2">No Trails yet</h1>
        <p class="text-[color:var(--color-fg-muted)]">
          Create your first Trail from the engine API. The admin UI will wire up a "Create Trail"
          button in the next session.
        </p>
      </div>
    );
  }

  return (
    <div class="max-w-4xl mx-auto py-10 px-6">
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
            class="border border-[color:var(--color-border)] rounded-md bg-[color:var(--color-bg-card)] hover:border-[color:var(--color-border-strong)] transition"
          >
            <a href={`/kb/${kb.id}/queue`} class="block px-4 py-3">
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
