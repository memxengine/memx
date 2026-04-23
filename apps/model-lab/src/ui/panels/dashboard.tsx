import { useEffect, useState } from 'preact/hooks';
import { api, type Run, formatDuration, formatCost, modelLabel, statusColor } from '../lib';

export function DashboardPanel() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ runs: Run[] }>('/api/v1/runs').then((data) => {
      setRuns(data.runs);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!runs.some((r) => r.status === 'running')) return;
    const interval = setInterval(() => {
      api<{ runs: Run[] }>('/api/v1/runs').then((data) => setRuns(data.runs));
    }, 3000);
    return () => clearInterval(interval);
  }, [runs]);

  if (loading) {
    return <div class="text-[color:var(--color-fg-muted)] py-12 text-center">Loading...</div>;
  }

  if (runs.length === 0) {
    return (
      <div class="text-center py-20">
        <p class="text-[color:var(--color-fg-muted)] text-lg mb-4">No runs yet</p>
        <a href="/runs/new" class="inline-block px-4 py-2 bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] rounded-md no-underline text-sm hover:opacity-90 active:scale-95 transition">
          Start First Run
        </a>
      </div>
    );
  }

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-semibold m-0">Experiment Runs</h1>
        <a href="/runs/new" class="px-3 py-1.5 bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] rounded-md no-underline text-sm hover:opacity-90 active:scale-95 transition">
          + New Run
        </a>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[color:var(--color-border)]">
              <th class="text-left py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Model</th>
              <th class="text-left py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Source</th>
              <th class="text-left py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Status</th>
              <th class="text-right py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Turns</th>
              <th class="text-right py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Duration</th>
              <th class="text-right py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Cost</th>
              <th class="text-right py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Tokens</th>
              <th class="text-left py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr class="border-b border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-hover)] transition cursor-pointer" onClick={() => window.location.href = `/runs/${run.id}`}>
                <td class="py-3 px-3 font-medium">{modelLabel(run.model)}</td>
                <td class="py-3 px-3 text-[color:var(--color-fg-muted)]">{run.source_file}</td>
                <td class="py-3 px-3">
                  <span style={statusColor(run.status)} class="font-medium capitalize">{run.status}</span>
                  {run.status === 'running' && <span class="inline-block w-1.5 h-1.5 rounded-full bg-[color:var(--color-warning)] ml-1.5 animate-pulse" />}
                </td>
                <td class="py-3 px-3 text-right font-mono text-[color:var(--color-fg-muted)]">{run.total_turns || '—'}</td>
                <td class="py-3 px-3 text-right font-mono text-[color:var(--color-fg-muted)]">{run.duration_ms ? formatDuration(run.duration_ms) : '—'}</td>
                <td class="py-3 px-3 text-right font-mono">{run.total_cost_usd ? formatCost(run.total_cost_usd) : '—'}</td>
                <td class="py-3 px-3 text-right font-mono text-[color:var(--color-fg-muted)]">
                  {run.total_tokens_in + run.total_tokens_out > 0
                    ? `${((run.total_tokens_in + run.total_tokens_out) / 1000).toFixed(1)}K`
                    : '—'}
                </td>
                <td class="py-3 px-3 text-[color:var(--color-fg-muted)] text-xs">
                  {new Date(run.started_at).toLocaleString('da-DK', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
