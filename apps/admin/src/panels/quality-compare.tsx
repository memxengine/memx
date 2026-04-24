import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { useKb } from '../lib/kb-cache';
import { t, useLocale } from '../lib/i18n';
import { getQualityRuns, getFxRate, ApiError, type QualityComparison, type FxRate } from '../api';
import { formatCostForLocale, maxPlanLabel } from '../lib/currency';
import { CenteredLoader } from '../components/centered-loader';

/**
 * F151 — Quality-compare tab. Shows every ingest-run against a given
 * source so the curator can compare model output side-by-side.
 *
 * Route: /kb/:kbId/sources/:sourceId/compare
 *
 * Columns: model · cost · turns · wall-clock · neurons · backlinks ·
 * entities · broken links. The "typical" curator-decision: "which
 * model is good enough for this kind of content?"
 */

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

export function QualityComparePanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const sourceId = route.params.sourceId ?? '';
  const kb = useKb(kbId);
  const locale = useLocale();
  const [data, setData] = useState<QualityComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fxRate, setFxRate] = useState<FxRate | null>(null);

  useEffect(() => {
    if (!sourceId) return;
    setLoading(true);
    setError(null);
    getQualityRuns(sourceId)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err: ApiError) => {
        setError(err.message);
        setLoading(false);
      });
  }, [sourceId]);

  // FX rate for DKK display on Danish locale; silent failure → USD
  useEffect(() => {
    if (locale !== 'da') {
      setFxRate(null);
      return;
    }
    getFxRate('USD', 'DKK').then(setFxRate).catch(() => setFxRate(null));
  }, [locale]);

  const fmt = (cents: number) =>
    cents === 0 ? '—' : formatCostForLocale(cents, locale, fxRate);

  if (loading || !data) return <CenteredLoader />;
  if (error) return <div class="page-shell text-red-500">Error: {error}</div>;

  return (
    <div class="page-shell space-y-4">
      <div class="flex items-baseline gap-3 text-sm text-[color:var(--color-fg-muted)]">
        <a href={`/kb/${kbId}/cost`} class="hover:text-[color:var(--color-fg)]">
          {t('quality.back')}
        </a>
        <span>/</span>
        <span class="text-[color:var(--color-fg)] font-medium">
          {data.source.title ?? data.source.filename.replace(/\.[a-z0-9]+$/i, '')}
        </span>
      </div>

      <h1 class="text-xl font-semibold">
        {t('quality.title')}
        <span class="ml-2 text-sm font-normal text-[color:var(--color-fg-muted)]">
          {t(
            data.runs.length === 1 ? 'quality.runsAgainstSource_one' : 'quality.runsAgainstSource_other',
            { n: data.runs.length },
          )}
        </span>
      </h1>

      {data.runs.length === 0 ? (
        <div class="p-4 text-sm text-[color:var(--color-fg-muted)] border border-dashed border-[color:var(--color-border)] rounded">
          {t('quality.noRuns')}
        </div>
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-xs text-[color:var(--color-fg-muted)] uppercase tracking-wide text-left">
              <tr class="border-b border-[color:var(--color-border)]">
                <th class="py-2 pr-3">{t('quality.column.date')}</th>
                <th class="py-2 pr-3">{t('quality.column.model')}</th>
                <th class="py-2 pr-3 text-right">{t('quality.column.cost')}</th>
                <th class="py-2 pr-3 text-right">{t('quality.column.time')}</th>
                <th class="py-2 pr-3 text-right">{t('quality.column.neurons')}</th>
                <th class="py-2 pr-3 text-right">{t('quality.column.concepts')}</th>
                <th class="py-2 pr-3 text-right">{t('quality.column.entities')}</th>
                <th class="py-2 pr-3 text-right">{t('quality.column.links')}</th>
                <th class="py-2 pr-3 text-right">{t('quality.column.typed')}</th>
                <th class="py-2 pr-3 text-right">{t('quality.column.broken')}</th>
                <th class="py-2 pr-3">{t('quality.column.status')}</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <tr
                  key={run.jobId}
                  class="border-b border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-subtle)]"
                >
                  <td class="py-2 pr-3 font-mono text-xs">
                    {run.startedAt.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td class="py-2 pr-3">
                    <div class="font-mono text-xs">
                      {run.primaryModel ?? run.backend ?? '—'}
                    </div>
                    {run.modelTrailLen > 1 && run.finalModel !== run.primaryModel && run.finalModel ? (
                      <div class="text-xs text-[color:var(--color-fg-muted)]">
                        → {t('quality.fellBackTo', { model: run.finalModel })}
                      </div>
                    ) : null}
                  </td>
                  <td class="py-2 pr-3 text-right font-mono">
                    {run.backend === 'claude-cli' && run.costCents === 0
                      ? maxPlanLabel(locale)
                      : fmt(run.costCents)}
                  </td>
                  <td class="py-2 pr-3 text-right font-mono">{formatDuration(run.durationMs)}</td>
                  <td class="py-2 pr-3 text-right font-mono">{run.metrics.neuronsCreated}</td>
                  <td class="py-2 pr-3 text-right font-mono">{run.metrics.conceptsCreated}</td>
                  <td class="py-2 pr-3 text-right font-mono">{run.metrics.entitiesCreated}</td>
                  <td class="py-2 pr-3 text-right font-mono">{run.metrics.wikiBacklinks}</td>
                  <td class="py-2 pr-3 text-right font-mono">{run.metrics.typedEdges}</td>
                  <td class="py-2 pr-3 text-right font-mono">
                    <span
                      class={
                        run.metrics.openBrokenLinks === 0
                          ? 'text-[color:var(--color-fg-muted)]'
                          : 'text-orange-500'
                      }
                    >
                      {run.metrics.openBrokenLinks}
                    </span>
                  </td>
                  <td class="py-2 pr-3">
                    <span
                      class={
                        'inline-flex items-center px-2 py-0.5 rounded text-xs font-mono ' +
                        (run.status === 'done'
                          ? 'bg-green-500/10 text-green-600'
                          : run.status === 'failed'
                            ? 'bg-red-500/10 text-red-600'
                            : 'bg-[color:var(--color-border)] text-[color:var(--color-fg-muted)]')
                      }
                    >
                      {run.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div class="text-xs text-[color:var(--color-fg-muted)] italic">
        {t('quality.footer', { kb: kb?.name ?? kbId, filename: data.source.filename })}
      </div>
    </div>
  );
}
