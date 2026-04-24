import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { useKb } from '../lib/kb-cache';
import { getQualityRuns, ApiError, type QualityComparison } from '../api';
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

function formatCents(cents: number): string {
  if (cents === 0) return '—';
  if (cents < 100) return `${cents}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

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
  const [data, setData] = useState<QualityComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading || !data) return <CenteredLoader />;
  if (error) return <div class="p-4 text-red-500">Error: {error}</div>;

  return (
    <div class="p-4 space-y-4">
      <div class="flex items-baseline gap-3 text-sm text-[color:var(--color-fg-muted)]">
        <a href={`/kb/${kbId}/cost`} class="hover:text-[color:var(--color-fg)]">
          ← Cost
        </a>
        <span>/</span>
        <span class="text-[color:var(--color-fg)] font-medium">
          {data.source.title ?? data.source.filename}
        </span>
      </div>

      <h1 class="text-xl font-semibold">
        Ingest-sammenligning
        <span class="ml-2 text-sm font-normal text-[color:var(--color-fg-muted)]">
          ({data.runs.length} {data.runs.length === 1 ? 'run' : 'runs'} mod denne kilde)
        </span>
      </h1>

      {data.runs.length === 0 ? (
        <div class="p-4 text-sm text-[color:var(--color-fg-muted)] border border-dashed border-[color:var(--color-border)] rounded">
          Ingen ingest-runs endnu. Kilden er enten uploadet men ikke behandlet,
          eller behandlet før F149's cost-tracking blev aktiveret.
        </div>
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-xs text-[color:var(--color-fg-muted)] uppercase tracking-wide text-left">
              <tr class="border-b border-[color:var(--color-border)]">
                <th class="py-2 pr-3">Dato</th>
                <th class="py-2 pr-3">Model</th>
                <th class="py-2 pr-3 text-right">Cost</th>
                <th class="py-2 pr-3 text-right">Tid</th>
                <th class="py-2 pr-3 text-right">Neuroner</th>
                <th class="py-2 pr-3 text-right">Konc.</th>
                <th class="py-2 pr-3 text-right">Ent.</th>
                <th class="py-2 pr-3 text-right">Links</th>
                <th class="py-2 pr-3 text-right">Typed</th>
                <th class="py-2 pr-3 text-right">Broken</th>
                <th class="py-2 pr-3">Status</th>
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
                    {run.modelTrailLen > 1 && run.finalModel !== run.primaryModel ? (
                      <div class="text-xs text-[color:var(--color-fg-muted)]">
                        → fell back to {run.finalModel}
                      </div>
                    ) : null}
                  </td>
                  <td class="py-2 pr-3 text-right font-mono">
                    {run.backend === 'claude-cli' && run.costCents === 0
                      ? 'gratis (Max)'
                      : formatCents(run.costCents)}
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
        KB: {kb?.name ?? kbId} · Source: <span class="font-mono">{data.source.filename}</span>
      </div>
    </div>
  );
}
