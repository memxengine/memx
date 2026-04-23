import { useEffect, useState } from 'preact/hooks';
import { api, type Run, type QualityScore, formatDuration, formatCost, modelLabel, scoreColor } from '../lib';

export function ComparePanel() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [scoresMap, setScoresMap] = useState<Record<string, QualityScore[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ runs: Run[] }>('/api/v1/runs?limit=50').then(async (data) => {
      const doneRuns = data.runs.filter((r) => r.status === 'done');
      setRuns(doneRuns);
      const scoreEntries = await Promise.all(
        doneRuns.map(async (run) => {
          const data = await api<{ scores: QualityScore[] }>(`/api/v1/runs/${run.id}/scores`);
          return [run.id, data.scores] as const;
        })
      );
      setScoresMap(Object.fromEntries(scoreEntries));
      setLoading(false);
    });
  }, []);

  if (loading) {
    return <div class="text-[color:var(--color-fg-muted)] py-12 text-center">Loading...</div>;
  }

  const doneRuns = runs.filter((r) => r.status === 'done');
  if (doneRuns.length === 0) {
    return <div class="text-[color:var(--color-fg-muted)] py-12 text-center">No completed runs to compare</div>;
  }

  const groupedBySource = new Map<string, Run[]>();
  for (const run of doneRuns) {
    const group = groupedBySource.get(run.source_file) ?? [];
    group.push(run);
    groupedBySource.set(run.source_file, group);
  }

  const allScorers = new Set<string>();
  for (const scores of Object.values(scoresMap)) {
    for (const s of scores) allScorers.add(s.scorer);
  }
  const scorerList = [...allScorers].sort();

  return (
    <div>
      <h1 class="text-xl font-semibold mb-6">Model Comparison</h1>

      {[...groupedBySource.entries()].map(([source, sourceRuns]) => (
        <div key={source} class="mb-8">
          <h2 class="text-lg font-medium mb-4">{source}</h2>

          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[color:var(--color-border)]">
                  <th class="text-left py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Model</th>
                  <th class="text-right py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Duration</th>
                  <th class="text-right py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Cost</th>
                  <th class="text-right py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Turns</th>
                  <th class="text-right py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Tokens</th>
                  {scorerList.map((scorer) => (
                    <th key={scorer} class="text-center py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">{scorer}</th>
                  ))}
                  <th class="text-center py-3 px-3 text-[color:var(--color-fg-muted)] font-medium">Avg</th>
                </tr>
              </thead>
              <tbody>
                {sourceRuns.map((run) => {
                  const scores = scoresMap[run.id] ?? [];
                  const avg = scores.length > 0 ? scores.reduce((sum, s) => sum + s.score, 0) / scores.length : 0;
                  return (
                    <tr key={run.id} class="border-b border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-hover)] cursor-pointer transition" onClick={() => window.location.href = `/runs/${run.id}`}>
                      <td class="py-3 px-3 font-medium">{modelLabel(run.model)}</td>
                      <td class="py-3 px-3 text-right font-mono text-[color:var(--color-fg-muted)]">{formatDuration(run.duration_ms)}</td>
                      <td class="py-3 px-3 text-right font-mono">{formatCost(run.total_cost_usd)}</td>
                      <td class="py-3 px-3 text-right font-mono text-[color:var(--color-fg-muted)]">{run.total_turns}</td>
                      <td class="py-3 px-3 text-right font-mono text-[color:var(--color-fg-muted)]">{((run.total_tokens_in + run.total_tokens_out) / 1000).toFixed(1)}K</td>
                      {scorerList.map((scorer) => {
                        const s = scores.find((sc) => sc.scorer === scorer);
                        return (
                          <td key={scorer} class="py-3 px-3 text-center">
                            {s ? (
                              <span class="font-mono text-xs" style={`color: ${scoreColor(s.score)}`}>
                                {(s.score * 100).toFixed(0)}%
                              </span>
                            ) : '—'}
                          </td>
                        );
                      })}
                      <td class="py-3 px-3 text-center">
                        <span class="font-mono text-sm font-medium" style={`color: ${scoreColor(avg)}`}>
                          {(avg * 100).toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
