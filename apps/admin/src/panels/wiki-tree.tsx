import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import type { Document } from '@trail/shared';
import { listWikiPages, runLint, ApiError, type WikiSortOrder } from '../api';
import { displayPath } from '../lib/display-path';
import { useEvents, onStreamOpen, onFocusRefresh, debounce } from '../lib/event-stream';
import { t, useLocale } from '../lib/i18n';
import { CenteredLoader } from '../components/centered-loader';

/**
 * Neurons tree — groups all compiled wiki pages in a KB by their
 * `path` directory. Each page links to /kb/:kbId/neurons/:slug
 * (filename without .md).
 */
export function WikiTreePanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  useLocale();
  const [pages, setPages] = useState<Document[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lintBusy, setLintBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  // Sort preference persists in localStorage so returning curators see
  // the same order they left with. `newest` is the default when nothing
  // is cached — living knowledge bases are scanned by "what changed
  // most recently" more often than anything else.
  const [sortOrder, setSortOrderRaw] = useState<WikiSortOrder>(() => {
    try {
      const stored = localStorage.getItem('trail.admin.wiki-sort');
      if (stored === 'newest' || stored === 'oldest' || stored === 'title') return stored;
    } catch {
      // no localStorage (SSR/sandbox)
    }
    return 'newest';
  });
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const setSortOrder = useCallback((next: WikiSortOrder) => {
    setSortOrderRaw(next);
    try {
      localStorage.setItem('trail.admin.wiki-sort', next);
    } catch {
      // ignore
    }
    setSortMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function onRunLint() {
    if (!kbId || lintBusy) return;
    setLintBusy(true);
    try {
      const r = await runLint(kbId);
      const key = r.totalEmitted === 1 ? 'wikiTree.lintDone' : 'wikiTree.lintDonePlural';
      setToast({
        kind: 'success',
        text: r.totalEmitted === 0 ? t('wikiTree.lintClean') : t(key, { n: r.totalEmitted }),
      });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : t('wikiTree.lintFailed') });
    } finally {
      setLintBusy(false);
    }
  }

  const reload = useCallback(() => {
    if (!kbId) return;
    listWikiPages(kbId, sortOrder)
      .then(setPages)
      .catch((err: ApiError) => setError(err.message));
  }, [kbId, sortOrder]);
  const reloadDebounced = useCallback(debounce(reload, 100), [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  // candidate_approved is the narrow "a Neuron was just created/updated"
  // signal — perfect for a tree that only cares about existing pages.
  // candidate_resolved fires on every decision but the tree doesn't need
  // to redraw for rejects or for non-document actions. Debounced so bulk
  // approves coalesce into one reload.
  useEvents((e) => {
    if (e.kbId !== kbId) return;
    if (e.type === 'candidate_approved') reloadDebounced();
  });
  useEffect(() => onStreamOpen(reload), [reload]);
  useEffect(() => onFocusRefresh(reload), [reload]);

  const grouped = useMemo(() => {
    if (!pages) return null;
    const groups = new Map<string, Document[]>();
    // Server already returns pages in the chosen order — preserve it
    // within each group by pushing in iteration order.
    for (const p of pages) {
      const key = (p as { path?: string }).path ?? '/';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    // Sort the GROUPS themselves to match the user's sort preference.
    // Without this only the within-group order changed on sort-switch,
    // which was easy to miss since the eye scans groups top-to-bottom.
    const entries = [...groups.entries()];
    const docTs = (d: Document): number => {
      const raw = (d as { updatedAt?: string; createdAt?: string }).updatedAt
        ?? (d as { createdAt?: string }).createdAt
        ?? '';
      const parsed = new Date(raw.replace(' ', 'T') + (raw.includes('Z') || raw.includes('+') ? '' : 'Z')).getTime();
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    if (sortOrder === 'newest') {
      // Group order = max(updatedAt) of children, descending.
      entries.sort((a, b) => {
        const aMax = Math.max(...a[1].map(docTs));
        const bMax = Math.max(...b[1].map(docTs));
        return bMax - aMax;
      });
    } else if (sortOrder === 'oldest') {
      // Group order = min(createdAt), ascending.
      entries.sort((a, b) => {
        const aMin = Math.min(...a[1].map(docTs));
        const bMin = Math.min(...b[1].map(docTs));
        return aMin - bMin;
      });
    } else {
      // 'title' or unknown → alphabetical by group path.
      entries.sort((a, b) => a[0].localeCompare(b[0]));
    }
    return entries;
  }, [pages, sortOrder]);

  return (
    <div class="page-shell">
      <header class="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight mb-1">{t('wikiTree.title')}</h1>
          <p class="text-[color:var(--color-fg-muted)] text-sm">
            {pages ? (
              t(pages.length === 1 ? 'wikiTree.summary' : 'wikiTree.summaryPlural', { n: pages.length })
            ) : (
              <span class="loading-delayed inline-block">{t('common.loading')}</span>
            )}
          </p>
        </div>
        <div class="shrink-0 flex items-center gap-2">
          <div class="relative">
            <button
              onClick={() => setSortMenuOpen((v) => !v)}
              disabled={!pages}
              title={t('wikiTree.sortHint')}
              aria-expanded={sortMenuOpen}
              class="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border border-[color:var(--color-border-strong)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              <span>{t('wikiTree.sort')}: {t(`wikiTree.sortOptions.${sortOrder}`)}</span>
              <span class="text-[9px]">{sortMenuOpen ? '▲' : '▼'}</span>
            </button>
            {sortMenuOpen ? (
              <div
                class="absolute right-0 top-full mt-1 min-w-[180px] rounded-md border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg)] shadow-lg overflow-hidden z-10"
                role="menu"
              >
                {(['newest', 'oldest', 'title'] as const).map((opt) => (
                  <button
                    key={opt}
                    role="menuitem"
                    onClick={() => setSortOrder(opt)}
                    class={
                      'w-full px-3 py-2 text-left text-[11px] font-mono uppercase tracking-wider transition ' +
                      (opt === sortOrder
                        ? 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-fg)]'
                        : 'text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-card)] hover:text-[color:var(--color-fg)]')
                    }
                  >
                    {t(`wikiTree.sortOptions.${opt}`)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            onClick={onRunLint}
            disabled={lintBusy || !pages}
            title={t('wikiTree.runLintHint')}
            class="shrink-0 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border border-[color:var(--color-border-strong)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {lintBusy ? t('wikiTree.lintRunning') : t('wikiTree.runLint')}
          </button>
        </div>
      </header>

      {error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm">
          {error}
        </div>
      ) : null}

      {!pages && !error ? <CenteredLoader /> : null}

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
                const d = doc as Document & { filename: string; title: string | null; path?: string; createdAt?: string; updatedAt?: string };
                const slug = d.filename.replace(/\.md$/i, '');
                const origin = classifyOrigin(d.path);
                // Prefer updatedAt for the visible timestamp so
                // recently-touched Neurons read as fresh. createdAt is
                // the fallback for rows that have never been edited.
                const ts = d.updatedAt ?? d.createdAt ?? null;
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
                        <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] truncate flex items-center gap-2">
                          <span class="truncate">{d.filename}</span>
                          {ts ? (
                            <>
                              <span class="opacity-60">·</span>
                              <span class="shrink-0" title={ts}>{formatRelative(ts)}</span>
                            </>
                          ) : null}
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
      return 'Abstract concept compiled by the Neuron LLM';
    case 'entity':
      return 'Person, organization, or tool compiled by the Neuron LLM';
  }
}

/**
 * Compact relative timestamp for Neuron list rows. "2m", "3t", "idag",
 * "4d", "2u", "16/04/2026". Errs on the side of brevity — the full ISO
 * timestamp sits in the `title` attribute for hover. SQLite timestamps
 * arrive as "YYYY-MM-DD HH:MM:SS" without timezone; we treat them as UTC.
 */
function formatRelative(iso: string): string {
  const parsed = new Date(iso.replace(' ', 'T') + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'));
  if (Number.isNaN(parsed.getTime())) return iso;
  const now = Date.now();
  const diffMs = now - parsed.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return t('common.time.now');
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}${t('common.time.minute')}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}${t('common.time.hour')}`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}${t('common.time.day')}`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}${t('common.time.week')}`;
  // Older than ~1 month: show absolute date, dd/mm/yyyy (locale-neutral).
  const dd = String(parsed.getDate()).padStart(2, '0');
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const yyyy = parsed.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
