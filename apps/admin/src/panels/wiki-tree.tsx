import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import type { Document } from '@trail/shared';
import { listWikiPages, ApiError } from '../api';
import { displayPath } from '../lib/display-path';
import { useEvents, onStreamOpen } from '../lib/event-stream';

/**
 * Neurons tree — groups all compiled wiki pages in a KB by their
 * `path` directory. Each page links to /kb/:kbId/neurons/:slug
 * (filename without .md).
 */
export function WikiTreePanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const [pages, setPages] = useState<Document[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!kbId) return;
    listWikiPages(kbId)
      .then(setPages)
      .catch((err: ApiError) => setError(err.message));
  }, [kbId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // A candidate_approved event means a Neuron was created or updated. A
  // candidate_rejected means nothing changed in the Neurons set. Refetch
  // on approval so new Neurons appear as soon as a curator (or the F19
  // policy) commits one.
  useEvents((e) => {
    if (e.kbId !== kbId) return;
    if (e.type === 'candidate_approved') reload();
  });
  useEffect(() => onStreamOpen(reload), [reload]);

  const grouped = useMemo(() => {
    if (!pages) return null;
    const groups = new Map<string, Document[]>();
    for (const p of pages) {
      const key = (p as { path?: string }).path ?? '/';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [pages]);

  return (
    <div class="page-shell">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">Neurons</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          {pages ? `${pages.length} compiled page${pages.length === 1 ? '' : 's'}` : (
            <span class="loading-delayed inline-block">Loading…</span>
          )}
        </p>
      </header>

      {error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm">
          {error}
        </div>
      ) : null}

      {grouped?.length === 0 ? (
        <div class="text-center py-16 text-[color:var(--color-fg-subtle)]">
          No Neurons yet. Approve a candidate in the queue to grow this Trail.
        </div>
      ) : null}

      <div class="space-y-6">
        {grouped?.map(([path, docs]) => (
          <section key={path}>
            <h2 class="font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-2">
              {displayPath(path)}
            </h2>
            <ul class="space-y-1">
              {docs.map((doc) => {
                const d = doc as Document & { filename: string; title: string | null };
                const slug = d.filename.replace(/\.md$/i, '');
                return (
                  <li key={doc.id}>
                    <a
                      href={`/kb/${kbId}/neurons/${encodeURIComponent(slug)}`}
                      class="group flex items-baseline justify-between gap-4 px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]/80 hover:border-[color:var(--color-border-strong)] transition"
                    >
                      <div class="min-w-0">
                        <div class="text-sm font-medium truncate">
                          {d.title ?? slug}
                        </div>
                        <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] truncate">
                          {d.filename}
                        </div>
                      </div>
                      <span class="text-[color:var(--color-fg-subtle)] group-hover:text-[color:var(--color-accent)] transition">
                        →
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
