import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { useKb } from '../lib/kb-cache';
import { t, useLocale } from '../lib/i18n';
import {
  getCostSummary,
  costCsvUrl,
  getCostSources,
  getFxRate,
  ApiError,
  type CostSummary,
  type CostSourcesPage,
  type CostSourceSort,
  type CostSortOrder,
  type FxRate,
} from '../api';
import { formatCostForLocale } from '../lib/currency';
import { CenteredLoader } from '../components/centered-loader';

/**
 * F151 — Cost tab. Shows running total, daily CSS-only bar-chart,
 * top-line metrics, and a paginated + sortable source list.
 *
 * The summary (totals, chart, window metrics) loads from
 * GET /cost once per window-change; the source list is a separate
 * paginated query so curators with 500-source KBs don't pay the
 * cost of shipping everything up-front.
 */

const WINDOWS: Array<{ value: number; label: string }> = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
  { value: 365, label: '1y' },
];

const PAGE_SIZE = 25;

function displayTitle(title: string | null, filename: string): string {
  // Strip trailing `.md` / `.pdf` / etc. extensions when we're falling
  // back to the filename — per Christian 2026-04-24: extension is noise
  // in a source-list for non-technical curators.
  if (title && title.trim().length > 0) return title;
  return filename.replace(/\.[a-z0-9]+$/i, '');
}

