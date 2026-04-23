import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { api, type Run, type TurnLog, type QualityScore, formatDuration, formatCost, modelLabel, statusColor, scoreColor } from '../lib';

export function RunDetailPanel() {
  const { params } = useRoute();
  const runId = params.id;
  const [run, setRun] = useState<Run | null>(null);
  const [turns, setTurns] = useState<TurnLog[]>([]);
  const [scores, setScores] = useState<QualityScore[]>([]);
  const [activeTab, setActiveTab] = useState<'overview' | 'turns' | 'output' | 'scores'>('overview');

  useEffect(() => {
    if (!runId) return;
    api<{ run: Run }>(`/api/v1/runs/${runId}`).then((data) => setRun(data.run));
    api<{ turns: TurnLog[] }>(`/api/v1/runs/${runId}/turns`).then((data) => setTurns(data.turns));
    api<{ scores: QualityScore[] }>(`/api/v1/runs/${runId}/scores`).then((data) => setScores(data.scores));
  }, [runId]);

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const interval = setInterval(() => {
      api<{ run: Run }>(`/api/v1/runs/${runId}`).then((data) => setRun(data.run));
      api<{ turns: TurnLog[] }>(`/api/v1/runs/${runId}/turns`).then((data) => setTurns(data.turns));
    }, 3000);
    return () => clearInterval(interval);
  }, [run?.status]);

  if (!run) {
    return <div class="text-[color:var(--color-fg-muted)] py-12 text-center">Loading...</div>;
  }

  const kbOutput: Record<string, string> = run.kb_output ? JSON.parse(run.kb_output) : {};

  return (
    <div>
      <div class="flex items-center gap-3 mb-6">
        <a href="/" class="text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] transition no-underline">&larr; Back</a>
        <h1 class="text-xl font-semibold m-0">{modelLabel(run.model)}</h1>
        <span style={statusColor(run.status)} class="font-medium capitalize text-sm">{run.status}</span>
        {run.status === 'running' && <span class="inline-block w-2 h-2 rounded-full bg-[color:var(--color-warning)] animate-pulse" />}
      </div>

      <div class="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Duration" value={run.duration_ms ? formatDuration(run.duration_ms) : '—'} />
        <StatCard label="Cost" value={run.total_cost_usd ? formatCost(run.total_cost_usd) : '—'} />
        <StatCard label="Turns" value={String(run.total_turns || '—')} />
        <StatCard label="Tokens" value={run.total_tokens_in + run.total_tokens_out > 0 ? `${((run.total_tokens_in + run.total_tokens_out) / 1000).toFixed(1)}K` : '—'} />
      </div>

      {run.error && (
        <div class="p-3 rounded-md bg-red-900/20 border border-red-800 text-red-300 text-sm mb-6">{run.error}</div>
      )}

      <div class="flex gap-1 border-b border-[color:var(--color-border)] mb-4">
        {(['overview', 'turns', 'output', 'scores'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            class={`px-4 py-2 text-sm font-medium border-b-2 transition cursor-pointer bg-transparent border-x-0 border-t-0 ${activeTab === tab ? 'border-[color:var(--color-accent)] text-[color:var(--color-accent)]' : 'border-transparent text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'}`}
          >
            {tab === 'overview' ? 'Overview' : tab === 'turns' ? `Turns (${turns.length})` : tab === 'output' ? `Output (${Object.keys(kbOutput).length} files)` : `Scores (${scores.length})`}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <div class="p-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]">
              <div class="text-xs text-[color:var(--color-fg-muted)] mb-1">Model</div>
              <div class="font-mono text-sm">{run.model}</div>
            </div>
            <div class="p-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]">
              <div class="text-xs text-[color:var(--color-fg-muted)] mb-1">Source</div>
              <div class="font-mono text-sm">{run.source_file} ({(run.source_size_bytes / 1024).toFixed(1)} KB)</div>
            </div>
            <div class="p-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]">
              <div class="text-xs text-[color:var(--color-fg-muted)] mb-1">Input Tokens</div>
              <div class="font-mono text-sm">{run.total_tokens_in.toLocaleString()}</div>
            </div>
            <div class="p-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]">
              <div class="text-xs text-[color:var(--color-fg-muted)] mb-1">Output Tokens</div>
              <div class="font-mono text-sm">{run.total_tokens_out.toLocaleString()}</div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'turns' && (
        <div class="space-y-2">
          {turns.map((turn) => (
            <div key={turn.id} class="p-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]">
              <div class="flex items-center gap-2 mb-2">
                <span class={`text-xs font-mono px-2 py-0.5 rounded ${turn.role === 'assistant' ? 'bg-blue-900/30 text-blue-300' : 'bg-green-900/30 text-green-300'}`}>
                  {turn.role}
                </span>
                <span class="text-xs text-[color:var(--color-fg-subtle)]">Turn {turn.turn_number}</span>
                {turn.tokens_in > 0 && <span class="text-xs text-[color:var(--color-fg-subtle)] font-mono">{turn.tokens_in}in / {turn.tokens_out}out · {formatDuration(turn.latency_ms)}</span>}
                {turn.cost_usd > 0 && <span class="text-xs text-[color:var(--color-fg-subtle)] font-mono">{formatCost(turn.cost_usd)}</span>}
              </div>
              {turn.tool_calls && (
                <div class="text-xs font-mono text-[color:var(--color-accent)] mb-1">
                  {JSON.stringify(JSON.parse(turn.tool_calls).map((tc: any) => `${tc.function.name}(${tc.function.arguments.slice(0, 80)}...)`))}
                </div>
              )}
              {turn.content && (
                <pre class="text-xs text-[color:var(--color-fg-muted)] whitespace-pre-wrap m-0 max-h-32 overflow-y-auto">{turn.content.slice(0, 500)}</pre>
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === 'output' && (
        <div class="space-y-3">
          {Object.entries(kbOutput).map(([path, content]) => (
            <div key={path} class="border border-[color:var(--color-border)] rounded-md bg-[color:var(--color-bg-card)]">
              <div class="px-4 py-2 border-b border-[color:var(--color-border)] text-xs font-mono text-[color:var(--color-accent)]">{path}</div>
              <pre class="p-4 text-xs text-[color:var(--color-fg-muted)] whitespace-pre-wrap m-0 max-h-64 overflow-y-auto">{content}</pre>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'scores' && (
        <div class="space-y-3">
          {scores.map((score) => (
            <div key={score.id} class="p-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]">
              <div class="flex items-center justify-between mb-2">
                <span class="font-medium text-sm">{score.scorer}</span>
                <span class="font-mono text-sm" style={`color: ${scoreColor(score.score)}`}>{(score.score * 100).toFixed(0)}%</span>
              </div>
              <div class="score-bar">
                <div class="score-bar-fill" style={`width: ${score.score * 100}%; background: ${scoreColor(score.score)}`} />
              </div>
              {score.details && <p class="text-xs text-[color:var(--color-fg-subtle)] mt-2 m-0">{score.details}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div class="p-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]">
      <div class="text-xs text-[color:var(--color-fg-muted)] mb-1">{label}</div>
      <div class="font-mono text-lg font-medium">{value}</div>
    </div>
  );
}
