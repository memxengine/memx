import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { useKb } from '../lib/kb-cache';
import { t } from '../lib/i18n';
import { getCostSummary, costCsvUrl, ApiError, type CostSummary } from '../api';
import { CenteredLoader } from '../components/centered-loader';

/**
 * F151 — Cost tab. Shows running total, daily bar-chart (CSS-only),
 * top-10 most expensive sources, per-Neuron avg estimate, and CSV
 * export. Data source: GET /knowledge-bases/:kbId/cost.
 *
 * No chart library — a simple flex-box bar rendering keeps the
 * admin bundle small (F18 values). A cost curve doesn't need
 * 200KB of Recharts. If that changes (logarithmic scale, hover,
 * etc.), swap in shadcn's chart component later.
 */

const WINDOWS: Array<{ value: number; label: string }> = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
  { value: 365, label: '1y' },
];

function formatCents(cents: number): string {
  if (cents === 0) return '0¢';
  if (cents < 100) return `${cents}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

export function CostPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const kb = useKb(kbId);
  const [window, setWindow] = useState<number>(30);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading || !summary) {
    return <CenteredLoader />;
  }
  if (error) {
    return <div class="page-shell text-red-500">Error: {error}</div>;
  }

  const maxDayCents = Math.max(...summary.byDay.map((d) => d.cents), 1);

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
          <div class="text-2xl font-mono">{formatCents(summary.totalCents)}</div>
          <div class="text-xs text-[color:var(--color-fg-muted)] mt-1">
            {summary.jobCount} ingest{summary.jobCount === 1 ? '' : 's'}
          </div>
        </div>
        <div class="p-3 rounded border border-[color:var(--color-border)]">
          <div class="text-xs text-[color:var(--color-fg-muted)]">Pr. Neuron (snit)</div>
          <div class="text-2xl font-mono">
            {summary.avgCentsPerNeuron === 0 ? '—' : `${summary.avgCentsPerNeuron.toFixed(2)}¢`}
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
                  title={`${d.date}: ${formatCents(d.cents)} · ${d.jobs} job${d.jobs === 1 ? '' : 's'}`}
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

      {/* Top sources */}
      <div>
        <h2 class="text-sm font-medium mb-2 text-[color:var(--color-fg-muted)]">
          Dyreste kilder
        </h2>
        {summary.bySource.length === 0 ? (
          <div class="p-4 text-sm text-[color:var(--color-fg-muted)] border border-dashed border-[color:var(--color-border)] rounded">
            Ingen kilder med cost-data endnu.
          </div>
        ) : (
          <table class="w-full text-sm">
            <thead class="text-xs text-[color:var(--color-fg-muted)] uppercase tracking-wide text-left">
              <tr class="border-b border-[color:var(--color-border)]">
                <th class="py-2 pr-3">Kilde</th>
                <th class="py-2 pr-3 text-right">Cost</th>
                <th class="py-2 text-right">Ingests</th>
              </tr>
            </thead>
            <tbody>
              {summary.bySource.map((s) => (
                <tr
                  key={s.documentId}
                  class="border-b border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-subtle)]"
                >
                  <td class="py-2 pr-3">
                    <a
                      href={`/kb/${kbId}/sources/${s.documentId}/compare`}
                      class="hover:underline"
                    >
                      {s.title ?? s.filename}
                    </a>
                    <div class="text-xs text-[color:var(--color-fg-muted)] font-mono">
                      {s.filename}
                    </div>
                  </td>
                  <td class="py-2 pr-3 text-right font-mono">{formatCents(s.cents)}</td>
                  <td class="py-2 text-right font-mono text-[color:var(--color-fg-muted)]">
                    {s.jobCount}
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
