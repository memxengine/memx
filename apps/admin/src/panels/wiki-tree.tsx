import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import type { Document } from '@trail/shared';
import { listWikiPages, runLint, ApiError } from '../api';
import { displayPath } from '../lib/display-path';
import { useEvents, onStreamOpen, onFocusRefresh, debounce } from '../lib/event-stream';

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
  const [lintBusy, setLintBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function onRunLint() {
    if (!kbId || lintBusy) return;
    setLintBusy(true);
    try {
      const r = await runLint(kbId);
      const parts = r.detectors
        .filter((d) => d.found > 0 || d.emitted > 0)
        .map((d) => `${d.name}: ${d.emitted} new${d.skippedExisting ? `, ${d.skippedExisting} skipped` : ''}`);
      setToast({
        kind: 'success',
        text: r.totalEmitted === 0
          ? 'Lint clean — no new findings.'
          : `Lint: ${r.totalEmitted} new candidate${r.totalEmitted === 1 ? '' : 's'} in queue (${parts.join(' · ')}).`,
      });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Lint failed' });
    } finally {
      setLintBusy(false);
    }
  }

  const reload = useCallback(() => {
    if (!kbId) return;
    listWikiPages(kbId)
      .then(setPages)
      .catch((err: ApiError) => setError(err.message));
  }, [kbId]);
  const reloadDebounced = useCallback(debounce(reload, 100), [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  // A candidate_approved event means a Neuron was created or updated. A
  // candidate_rejected means nothing changed in the Neurons set. Debounced
  // so a bulk-approve of many candidates coalesces into a single reload.
  useEvents((e) => {
    if (e.kbId !== kbId) return;
    if (e.type === 'candidate_approved') reloadDebounced();
  });
  useEffect(() => onStreamOpen(reload), [reload]);
  useEffect(() => onFocusRefresh(reload), [reload]);

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
      <header class="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight mb-1">Neurons</h1>
          <p class="text-[color:var(--color-fg-muted)] text-sm">
            {pages ? `${pages.length} compiled page${pages.length === 1 ? '' : 's'}` : (
              <span class="loading-delayed inline-block">Loading…</span>
            )}
          </p>
        </div>
        <button
          onClick={onRunLint}
          disabled={lintBusy || !pages}
          title="Scan Neurons for orphans, stale pages, and contradictions"
          class="shrink-0 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border border-[color:var(--color-border-strong)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {lintBusy ? '…running' : 'Run lint'}
        </button>
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
                const d = doc as Document & { filename: string; title: string | null; path?: string };
                const slug = d.filename.replace(/\.md$/i, '');
                const origin = classifyOrigin(d.path);
                return (
                  <li key={doc.id}>
                    <a
                      href={`/kb/${kbId}/neurons/${encodeURIComponent(slug)}`}
                      class="group flex items-baseline justify-between gap-4 px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]/80 hover:border-[color:var(--color-border-strong)] transition"
                    >
                      <div class="min-w-0">
                        <div class="text-sm font-medium truncate flex items-baseline gap-2">
                          {origin ? (
                            <span
                              class={
                                'shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider ' +
                                originTone(origin)
                              }
                              title={originTitle(origin)}
                            >
                              {origin}
                            </span>
                          ) : null}
                          <span class="truncate">{d.title ?? slug}</span>
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

      {toast ? (
        <div
          class={
            'fixed bottom-6 right-6 z-40 px-4 py-3 rounded-md border text-sm shadow-lg ' +
            (toast.kind === 'success'
              ? 'border-[color:var(--color-success)]/30 bg-[color:var(--color-success)]/10'
              : 'border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10')
          }
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

type Origin = 'chat' | 'source' | 'session' | 'concept' | 'entity';

/**
 * Infer where a Neuron came from by its path directory. The ingest prompt
 * writes concepts/entities/sources into well-known subdirectories, and
 * chat-answer + buddy-session Neurons live under their own roots. Labelling
 * them in the tree tells the curator "this was compiled from a PDF", "this
 * came from a chat question", "this was a buddy cc-session decision".
 */
function classifyOrigin(path: string | undefined | null): Origin | null {
  if (!path) return null;
  if (path.startsWith('/neurons/queries/') || path.startsWith('/wiki/queries/')) return 'chat';
  if (path.startsWith('/neurons/sources/') || path.startsWith('/wiki/sources/')) return 'source';
  if (path.startsWith('/neurons/sessions/') || path.startsWith('/wiki/sessions/')) return 'session';
  if (path.startsWith('/neurons/concepts/') || path.startsWith('/wiki/concepts/')) return 'concept';
  if (path.startsWith('/neurons/entities/') || path.startsWith('/wiki/entities/')) return 'entity';
  return null;
}

function originTone(origin: Origin): string {
  switch (origin) {
    case 'chat':
      return 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)]';
    case 'source':
      return 'bg-[color:var(--color-fg)]/10 text-[color:var(--color-fg-muted)]';
    case 'session':
      return 'bg-[color:var(--color-success)]/10 text-[color:var(--color-success)]';
    default:
      return 'bg-[color:var(--color-bg)] border border-[color:var(--color-border)] text-[color:var(--color-fg-subtle)]';
  }
}

function originTitle(origin: Origin): string {
  switch (origin) {
    case 'chat':
      return 'Neuron promoted from a chat answer';
    case 'source':
      return 'Compiled summary of an uploaded source document';
    case 'session':
      return 'Decision captured from a cc session (F39)';
    case 'concept':
      return 'Abstract concept compiled by the wiki LLM';
    case 'entity':
      return 'Person, organization, or tool compiled by the wiki LLM';
  }
}