export function CostPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const kb = useKb(kbId);
  const locale = useLocale();
  const [window, setWindow] = useState<number>(30);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fxRate, setFxRate] = useState<FxRate | null>(null);

  // Source-list pagination + sort state
  const [sort, setSort] = useState<CostSourceSort>('cost');
  const [order, setOrder] = useState<CostSortOrder>('desc');
  const [offset, setOffset] = useState(0);
  const [sourcesPage, setSourcesPage] = useState<CostSourcesPage | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);

  // Fetch USD→DKK rate when locale is Danish. Silent on failure —
  // the formatter falls back to USD cents if fxRate stays null.
  useEffect(() => {
    if (locale !== 'da') {
      setFxRate(null);
      return;
    }
    getFxRate('USD', 'DKK')
      .then(setFxRate)
      .catch((err) => {
        console.warn('[cost-panel] FX rate fetch failed, showing USD:', err);
        setFxRate(null);
      });
  }, [locale]);

  const fmt = (cents: number) => formatCostForLocale(cents, locale, fxRate);

  // Summary fetch (totals + chart). Separate from source list because
  // they have different cache + invalidation characteristics.
  useEffect(() => {
    if (!kbId) return;
    setLoading(true);
    setError(null);
    getCostSummary(kbId, window)
      .then((s) => {
        setSummary(s);
        setLoading(false);
      })
      .catch((err: ApiError) => {
        setError(err.message);
        setLoading(false);
      });
  }, [kbId, window]);

  // Source-list fetch. Refetches whenever window, sort, order, or
  // offset changes.
  useEffect(() => {
    if (!kbId) return;
    setSourcesLoading(true);
    getCostSources(kbId, { windowDays: window, sort, order, offset, limit: PAGE_SIZE })
      .then((p) => {
        setSourcesPage(p);
        setSourcesLoading(false);
      })
      .catch((err: ApiError) => {
        setError(err.message);
        setSourcesLoading(false);
      });
  }, [kbId, window, sort, order, offset]);

  // Reset offset when the user changes window OR sort — landing on
  // page 7 of a different sort is confusing.
  useEffect(() => {
    setOffset(0);
  }, [window, sort, order]);

  function toggleSort(key: CostSourceSort): void {
    if (sort === key) {
      setOrder(order === 'desc' ? 'asc' : 'desc');
    } else {
      setSort(key);
      setOrder(key === 'filename' || key === 'title' ? 'asc' : 'desc');
    }
  }

  function sortIndicator(key: CostSourceSort): string {
    if (sort !== key) return '';
    return order === 'desc' ? ' ↓' : ' ↑';
  }

  if (loading || !summary) {
    return <CenteredLoader />;
  }
  if (error) {
    return <div class="page-shell text-red-500">Error: {error}</div>;
  }

  const maxDayCents = Math.max(...summary.byDay.map((d) => d.cents), 1);
  const total = sourcesPage?.total ?? 0;
  const pageStart = offset + 1;
  const pageEnd = offset + (sourcesPage?.sources.length ?? 0);
  const hasPrev = offset > 0;
  const hasNext = sourcesPage !== null && pageEnd < total;

  return (
    <div class="page-shell space-y-6">
      {/* Header with window switcher + CSV export */}
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-semibold">
          {kb?.name ?? kbId} — {t('nav.cost')}
        </h1>
        <div class="flex items-center gap-2">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              onClick={() => setWindow(w.value)}
              class={
                'px-2 py-1 text-xs font-mono rounded transition ' +
                (window === w.value
                  ? 'bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]'
                  : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
              }
            >
              {w.label}
            </button>
          ))}
          <a
            href={costCsvUrl(kbId, window)}
            download
            class="ml-3 text-xs font-mono text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] underline"
          >
            Eksportér CSV
          </a>
        </div>
      </div>

      {/* Top-line metrics */}
      <div class="grid grid-cols-3 gap-4">
        <div class="p-3 rounded border border-[color:var(--color-border)]">
          <div class="text-xs text-[color:var(--color-fg-muted)]">Total</div>
          <div class="text-2xl font-mono">{fmt(summary.totalCents)}</div>
          <div class="text-xs text-[color:var(--color-fg-muted)] mt-1">
            {summary.jobCount} ingest{summary.jobCount === 1 ? '' : 's'}
          </div>
        </div>
        <div class="p-3 rounded border border-[color:var(--color-border)]">
          <div class="text-xs text-[color:var(--color-fg-muted)]">Pr. Neuron (snit)</div>
          <div class="text-2xl font-mono">
            {summary.avgCentsPerNeuron === 0 ? '—' : fmt(summary.avgCentsPerNeuron)}
          </div>
          <div class="text-xs text-[color:var(--color-fg-muted)] mt-1">
            {summary.avgCentsPerNeuron === 0 ? 'ingen cost-data' : 'estimat'}
          </div>
        </div>
        <div class="p-3 rounded border border-[color:var(--color-border)]">
          <div class="text-xs text-[color:var(--color-fg-muted)]">Vindue</div>
          <div class="text-2xl font-mono">{summary.windowDays}d</div>
          <div class="text-xs text-[color:var(--color-fg-muted)] mt-1">
            {summary.byDay.length} dage m. data
          </div>
        </div>
      </div>

      {/* Daily bar-chart */}
      <div>
        <h2 class="text-sm font-medium mb-2 text-[color:var(--color-fg-muted)]">
          Dagligt forbrug
        </h2>
        {summary.byDay.length === 0 ? (
          <div class="p-4 text-sm text-[color:var(--color-fg-muted)] border border-dashed border-[color:var(--color-border)] rounded">
            Ingen ingests i dette vindue endnu.
          </div>
        ) : (
          <div class="flex items-end gap-px h-24 p-2 border border-[color:var(--color-border)] rounded bg-[color:var(--color-bg-subtle)]">
            {summary.byDay.map((d) => {
              const heightPct = d.cents === 0 ? 2 : Math.max(2, (d.cents / maxDayCents) * 100);
              return (
                <div
                  key={d.date}
                  title={`${d.date}: ${fmt(d.cents)} · ${d.jobs} job${d.jobs === 1 ? '' : 's'}`}
                  class={
                    'flex-1 min-w-0 rounded-sm transition ' +
                    (d.cents > 0
                      ? 'bg-[color:var(--color-accent)]'
                      : 'bg-[color:var(--color-border)]')
                  }
                  style={{ height: `${heightPct}%` }}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Paginated + sortable source list */}
      <div>
        <div class="flex items-baseline justify-between mb-2">
          <h2 class="text-sm font-medium text-[color:var(--color-fg-muted)]">
            Kilder
            {sourcesPage && total > 0 ? (
              <span class="ml-2 font-normal">
                ({pageStart}–{pageEnd} af {total})
              </span>
            ) : null}
          </h2>
          <div class="flex items-center gap-1">
            <button
              disabled={!hasPrev || sourcesLoading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              class={
                'px-2 py-1 text-xs font-mono rounded transition ' +
                (hasPrev && !sourcesLoading
                  ? 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'
                  : 'text-[color:var(--color-fg-subtle)] cursor-not-allowed')
              }
            >
              ← forrige
            </button>
            <button
              disabled={!hasNext || sourcesLoading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              class={
                'px-2 py-1 text-xs font-mono rounded transition ' +
                (hasNext && !sourcesLoading
                  ? 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'
                  : 'text-[color:var(--color-fg-subtle)] cursor-not-allowed')
              }
            >
              næste →
            </button>
          </div>
        </div>
        {sourcesPage === null || sourcesPage.sources.length === 0 ? (
          <div class="p-4 text-sm text-[color:var(--color-fg-muted)] border border-dashed border-[color:var(--color-border)] rounded">
            Ingen kilder med ingest-historik i dette vindue endnu.
          </div>
        ) : (
          <table class="w-full text-sm">
            <thead class="text-xs text-[color:var(--color-fg-muted)] uppercase tracking-wide text-left">
              <tr class="border-b border-[color:var(--color-border)]">
                <th
                  class="py-2 pr-3 cursor-pointer select-none hover:text-[color:var(--color-fg)]"
                  onClick={() => toggleSort('title')}
                >
                  Kilde{sortIndicator('title')}
                </th>
                <th
                  class="py-2 pr-3 text-right cursor-pointer select-none hover:text-[color:var(--color-fg)]"
                  onClick={() => toggleSort('cost')}
                >
                  Cost{sortIndicator('cost')}
                </th>
                <th
                  class="py-2 pr-3 text-right cursor-pointer select-none hover:text-[color:var(--color-fg)]"
                  onClick={() => toggleSort('jobs')}
                >
                  Ingests{sortIndicator('jobs')}
                </th>
                <th
                  class="py-2 text-right cursor-pointer select-none hover:text-[color:var(--color-fg)]"
                  onClick={() => toggleSort('recent')}
                >
                  Senest{sortIndicator('recent')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sourcesPage.sources.map((s) => (
                <tr
                  key={s.documentId}
                  class="border-b border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-subtle)]"
                >
                  <td class="py-2 pr-3">
                    <a
                      href={`/kb/${kbId}/sources/${s.documentId}/compare`}
                      class="hover:underline"
                    >
                      {displayTitle(s.title, s.filename)}
                    </a>
                  </td>
                  <td class="py-2 pr-3 text-right font-mono">{fmt(s.cents)}</td>
                  <td class="py-2 pr-3 text-right font-mono text-[color:var(--color-fg-muted)]">
                    {s.jobCount}
                  </td>
                  <td class="py-2 text-right font-mono text-xs text-[color:var(--color-fg-muted)]">
                    {s.lastIngestedAt ? s.lastIngestedAt.slice(0, 10) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
